import { applyVars, loadPrompt, loadShared } from '../../prompt/loader.js';
import { mdHeading } from '../../render/markdown.js';
import type { Feature, FeatureContext, PromptStep, StepResults } from '../registry.js';
import { blockCommits, blockStats } from '../shared/prompt-blocks.js';
import { collectBranchDiff } from '../shared/collect-branch.js';
import { summaryStep } from '../shared/steps.js';
import { resolvePrTemplate } from './template.js';
import { PrDescOutputSchema, type PrDescOutput } from './schema.js';

export interface PrDescInput {
  base?: string;
  head?: string;
  withReview?: boolean;
}

let systemTpl = '';
let draftTpl = '';
let sharedRules = '';

async function loadTemplates(): Promise<void> {
  if (systemTpl) return;
  systemTpl = await loadPrompt('pr-desc/system');
  draftTpl = await loadPrompt('pr-desc/draft');
  sharedRules = await loadShared('anti-hallucination', 'output-format');
}

/** 读 result 缓存里的其他命令结论；读不到就跳过（不是错误），绝不为了复用先跑一遍 */
async function readCachedResult(ctx: FeatureContext, featureId: string, fingerprint: string): Promise<string> {
  if (!ctx.cache.enabled) return '';
  try {
    const cached = await ctx.cache.read<unknown>('result', `${featureId}:${fingerprint}`);
    return cached ? JSON.stringify(cached, null, 1).slice(0, 6000) : '';
  } catch {
    return ''; // 缓存读失败当未命中
  }
}

export const prDescFeature: Feature<PrDescInput, PrDescOutput> = {
  id: 'pr-desc',
  name: 'PR 描述',
  description: '按仓库 PR 模板生成分支描述（--with-review 复用已有 review / test-plan 结论）',
  params: [{ flag: '--with-review', description: '复用缓存的 review / test-plan 结论（读不到就跳过）', type: 'boolean' }],
  outputSchema: PrDescOutputSchema,

  async collect(ctx, input) {
    await loadTemplates();
    const data = await collectBranchDiff(ctx, { base: input?.base, head: input?.head });
    const tpl = await resolvePrTemplate(ctx.git, ctx.config);

    let reuse = '';
    if (input?.withReview) {
      const [review, testPlan] = await Promise.all([
        readCachedResult(ctx, 'review', data.fingerprint),
        readCachedResult(ctx, 'test-plan', data.fingerprint),
      ]);
      reuse = [
        review ? `review 结论（已跑过）：\n${review}` : '',
        testPlan ? `test-plan 结论（已跑过）：\n${testPlan}` : '',
      ]
        .filter(Boolean)
        .join('\n\n');
    }

    return {
      ...data,
      extra: {
        ...data.extra,
        template: { headings: tpl.headings, source: tpl.source, raw: tpl.raw },
        reuse,
      },
    };
  },

  buildSteps(_data, ctx): PromptStep[] {
    const lang = ctx.config.output.language;
    const system = `${applyVars(systemTpl, { language: lang })}\n\n${sharedRules}`;

    return [
      summaryStep({
        id: 'draft',
        label: '生成 PR 描述',
        system,
        schema: PrDescOutputSchema,
        model: 'strong',
        thinking: 'high',
        buildUser(_results, d) {
          const tpl = d.extra.template as { headings: string[]; source: string };
          return applyVars(draftTpl, {
            stats: blockStats(d),
            commits: blockCommits(d),
            headings: tpl.headings.join('\n'),
            templateSource: tpl.source,
            reuse: (d.extra.reuse as string) || '（无）',
          });
        },
      }),
    ];
  },

  reduce(results: StepResults): PrDescOutput {
    return results.draft as PrDescOutput;
  },

  summaryLine(output) {
    return `✓ PR 描述完成：${output.sections.length} 个章节`;
  },

  render(output, _ctx, data) {
    const tpl = data.extra.template as { source: string } | undefined;
    const lines: string[] = [`# ${output.title}`, ''];
    for (const s of output.sections) {
      lines.push(mdHeading(2, s.heading), '', s.body.trim(), '');
    }
    lines.push(
      `> 统计（来自 git 事实）：${data.stats.files} 个文件，+${data.stats.additions} -${data.stats.deletions}，${data.commits.length} commits`,
      `> 模板来源：${tpl?.source ?? 'builtin'}`,
    );
    if (output.notes.trim() !== '') lines.push('', `> ${output.notes.trim()}`);
    return lines.join('\n').replace(/\n{3,}/g, '\n\n');
  },
};
