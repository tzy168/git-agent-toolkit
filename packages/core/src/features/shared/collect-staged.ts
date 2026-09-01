import { createHash } from 'node:crypto';

import { GitAgentError } from '../../errors.js';
import { fileToUnifiedDiff, parseDiff, statsOf } from '../../diff/parser.js';
import { filterFiles } from '../../diff/filter.js';
import { gradeScale, splitIntoChunks } from '../../diff/splitter.js';
import { estimateTokens } from '../../llm/budget.js';
import { redactFiles } from '../../redact/redactor.js';
import type { CollectedData } from '../../types.js';
import { hashString } from '../../util/text.js';
import type { FeatureContext } from '../registry.js';

export interface CollectStagedOpts {
  /** 覆盖 learnFromLog 条数 */
  recentN?: number;
}

/** commit 专用：暂存区 diff + 最近 N 条 subject；空则抛 NO_DATA */
export async function collectStaged(ctx: FeatureContext, opts: CollectStagedOpts = {}): Promise<CollectedData> {
  const staged = await ctx.git.getStagedDiff();
  if (staged.isEmpty) {
    throw new GitAgentError('NO_DATA', '暂存区为空', '先 git add 再运行 git-agent commit');
  }

  const fingerprint = createHash('sha1').update(`staged:${hashString(staged.text)}`).digest('hex');
  if (ctx.cache.enabled) {
    const cached = await ctx.cache.read<CollectedData>('collect', fingerprint);
    if (cached) {
      ctx.logger.info('命中采集缓存');
      return cached;
    }
  }

  const repo = ctx.repo;
  const parsed = parseDiff(staged.text);
  const filtered = filterFiles(parsed, {
    ignorePaths: ctx.config.review.ignorePaths,
    blockedPaths: ctx.config.security.blockedPaths,
  });
  const files = redactFiles(filtered.files, ctx.redactor);
  if (files.length === 0) {
    throw new GitAgentError('NO_DATA', '暂存区改动已被 ignore/blocked 过滤空', '检查 review.ignorePaths 与 security.blockedPaths');
  }

  const diffText = files.map(fileToUnifiedDiff).join('\n');
  const stats = statsOf(files);
  const n = opts.recentN ?? ctx.config.commit.learnFromLog;
  const subjects = await ctx.git.getRecentSubjects(n);
  const scale = gradeScale(estimateTokens(diffText), ctx.config);
  const chunks = splitIntoChunks(files, ctx.config);
  const data: CollectedData = {
    kind: 'staged-diff',
    fingerprint,
    repo,
    files,
    diffText,
    stats,
    commits: [],
    scale,
    chunks,
    enriched: {},
    extra: { recentSubjects: subjects, ignored: filtered.ignored, blocked: filtered.blocked },
    degraded: [],
  };

  if (ctx.cache.enabled) {
    await ctx.cache.write('collect', fingerprint, data);
  }
  return data;
}
