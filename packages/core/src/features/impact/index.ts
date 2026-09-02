import { extractChangedSymbols, reverseSearch } from '../../diff/reverse-search.js';
import { applyVars, loadPrompt, loadShared } from '../../prompt/loader.js';
import { mdHeading, mdList, mdTable } from '../../render/markdown.js';
import type { Feature, PromptStep, StepResults } from '../registry.js';
import { blockCommits, blockStats } from '../shared/prompt-blocks.js';
import { collectBranchDiff } from '../shared/collect-branch.js';
import { summaryStep } from '../shared/steps.js';
import { ImpactOutputSchema, type ImpactOutput } from './schema.js';

export interface ImpactInput {
  base?: string;
  head?: string;
}

let systemTpl = '';
let draftTpl = '';
let sharedRules = '';

async function loadTemplates(): Promise<void> {
  if (systemTpl) return;
  systemTpl = await loadPrompt('impact/system');
  draftTpl = await loadPrompt('impact/draft');
  sharedRules = await loadShared('anti-hallucination', 'output-format');
}

export const impactFeature: Feature<ImpactInput, ImpactOutput> = {
  id: 'impact',
  name: '影响面分析',
  description: '提取被改符号并反向搜索引用（本地完成），由模型判定各引用点是否需联动修改',
  params: [],
  outputSchema: ImpactOutputSchema,

  async collect(ctx, input) {
    await loadTemplates();
    const data = await collectBranchDiff(ctx, { base: input?.base, head: input?.head });

    // 符号提取与引用搜索全部本地完成，不调 LLM
    const symbols = extractChangedSymbols(data.files);
    const result = await reverseSearch(ctx.git, symbols, {
      maxDepth: ctx.config.impact.maxDepth,
      includeTests: ctx.config.impact.includeTests,
      mode: ctx.config.impact.symbolParser,
    });
    if (result.mode === 'grep' && ctx.config.impact.symbolParser === 'ts-morph') {
      data.degraded.push('ts-morph 不可用，反向符号搜索退化为 grep 模式');
    }

    return {
      ...data,
      extra: {
        ...data.extra,
        reverse: {
          symbols: result.symbols,
          direct: result.direct,
          indirect: result.indirect,
          mode: result.mode,
          truncated: result.truncated,
        },
      },
    };
  },

  buildSteps(_data, ctx): PromptStep[] {
    const lang = ctx.config.output.language;
    const system = `${applyVars(systemTpl, { language: lang })}\n\n${sharedRules}`;

    return [
      summaryStep({
        id: 'judge',
        label: '判定影响面',
        system,
        schema: ImpactOutputSchema,
        model: 'strong',
        thinking: 'high',
        buildUser(_results, d) {
          const rv = d.extra.reverse as {
            symbols: { path: string; name: string; kind: string; change: string; signature?: string; hunkLine?: number }[];
            direct: { path: string; line: number; text: string; symbol: string }[];
            indirect: { path: string; line: number; text: string; symbol: string; via: string }[];
            mode: string;
            truncated: boolean;
          };
          return applyVars(draftTpl, {
            stats: blockStats(d),
            commits: blockCommits(d),
            symbols: JSON.stringify(rv.symbols, null, 1),
            direct: JSON.stringify(rv.direct, null, 1),
            indirect: JSON.stringify(rv.indirect, null, 1),
            mode: rv.mode,
            truncated: rv.truncated ? '（命中数达上限，结果可能不完整）' : '',
          });
        },
      }),
    ];
  },

  reduce(results: StepResults): ImpactOutput {
    return results.judge as ImpactOutput;
  },

  summaryLine(output) {
    const n = (s: string) => output.impacts.filter((i) => i.needsChange === s).length;
    return `✓ 影响面完成：${n('yes')} 需联动 / ${n('unknown')} 待确认 / ${n('no')} 无需改`;
  },

  render(output, _ctx, data) {
    const rv = data.extra.reverse as { mode: string; truncated: boolean } | undefined;
    const yes = output.impacts.filter((i) => i.needsChange === 'yes');
    const unknown = output.impacts.filter((i) => i.needsChange === 'unknown');
    const no = output.impacts.filter((i) => i.needsChange === 'no');

    const lines: string[] = [
      mdHeading(1, '影响面分析'),
      '',
      output.overview,
      '',
      `> 统计（来自 git 事实）：${data.stats.files} 个文件，+${data.stats.additions} -${data.stats.deletions}，${data.commits.length} commits`,
      `> 反向搜索模式：${rv?.mode ?? 'grep'}${rv?.truncated ? '（命中数达上限，结果被截断）' : ''}`,
      data.degraded.length > 0 ? `> 说明：${data.degraded.join('；')}` : '',
      '',
      mdHeading(2, '需联动修改'),
      yes.length > 0 ? mdTable(['位置', '符号', '理由'], yes.map((i) => [i.location, i.symbol, i.reason])) : '（无）',
      '',
      mdHeading(2, '待确认'),
      unknown.length > 0
        ? mdTable(['位置', '符号', '原因'], unknown.map((i) => [i.location, i.symbol, i.reason]))
        : '（无）',
      '',
      mdHeading(2, '无需修改（核对过）'),
      no.length > 0 ? mdList(no.map((i) => `${i.location}（${i.reason}）`)) : '（无）',
      '',
    ];
    if (output.regressionPaths.length > 0) {
      lines.push(mdHeading(2, '建议回归路径'), '', mdList(output.regressionPaths), '');
    }
    if (output.confirmations.length > 0) {
      lines.push(mdHeading(2, '人工确认清单'), '', mdList(output.confirmations), '');
    }
    if (output.notes.trim() !== '') {
      lines.push(mdHeading(2, '说明'), '', output.notes.trim(), '');
    }
    return lines.join('\n').replace(/\n{3,}/g, '\n\n');
  },
};
