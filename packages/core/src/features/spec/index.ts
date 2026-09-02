import { buildOutline } from '../../diff/splitter.js';
import { applyVars, loadPrompt, loadShared } from '../../prompt/loader.js';
import { mdHeading, mdList, mdTable } from '../../render/markdown.js';
import type { Feature, PromptStep, StepResults } from '../registry.js';
import { blockCommits, blockStats } from '../shared/prompt-blocks.js';
import { collectBranchDiff } from '../shared/collect-branch.js';
import { chunkMapStep, summaryStep } from '../shared/steps.js';
import { ChunkNotesSchema, SpecOutputSchema, SpecOutlineSchema, type SpecOutput } from './schema.js';

export interface SpecInput {
  base?: string;
  head?: string;
}

let systemTpl = '';
let draftTpl = '';
let sharedRules = '';

async function loadTemplates(): Promise<void> {
  if (systemTpl) return;
  systemTpl = await loadPrompt('spec/system');
  draftTpl = await loadPrompt('spec/draft');
  sharedRules = await loadShared('anti-hallucination', 'output-format');
}

/** 决策痕迹类别 → 识别正则（本地提取，供模型核对，不替代模型判断） */
const TRACE_RULES: [string, RegExp][] = [
  ['TODO/FIXME', /\b(?:TODO|FIXME|HACK|XXX)\b/],
  ['feature flag', /\b(?:flag|isEnabled|FEATURE_[A-Z_]+)\b/],
  ['兼容分支', /\b(?:deprecated|legacy|fallback|兼容|旧版|backward)\b/i],
  ['异常兜底', /\bcatch\b|\bfinally\b/],
  ['性能优化', /\b(?:cache|memo\w*|debounce|throttle|perf\w*|优化)\b/i],
  ['数据结构选型', /new (?:Map|Set|WeakMap)\b|\bRecord<|\bMap</],
];

/** 从 diff 文本里抓「决策痕迹」行：类别 + 出处行 */
export function extractDecisionTraces(diffText: string, cap = 60): string[] {
  const out: string[] = [];
  let file = '';
  for (const raw of diffText.split(/\r?\n/)) {
    if (raw.startsWith('+++ ') || raw.startsWith('--- ')) {
      const m = raw.match(/^[+-]{3} [ab]\/(.+)$/);
      if (m?.[1]) file = m[1];
      continue;
    }
    if (!raw.startsWith('+') && !raw.startsWith('-')) continue;
    const body = raw.slice(1);
    for (const [label, re] of TRACE_RULES) {
      if (!re.test(body)) continue;
      out.push(`[${label}] ${file}: ${body.trim()}`);
      break; // 一行只归一类
    }
    if (out.length >= cap) break;
  }
  return out;
}

export const specFeature: Feature<SpecInput, SpecOutput> = {
  id: 'spec',
  name: '技术方案',
  description: '从分支 diff 反推技术方案文档（八章结构 + 决策权衡表）',
  params: [],
  outputSchema: SpecOutputSchema,

  async collect(ctx, input) {
    await loadTemplates();
    const data = await collectBranchDiff(ctx, { base: input?.base, head: input?.head });
    return {
      ...data,
      extra: { ...data.extra, traces: extractDecisionTraces(data.diffText) },
    };
  },

  buildSteps(data, ctx): PromptStep[] {
    const lang = ctx.config.output.language;
    const system = `${applyVars(systemTpl, { language: lang })}\n\n${sharedRules}`;

    return [
      {
        kind: 'single',
        id: 'outline',
        label: '挑重点文件与需求',
        system,
        schema: SpecOutlineSchema,
        model: 'strong',
        thinking: 'high',
        buildUser() {
          return `先挑重点文件与需求点，后续只对重点文件深挖。\n\n${buildOutline(data.files)}`;
        },
      },

      chunkMapStep({
        id: 'draft',
        label: '分片提炼',
        system,
        schema: ChunkNotesSchema,
        model: 'strong',
        thinking: 'high',
        selectChunks(results, d) {
          const focus = (results.outline as { focusFiles?: string[] } | undefined)?.focusFiles;
          if (!focus?.length) return d.chunks;
          const wanted = new Set(focus);
          return d.chunks.filter((c) => c.paths.some((p) => wanted.has(p)));
        },
        buildUser(chunk) {
          return applyVars(draftTpl, { module: chunk.module, diff: chunk.text });
        },
      }),

      summaryStep({
        id: 'final',
        label: '组装八章',
        system,
        schema: SpecOutputSchema,
        model: 'strong',
        thinking: 'high',
        buildUser(results, d) {
          const outline = results.outline as { requirements?: string[] } | undefined;
          const traces = (d.extra.traces as string[]) ?? [];
          return [
            '统计（来自 git 事实，不要自己加减）：',
            blockStats(d),
            '',
            '提交记录：',
            blockCommits(d),
            '',
            `outline 需求点：${JSON.stringify(outline?.requirements ?? [])}`,
            '',
            '本地提取的决策痕迹（供核对，可能有噪音）：',
            traces.length > 0 ? traces.join('\n') : '（无）',
            '',
            '各重点分片提炼结果：',
            JSON.stringify(results.draft ?? [], null, 1),
            '',
            '按八章结构输出技术方案。',
          ].join('\n');
        },
      }),
    ];
  },

  reduce(results: StepResults): SpecOutput {
    return results.final as SpecOutput;
  },

  summaryLine(output) {
    return `✓ 技术方案完成：${output.decisions.length} 条决策 / ${output.acceptance.length} 条验收要点`;
  },

  render(output, _ctx, data) {
    const lines: string[] = [
      mdHeading(1, '技术方案'),
      '',
      mdHeading(2, '背景与目标'),
      '',
      output.background,
      '',
      mdHeading(2, '需求拆解'),
      '',
      output.requirements.length > 0 ? mdList(output.requirements) : '（无）',
      '',
      mdHeading(2, '整体设计'),
      '',
      output.design,
      '',
      mdHeading(2, '关键实现'),
      '',
      output.implementation.length > 0 ? mdList(output.implementation) : '（无）',
      '',
      mdHeading(2, '关键决策与权衡'),
      '',
      output.decisions.length > 0
        ? mdTable(
            ['决策', '理由', '不这么选的后果', '出处'],
            output.decisions.map((d) => [d.decision, d.rationale, d.alternative, d.evidence]),
          )
        : '（无）',
      '',
      mdHeading(2, '影响范围'),
      '',
      output.impactScope.length > 0 ? mdList(output.impactScope) : '（无）',
      '',
      mdHeading(2, '风险与 TODO'),
      '',
      output.risks.length > 0 ? mdList(output.risks) : '（无）',
      '',
      mdHeading(2, '验收要点'),
      '',
      output.acceptance.length > 0 ? mdList(output.acceptance) : '（无）',
      '',
      `> 统计（来自 git 事实）：${data.stats.files} 个文件，+${data.stats.additions} -${data.stats.deletions}，${data.commits.length} commits`,
    ];
    if (output.notes.trim() !== '') lines.push('', `> ${output.notes.trim()}`);
    return lines.join('\n').replace(/\n{3,}/g, '\n\n');
  },
};
