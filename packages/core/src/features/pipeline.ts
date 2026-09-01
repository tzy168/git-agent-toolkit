import { z } from 'zod';

import { composePrompt } from '../prompt/layout.js';
import { mapWithConcurrency } from '../util/async.js';
import { GitAgentError } from '../errors.js';
import { withRetry } from '../llm/retry.js';
import { estimateTokens, withinBudget } from '../llm/budget.js';
import type { LLMResponse } from '../llm/types.js';
import type { CollectedData, UsageTotals } from '../types.js';
import type { Feature, FeatureContext, MapStep, PromptStep, SingleStep, StepResults } from './registry.js';

export interface PipelineResult<O> {
  output: O;
  results: StepResults;
  usage: UsageTotals;
}

/** 按序执行 steps：map 并发 → 脱敏 → LLM → zod 校验（失败带错误重试 1 次）→ reduce */
export async function runPipeline<O>(
  feature: Feature<unknown, O>,
  data: CollectedData,
  ctx: FeatureContext,
): Promise<PipelineResult<O>> {
  const started = Date.now();
  const usage: UsageTotals = { calls: 0, promptTokens: 0, completionTokens: 0, cachedPromptTokens: 0, elapsedMs: 0 };
  const steps = feature.buildSteps(data, ctx);
  const results: StepResults = {};

  for (const step of steps) {
    if (step.runIf && !step.runIf(results, data)) continue;
    ctx.onProgress({ phase: 'llm', message: step.label ?? step.id });
    if (step.kind === 'map') {
      results[step.id] = await runMap(step, results, data, ctx, feature.id, usage);
    } else {
      results[step.id] = await runSingle(step, results, data, ctx, feature.id, usage);
    }
  }

  usage.elapsedMs = Date.now() - started;
  const lastId = [...steps].reverse().find((s) => s.id in results)?.id;
  const output = feature.reduce
    ? feature.reduce(results, data, ctx)
    : (results[lastId ?? ''] as O);
  const parsed = feature.outputSchema.safeParse(output);
  if (!parsed.success) {
    throw new GitAgentError('LLM_SCHEMA_INVALID', `功能 ${feature.id} 最终输出不符合 schema`, '重试或加 -v 查看原始输出', parsed.error.issues);
  }
  return { output: parsed.data, results, usage };
}

async function runSingle(
  step: SingleStep<unknown>,
  results: StepResults,
  data: CollectedData,
  ctx: FeatureContext,
  featureId: string,
  usage: UsageTotals,
): Promise<unknown> {
  const user = ctx.redactor.redact(step.buildUser(results, data, ctx));
  return completeStep(step, user, ctx, featureId, usage);
}

async function runMap(
  step: MapStep<unknown>,
  results: StepResults,
  data: CollectedData,
  ctx: FeatureContext,
  featureId: string,
  usage: UsageTotals,
): Promise<unknown[]> {
  const items = step.mapOver(results, data);
  const conc = step.concurrency ?? ctx.config.llm.concurrency;
  return mapWithConcurrency(items, conc, async (item, index) => {
    const user = ctx.redactor.redact(step.buildUserItem(item, index, results, data, ctx));
    return completeStep(step, user, ctx, featureId, usage);
  });
}

async function completeStep(
  step: PromptStep,
  user: string,
  ctx: FeatureContext,
  featureId: string,
  usage: UsageTotals,
): Promise<unknown> {
  const schemaText = JSON.stringify(z.toJSONSchema(step.schema), null, 2);
  const composed = composePrompt({
    instructions: step.system,
    rules: '',
    schema: schemaText,
    variable: user,
  });

  const total = estimateTokens(composed.system) + estimateTokens(composed.user);
  const variable = withinBudget(total, ctx.config.llm.maxInputTokens)
    ? composed.user
    : `${composed.user}\n\n…（已超出总预算，请按摘要级处理）`;

  const parsed = await callAndParse(step, composed.system, variable, ctx, featureId, usage);
  if (parsed.ok) return parsed.data;

  const retryUser = `${variable}\n\n上次输出不符合 schema：${parsed.issues}，请修正后重新输出 JSON`;
  const again = await callAndParse(step, composed.system, retryUser, ctx, featureId, usage);
  if (again.ok) return again.data;
  throw new GitAgentError('LLM_SCHEMA_INVALID', `步骤 ${step.id} 输出两次均不符合 schema`, '加 -v 查看原始输出', again.issues);
}

async function callAndParse(
  step: PromptStep,
  system: string,
  user: string,
  ctx: FeatureContext,
  featureId: string,
  usage: UsageTotals,
): Promise<{ ok: true; data: unknown } | { ok: false; issues: string }> {
  let resp: LLMResponse;
  try {
    resp = await withRetry(
      () =>
        ctx.llm.complete({
          system,
          user,
          tier: step.model ?? 'fast',
          thinking: step.thinking,
          maxOutputTokens: step.maxOutputTokens,
          jsonSchema: z.toJSONSchema(step.schema),
          model: ctx.modelOverride,
          meta: { featureId, stepId: step.id },
        }),
      {
        retries: ctx.config.llm.maxRetries,
        onRetry: (e, attempt, delayMs) => {
          ctx.logger.warn(`LLM 重试 ${attempt + 1}，${delayMs}ms 后（${e instanceof Error ? e.message : String(e)}）`);
        },
      },
    );
  } catch (e) {
    throw new GitAgentError('LLM_FAILED', `步骤 ${step.id} 调用模型失败`, '检查网络与 DEEPSEEK_API_KEY', e);
  }

  usage.calls++;
  usage.promptTokens += resp.usage.promptTokens;
  usage.completionTokens += resp.usage.completionTokens;
  usage.cachedPromptTokens += resp.usage.cachedTokens ?? 0;

  let json: unknown;
  try {
    json = parseJson(resp.text);
  } catch (e) {
    return { ok: false, issues: `JSON 解析失败：${e instanceof Error ? e.message : String(e)}` };
  }
  const checked = step.schema.safeParse(json);
  if (!checked.success) {
    return { ok: false, issues: checked.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  }
  return { ok: true, data: checked.data };
}

/** 生成每步 {system,user}，供 --dry-run 打印，不调 LLM */
export function previewPrompts(
  feature: Feature<any, unknown>,
  data: CollectedData,
  ctx: FeatureContext,
): { id: string; system: string; user: string }[] {
  const out: { id: string; system: string; user: string }[] = [];
  const results: StepResults = {};
  for (const step of feature.buildSteps(data, ctx)) {
    if (step.kind !== 'single') continue;
    const user = ctx.redactor.redact(step.buildUser(results, data, ctx));
    const composed = composePrompt({
      instructions: step.system,
      rules: '',
      schema: JSON.stringify(z.toJSONSchema(step.schema), null, 2),
      variable: user,
    });
    out.push({ id: step.id, system: composed.system, user: composed.user });
  }
  return out;
}

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (fence?.[1] ?? trimmed).trim();
  return JSON.parse(raw);
}
