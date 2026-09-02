import OpenAI from 'openai';

import type { ResolvedConfig } from '../config/types.js';
import { GitAgentError } from '../errors.js';
import type { Logger } from '../types.js';
import { isRetryableError } from './retry.js';
import type { LLMProvider, LLMRequest, LLMResponse, ThinkingMode } from './types.js';

const BASE_URL = 'https://api.deepseek.com';

function thinkingBody(mode: ThinkingMode): { thinking: { type: 'enabled' | 'disabled' }; reasoning_effort?: 'high' | 'max' } {
  if (mode === 'off') return { thinking: { type: 'disabled' } };
  return { thinking: { type: 'enabled' }, reasoning_effort: mode };
}

function defaultThinking(cfg: ResolvedConfig): ThinkingMode {
  if (cfg.llm.reasoningEffort === 'non-think') return 'off';
  return cfg.llm.reasoningEffort;
}

/** DeepSeek Chat Completions 适配器；无 Key 时 create 成功、complete 才抛 NO_API_KEY */
export function createDeepSeekProvider(cfg: ResolvedConfig, logger?: Logger): LLMProvider {
  let client: OpenAI | null = null;
  let lastModel = cfg.llm.model.fast;

  const provider: LLMProvider = {
    get modelId() {
      return lastModel;
    },
    async complete(req: LLMRequest): Promise<LLMResponse> {
      const key = process.env.DEEPSEEK_API_KEY?.trim();
      if (!key) {
        throw new GitAgentError(
          'NO_API_KEY',
          '未检测到 DEEPSEEK_API_KEY',
          '交互终端下会提示输入；也可写入 ~/.git-agent/.env 或仓库 .env',
        );
      }
      client ??= new OpenAI({ apiKey: key, baseURL: BASE_URL, timeout: cfg.llm.timeoutMs });

      const model = req.model ?? (req.tier === 'strong' ? cfg.llm.model.strong : cfg.llm.model.fast);
      lastModel = model;
      const mode = req.thinking ?? defaultThinking(cfg);
      const extra = thinkingBody(mode);
      logger?.debug(`LLM ${req.meta?.featureId ?? '-'}/${req.meta?.stepId ?? '-'} model=${model} thinking=${mode}`);

      try {
        const resp = await client.chat.completions.create({
          model,
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
          ],
          response_format: { type: 'json_object' },
          max_tokens: req.maxOutputTokens,
          ...extra,
        } as Parameters<OpenAI['chat']['completions']['create']>[0]);

        const choice = 'choices' in resp ? resp.choices[0] : undefined;
        const text = choice && 'message' in choice ? (choice.message.content ?? '') : '';
        const usage = 'usage' in resp ? resp.usage : undefined;
        return {
          text,
          model,
          usage: {
            promptTokens: usage?.prompt_tokens ?? 0,
            completionTokens: usage?.completion_tokens ?? 0,
            totalTokens: usage?.total_tokens ?? 0,
            cachedTokens: (usage as { prompt_tokens_details?: { cached_tokens?: number } } | undefined)?.prompt_tokens_details?.cached_tokens ?? 0,
          },
        };
      } catch (e) {
        if (isRetryableError(e)) throw e;
        const err = e as { message?: string };
        throw new GitAgentError('LLM_FAILED', `DeepSeek 调用失败：${err.message ?? String(e)}`, '检查 Key、额度与网络', e);
      }
    },
  };

  return provider;
}
