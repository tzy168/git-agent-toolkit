import { mdHeading, mdList, mdTable } from '../../render/markdown.js';
import { applyVars, loadPrompt, loadShared } from '../../prompt/loader.js';
import type { Feature, PromptStep, StepResults } from '../registry.js';
import { blockCommits, blockStats } from '../shared/prompt-blocks.js';
import { collectBranchDiff, listExistingTests } from '../shared/collect-branch.js';
import { chunkMapStep, summaryStep } from '../shared/steps.js';
import { ChunkChangePointsSchema, TestPlanOutputSchema, type TestPlanOutput } from './schema.js';

export interface TestPlanInput {
  base?: string;
  head?: string;
}

let systemTpl = '';
let extractTpl = '';
let planTpl = '';
let sharedRules = '';

async function loadTemplates(): Promise<void> {
  if (systemTpl) return;
  systemTpl = await loadPrompt('test-plan/system');
  extractTpl = await loadPrompt('test-plan/extract');
  planTpl = await loadPrompt('test-plan/plan');
  sharedRules = await loadShared('anti-hallucination', 'output-format');
}

export const testPlanFeature: Feature<TestPlanInput, TestPlanOutput> = {
  id: 'test-plan',
  name: '测试计划',
  description: '基于分支 diff 提取变更点并推导测试用例（复用 review 的采集缓存）',
  params: [],
  outputSchema: TestPlanOutputSchema,

  async collect(ctx, input) {
    await loadTemplates();
    const data = await collectBranchDiff(ctx, { base: input?.base, head: input?.head });
    return {
      ...data,
      extra: {
        ...data.extra,
        existingTests: listExistingTests(data.files),
      },
    };
  },

  buildSteps(_data, ctx): PromptStep[] {
    const levels = ctx.config.testPlan.priorityLevels.join('/');
    const lang = ctx.config.output.language;
    const system = `${applyVars(systemTpl, { language: lang, priorityLevels: levels })}\n\n${sharedRules}`;

    return [
      chunkMapStep({
        id: 'extract',
        label: '提取变更点',
        system,
        schema: ChunkChangePointsSchema,
        model: 'fast',
        thinking: 'off',
        buildUser(chunk) {
          return applyVars(extractTpl, { module: chunk.module, diff: chunk.text });
        },
      }),

      summaryStep({
        id: 'plan',
        label: '推导用例',
        system,
        schema: TestPlanOutputSchema,
        model: 'fast',
        thinking: 'off',
        buildUser(results, d) {
          return applyVars(planTpl, {
            stats: blockStats(d),
            commits: blockCommits(d),
            changePoints: JSON.stringify(results.extract ?? [], null, 1),
            existingTests: ((d.extra.existingTests as string[]) ?? []).join('\n') || '（无）',
          });
        },
      }),
    ];
  },

  reduce(results: StepResults): TestPlanOutput {
    return results.plan as TestPlanOutput;
  },

  summaryLine(output) {
    const p = (s: string) => output.cases.filter((c) => c.priority === s).length;
    return `✓ 测试计划完成：${output.cases.length} 个用例（P0:${p('P0')} / P1:${p('P1')} / P2:${p('P2')}）`;
  },

  render(output, _ctx, data) {
    const lines: string[] = [
      mdHeading(1, '测试计划'),
      '',
      output.overview,
      '',
      `> 统计（来自 git 事实）：${data.stats.files} 个文件，+${data.stats.additions} -${data.stats.deletions}，${data.commits.length} commits`,
      '',
      mdHeading(2, '用例清单'),
      mdTable(
        ['优先级', '类型', '变更点', '场景', '已覆盖'],
        output.cases.map((c) => [c.priority, c.type, c.changePoint, c.scenario, c.alreadyCovered ? '是' : '否']),
      ),
      '',
    ];
    if (output.gaps.length > 0) {
      lines.push(mdHeading(2, '覆盖缺口'), '', mdList(output.gaps), '');
    }
    if (output.notes.trim() !== '') {
      lines.push(mdHeading(2, '说明'), '', output.notes.trim(), '');
    }
    return lines.join('\n').replace(/\n{3,}/g, '\n\n');
  },
};
