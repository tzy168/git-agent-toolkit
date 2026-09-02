import { mdHeading, mdList, mdTable, severityIcon } from '../../render/markdown.js';
import { buildOutline } from '../../diff/splitter.js';
import { applyVars, loadPrompt, loadShared } from '../../prompt/loader.js';
import type { ExitCode } from '../../types.js';
import type { Feature, PromptStep, StepResults } from '../registry.js';
import { blockCommits, blockStats } from '../shared/prompt-blocks.js';
import { collectBranchDiff } from '../shared/collect-branch.js';
import { chunkMapStep, summaryChunk, summaryStep } from '../shared/steps.js';
import {
  ChunkIssuesSchema,
  CrossFileOutputSchema,
  OutlineSchema,
  ReviewOutputSchema,
  type CrossFileOutput,
  type OutlineOutput,
  type ReviewOutput,
} from './schema.js';

export interface ReviewInput {
  base?: string;
  head?: string;
}

let systemTpl = '';
let chunkTpl = '';
let summaryTpl = '';
let crossFileTpl = '';
let sharedRules = '';
let severityScale = '';

async function loadTemplates(): Promise<void> {
  if (systemTpl) return;
  systemTpl = await loadPrompt('review/system');
  chunkTpl = await loadPrompt('review/chunk');
  summaryTpl = await loadPrompt('review/summary');
  crossFileTpl = await loadPrompt('review/cross-file');
  sharedRules = await loadShared('anti-hallucination', 'output-format');
  severityScale = await loadShared('severity-scale');
}

export const reviewFeature: Feature<ReviewInput, ReviewOutput> = {
  id: 'review',
  name: '代码审查',
  description: '对分支 diff 做 map-reduce 三遍式审查（分片 → 汇总 → 跨文件）',
  params: [],
  outputSchema: ReviewOutputSchema,

  async collect(ctx, input) {
    await loadTemplates();
    return collectBranchDiff(ctx, { base: input?.base, head: input?.head });
  },

  buildSteps(data, ctx): PromptStep[] {
    const dims = ctx.config.review.focusDimensions.join(' / ');
    const lang = ctx.config.output.language;
    // system 稳定前缀只拼一次，分片间字节一致（前缀缓存命中的前提）
    const system = `${applyVars(systemTpl, { dimensions: dims, language: lang })}\n\n${severityScale}\n\n${sharedRules}`;

    const steps: PromptStep[] = [
      {
        kind: 'single',
        id: 'outline',
        label: '挑重点文件',
        system,
        schema: OutlineSchema,
        model: 'strong',
        thinking: 'high',
        runIf: () => data.scale === 'large',
        buildUser() {
          return `大 diff（${data.scale}），先挑重点文件。\n\n${buildOutline(data.files)}\n\n重点文件直接深挖，其余走摘要级。`;
        },
      },

      chunkMapStep({
        id: 'chunk',
        label: '分片分析',
        system,
        schema: ChunkIssuesSchema,
        model: 'fast',
        thinking: 'off',
        selectChunks(results, d) {
          const focus = (results.outline as OutlineOutput | undefined)?.focusFiles;
          if (!focus?.length) return d.chunks;
          const wanted = new Set(focus);
          const selected = d.chunks.filter((c) => c.paths.some((p) => wanted.has(p)));
          const rest = summaryChunk(d, focus, ctx.config.llm.chunkTargetTokens);
          ctx.logger.info(`挑出 ${selected.length} 个重点分片，其余走摘要级`);
          return rest ? [...selected, rest] : selected;
        },
        buildUser(chunk, d) {
          const enrich = Object.entries(d.enriched)
            .filter(([p]) => chunk.paths.includes(p))
            .map(([, text]) => text)
            .join('\n\n');
          return applyVars(chunkTpl, {
            module: chunk.module,
            diff: chunk.text,
            context: enrich || '（无）',
          });
        },
      }),

      summaryStep({
        id: 'summary',
        label: '汇总定级',
        system,
        schema: ReviewOutputSchema,
        model: 'strong',
        thinking: 'high',
        buildUser(results, d) {
          return applyVars(summaryTpl, {
            stats: blockStats(d),
            commits: blockCommits(d),
            chunkIssues: JSON.stringify(results.chunk ?? [], null, 1),
          });
        },
      }),
    ];

    steps.push({
      kind: 'single',
      id: 'cross-file',
      label: '跨文件检查',
      system,
      schema: CrossFileOutputSchema,
      model: 'strong',
      thinking: 'high',
      runIf: () => data.files.length > 3,
      buildUser() {
        const fileSummary = data.files
          .map((f) => `${f.status} ${f.path} +${f.additions} -${f.deletions}`)
          .join('\n');
        return applyVars(crossFileTpl, { fileSummary });
      },
    });

    return steps;
  },

  reduce(results: StepResults): ReviewOutput {
    const summary = results.summary as ReviewOutput;
    const cross = (results['cross-file'] as CrossFileOutput | undefined)?.crossFile ?? [];
    return { ...summary, crossFile: cross };
  },

  exitCode(output): ExitCode {
    return output.issues.some((i) => i.severity === 'blocker') ? 2 : 0;
  },

  summaryLine(output) {
    const n = (s: string) => output.issues.filter((i) => i.severity === s).length;
    return `✓ 审查完成：${n('blocker')} 阻断 / ${n('major')} 重要 / ${n('minor')} 建议 / ${n('nit')} 吹毛求疵`;
  },

  render(output, _ctx, data) {
    const order = ['blocker', 'major', 'minor', 'nit'] as const;
    const lines: string[] = [
      mdHeading(1, '代码审查报告'),
      '',
      mdHeading(2, '概览'),
      output.overview,
      '',
      mdHeading(2, '变更意图'),
      output.intent,
      '',
      `> 统计（来自 git 事实）：${data.stats.files} 个文件，+${data.stats.additions} -${data.stats.deletions}，${data.commits.length} commits`,
      data.degraded.length > 0 ? `> 说明：${data.degraded.join('；')}` : '',
      '',
    ];
    for (const sev of order) {
      const issues = output.issues.filter((i) => i.severity === sev);
      if (issues.length === 0) continue;
      lines.push(mdHeading(2, severityIcon(sev)), '');
      lines.push(
        mdTable(
          ['文件', '行', '类别', '问题', '建议', '置信'],
          issues.map((i) => [i.file, i.line == null ? '-' : String(i.line), i.category, i.title, i.suggestion, i.confidence]),
        ),
        '',
      );
    }
    if (output.crossFile.length > 0) {
      lines.push(mdHeading(2, '跨文件问题'), '');
      for (const c of output.crossFile) {
        lines.push(`### ${c.title}`, c.files.join('、'), '', c.detail, '');
      }
    }
    if (output.risks.length > 0) lines.push(mdHeading(2, '风险'), '', mdList(output.risks), '');
    if (output.highlights.length > 0) lines.push(mdHeading(2, '亮点'), '', mdList(output.highlights), '');
    if (output.questions.length > 0) lines.push(mdHeading(2, '待确认'), '', mdList(output.questions), '');
    return lines.filter((l) => l !== '' || true).join('\n').replace(/\n{3,}/g, '\n\n');
  },
};
