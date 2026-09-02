import { createHash } from 'node:crypto';

import { GitAgentError } from '../../errors.js';
import { createEnricher } from '../../diff/enricher.js';
import { fileToUnifiedDiff, isGeneratedPath, parseDiff, statsOf } from '../../diff/parser.js';
import { filterFiles } from '../../diff/filter.js';
import { gradeScale, splitIntoChunks } from '../../diff/splitter.js';
import { estimateTokens } from '../../llm/budget.js';
import { redactFiles } from '../../redact/redactor.js';
import { extOf } from '../../paths.js';
import type { CollectedData, EnrichmentMap, FileChange } from '../../types.js';
import { hashString } from '../../util/text.js';
import type { FeatureContext } from '../registry.js';

export interface CollectBranchOpts {
  base?: string;
  head?: string;
  /** --no-cache 时跳过读（写仍按 ctx.cache.enabled 控制） */
  skipCacheRead?: boolean;
}

/**
 * 5 个分支对比命令共用的分支 diff 采集：
 * merge-base → 指纹 → 缓存 → 三点 diff → parse → filter → redact → 分级分片 → 补全。
 */
export async function collectBranchDiff(ctx: FeatureContext, opts: CollectBranchOpts = {}): Promise<CollectedData> {
  const base = opts.base || ctx.config.git.defaultBase;
  const head = opts.head || 'HEAD';
  const baseSha = await ctx.git.resolveRef(base);
  const headSha = await ctx.git.resolveRef(head);
  const mergeBase = await ctx.git.getMergeBase(baseSha, headSha);

  const ruleHash = hashString(
    [...ctx.config.review.ignorePaths, ...ctx.config.security.blockedPaths, String(ctx.config.diff.enrichThresholdLines)].join('|'),
  );
  const fingerprint = createHash('sha1').update(`${mergeBase}:${headSha}:${ruleHash}`).digest('hex');

  if (ctx.cache.enabled && !opts.skipCacheRead) {
    const cached = await ctx.cache.read<CollectedData>('collect', `branchdiff:${fingerprint}`);
    if (cached) {
      ctx.logger.info('命中采集缓存');
      return cached;
    }
  }

  const [diff, commits] = await Promise.all([
    ctx.git.getBranchDiff(baseSha, headSha), // 三点语法铁律
    ctx.git.getLog({ range: `${baseSha}..${headSha}` }), // log 用两点
  ]);

  const parsed = parseDiff(diff.text);
  const filtered = filterFiles(parsed, {
    ignorePaths: ctx.config.review.ignorePaths,
    blockedPaths: ctx.config.security.blockedPaths,
  });
  const files = redactFiles(filtered.files, ctx.redactor);
  if (files.length === 0) {
    throw new GitAgentError('NO_DATA', '过滤后没有可分析的文件改动', '检查 --base/--head 范围与 review.ignorePaths 配置');
  }

  const diffText = files.map(fileToUnifiedDiff).join('\n');
  const stats = statsOf(files);
  const scale = gradeScale(estimateTokens(diffText), ctx.config);
  const chunks = splitIntoChunks(files, ctx.config);

  let enriched: EnrichmentMap = {};
  const degraded: string[] = [];
  if (scale !== 'small') {
    try {
      const enricher = await createEnricher(ctx.git, ctx.config);
      enriched = await enricher.enrich(files, { maxTokens: ctx.config.diff.enrichMaxTokens });
      if (enricher.mode === 'regex') degraded.push('ts-morph 不可用，上下文补全退化为正则模式');
    } catch (e) {
      ctx.logger.warn(`上下文补全失败（已跳过）：${e instanceof Error ? e.message : String(e)}`);
      degraded.push('上下文补全失败，已跳过');
    }
  }

  const data: CollectedData = {
    kind: 'branch-diff',
    fingerprint,
    repo: ctx.repo,
    base,
    head,
    mergeBase,
    files,
    diffText,
    stats,
    commits,
    scale,
    chunks,
    enriched,
    extra: { ignored: filtered.ignored, blocked: filtered.blocked },
    degraded,
  };

  if (ctx.cache.enabled) {
    await ctx.cache.write('collect', `branchdiff:${fingerprint}`, data);
  }
  return data;
}

/** 给 test-plan 的 detectExisting 用：判断是否像测试文件 */
export function isTestPath(p: string): boolean {
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) || p.includes('__tests__') || /(^|\/)(tests?)\//.test(p);
}

/** 既有测试文件清单（供模型去重），失败即空 */
export function listExistingTests(files: FileChange[]): string[] {
  return files.filter((f) => !f.isBinary && !isGeneratedPath(f.path) && isTestPath(f.path)).map((f) => f.path);
}

/** 语言推断出口复用 parser 的规则（报告里标注语言用） */
export function fileLanguage(p: string): string | null {
  return extOf(p) || null;
}
