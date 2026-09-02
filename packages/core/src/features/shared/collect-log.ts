import { createHash } from 'node:crypto';

import { GitAgentError } from '../../errors.js';
import { statsOf } from '../../diff/parser.js';
import { gradeScale } from '../../diff/splitter.js';
import { estimateTokens } from '../../llm/budget.js';
import type { CollectedData, FileChange } from '../../types.js';
import type { FeatureContext } from '../registry.js';

export interface CollectWeekOpts {
  since?: string;
  until?: string;
  authors?: string[];
  /** 显式统计所有人（默认只统计当前 git 用户） */
  allAuthors?: boolean;
  skipCacheRead?: boolean;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** 本周一 00:00（本地时区），git 可读的 YYYY-MM-DDTHH:mm:ss 形式 */
export function mondayStart(now = new Date()): string {
  const day = (now.getDay() + 6) % 7;
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day);
  return `${monday.getFullYear()}-${pad(monday.getMonth() + 1)}-${pad(monday.getDate())}T00:00:00`;
}

/** now（本地时区） */
export function nowStamp(now = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

/** weekly 专用：本周 log（--all + 时间窗 + numstat），聚合出真实统计数字 */
export async function collectWeekLog(ctx: FeatureContext, opts: CollectWeekOpts = {}): Promise<CollectedData> {
  const since = opts.since || mondayStart();
  const until = opts.until || nowStamp();
  const authors = resolveAuthors(ctx, opts);

  const fingerprint = createHash('sha1')
    .update(`${since}:${until}:${authors.join(',')}:${ctx.repo.headSha}`)
    .digest('hex');

  if (ctx.cache.enabled && !opts.skipCacheRead) {
    const cached = await ctx.cache.read<CollectedData>('collect', `weeklog:${fingerprint}`);
    if (cached) {
      ctx.logger.info('命中采集缓存');
      return cached;
    }
  }

  const commits = await ctx.git.getLog({
    all: true,
    since,
    until,
    authors: authors.length > 0 ? authors : undefined,
    withNumstat: true,
  });
  if (commits.length === 0) {
    throw new GitAgentError('NO_DATA', '该时间范围内没有 commit', '调整 --since/--until，或检查 git.includeAuthors 配置');
  }

  const files = aggregateFiles(commits.flatMap((c) => c.files ?? []));
  const diffText = commits.map((c) => `${c.shortSha} ${c.subject}`).join('\n');
  const stats = statsOf(files);

  const data: CollectedData = {
    kind: 'log-range',
    fingerprint,
    repo: ctx.repo,
    files,
    diffText,
    stats,
    commits,
    scale: gradeScale(estimateTokens(diffText), ctx.config),
    chunks: [],
    enriched: {},
    extra: { since, until, authors },
    degraded: [],
  };

  if (ctx.cache.enabled) {
    await ctx.cache.write('collect', `weeklog:${fingerprint}`, data);
  }
  return data;
}

/**
 * 作者解析优先级：CLI --authors > 配置 git.includeAuthors > 当前 git 用户。
 * --all-authors 显式要求统计所有人时不过滤。
 * 默认只看自己（周报是个人视角），识别不到当前用户时回退为统计所有人并 warn。
 */
export function resolveAuthors(ctx: FeatureContext, opts: CollectWeekOpts): string[] {
  if (opts.allAuthors) return [];
  if (opts.authors?.length) return opts.authors;
  if (ctx.config.git.includeAuthors.length > 0) return ctx.config.git.includeAuthors;

  const me = ctx.repo.author;
  if (me && (me.name !== '' || me.email !== '')) {
    const who = me.name !== '' ? me.name : me.email;
    ctx.logger.info(`周报默认只统计当前用户：${who}`);
    return [who];
  }
  ctx.logger.warn('无法识别当前 git 用户（user.name / user.email 均未配置），回退为统计所有人');
  return [];
}

/** 把多个 commit 的 numstat 聚合成按文件的 FileChange（无 hunk，仅统计用） */
function aggregateFiles(entries: { path: string; add: number; del: number }[]): FileChange[] {
  const agg = new Map<string, { add: number; del: number }>();
  for (const e of entries) {
    const slot = agg.get(e.path) ?? { add: 0, del: 0 };
    slot.add += e.add;
    slot.del += e.del;
    agg.set(e.path, slot);
  }
  return [...agg.entries()].map(([path, v]) => ({
    path,
    status: 'M' as const,
    additions: v.add,
    deletions: v.del,
    isBinary: false,
    isGenerated: false,
    language: null,
    hunks: [],
  }));
}
