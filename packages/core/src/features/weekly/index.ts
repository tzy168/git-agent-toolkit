import { readFile } from 'node:fs/promises';

import { mdHeading, mdList, mdTable } from '../../render/markdown.js';
import { applyVars, loadPrompt, loadShared } from '../../prompt/loader.js';
import type { Feature, PromptStep } from '../registry.js';
import { blockCommits, blockStats } from '../shared/prompt-blocks.js';
import { collectWeekLog } from '../shared/collect-log.js';
import { findLastWeeklyReport } from './history.js';
import { WeeklyOutputSchema, type WeeklyOutput } from './schema.js';

export type { WeeklyOutput, WorkItem } from './schema.js';

export interface WeeklyInput {
  since?: string;
  until?: string;
  /** 逗号分隔的作者列表（CLI 直传字符串） */
  authors?: string;
  /** 统计所有人（默认只统计当前 git 用户） */
  allAuthors?: boolean;
  note?: string;
  noteFile?: string;
}

let systemTpl = '';
let draftTpl = '';
let sharedRules = '';

async function loadTemplates(): Promise<void> {
  if (systemTpl) return;
  systemTpl = await loadPrompt('weekly/system');
  draftTpl = await loadPrompt('weekly/draft');
  sharedRules = await loadShared('anti-hallucination', 'output-format');
}

export const weeklyFeature: Feature<WeeklyInput, WeeklyOutput> = {
  id: 'weekly',
  name: '周报',
  description: '按本周 git log 归纳周报（默认只统计当前 git 用户），人工备注原样保留',
  params: [
    { flag: '--since <date>', description: '起始时间（默认本周一 00:00）', type: 'string' },
    { flag: '--until <date>', description: '结束时间（默认现在）', type: 'string' },
    { flag: '--note <text>', description: '人工补充内容，模型不改写', type: 'string' },
    { flag: '--note-file <path>', description: '人工补充内容文件（--edit 时由 CLI 写入临时文件）', type: 'string' },
    { flag: '--authors <names>', description: '只统计指定作者（逗号分隔，默认当前 git 用户）', type: 'string' },
    { flag: '--all-authors', description: '统计所有人的 commit（默认只统计当前 git 用户）', type: 'boolean' },
  ],
  outputSchema: WeeklyOutputSchema,

  async collect(ctx, input) {
    await loadTemplates();
    const data = await collectWeekLog(ctx, {
      since: input?.since,
      until: input?.until,
      authors: input?.authors ? input.authors.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
      allAuthors: input?.allAuthors,
    });
    const notes = await readNotes(input);
    const lastReport = await findLastWeeklyReport(ctx.config.repoRoot);
    return {
      ...data,
      extra: {
        ...data.extra,
        notes,
        lastReport: lastReport ? lastReport.slice(0, 4000) : '',
      },
    };
  },

  buildSteps(data, ctx): PromptStep[] {
    const lang = ctx.config.output.language;
    return [
      {
        kind: 'single',
        id: 'draft',
        label: '归纳周报',
        system: `${systemTpl}\n\n${sharedRules}`,
        schema: WeeklyOutputSchema,
        model: 'strong',
        thinking: 'high',
        buildUser() {
          return applyVars(draftTpl, {
            language: lang,
            since: String(data.extra.since ?? ''),
            until: String(data.extra.until ?? ''),
            stats: blockStats(data),
            commits: blockCommits(data),
            notes: (data.extra.notes as string) || '（无）',
            lastReport: (data.extra.lastReport as string) || '（无）',
          });
        },
      },
    ];
  },

  summaryLine(output) {
    return `✓ 周报完成：${output.workItems.length} 个工作项 / ${data0(output)}% 主要精力`;
  },

  render(output, _ctx, data) {
    const lines: string[] = [
      mdHeading(1, `周报（${String(data.extra.since ?? '')} ~ ${String(data.extra.until ?? '')}）`),
      '',
      output.overview,
      '',
      mdHeading(2, '本周工作'),
      mdTable(
        ['工作项', '占比', '状态', '要点'],
        output.workItems.map((w) => [
          w.title,
          `${w.weightPercent}%`,
          w.status,
          w.bullets.join('；'),
        ]),
      ),
      '',
      mdHeading(2, '遇到的问题'),
      output.problems.length > 0 ? mdList(output.problems) : '（无）',
      '',
      mdHeading(2, '下周计划'),
      output.nextWeek.length > 0 ? mdList(output.nextWeek) : '（无）',
      '',
      mdHeading(2, '需要的支持'),
      output.needsSupport.length > 0 ? mdList(output.needsSupport) : '（无）',
    ];
    if (output.manualNotes.trim() !== '') {
      lines.push('', mdHeading(2, '备注（人工补充，未改写）'), '', output.manualNotes.trim());
    }
    lines.push('', `> 统计：${data.commits.length} commits，${data.stats.files} 个文件 +${data.stats.additions} -${data.stats.deletions}`);
    return lines.join('\n');
  },
};

async function readNotes(input: WeeklyInput | undefined): Promise<string> {
  if (input?.note && input.note.trim() !== '') return input.note;
  if (input?.noteFile) {
    try {
      return await readFile(input.noteFile, 'utf8');
    } catch {
      return '';
    }
  }
  return '';
}

function data0(output: WeeklyOutput): number {
  const top = [...output.workItems].sort((a, b) => b.weightPercent - a.weightPercent)[0];
  return top?.weightPercent ?? 0;
}
