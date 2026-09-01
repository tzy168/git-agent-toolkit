import { estimateTokens, truncateToBudget } from '../llm/budget.js';
import { topDirs } from '../paths.js';
import type { ResolvedConfig } from '../config/types.js';
import type { DiffChunk, DiffScale, FileChange, Hunk } from '../types.js';
import { fileToUnifiedDiff } from './parser.js';

export { estimateTokens } from '../llm/budget.js';

/** 按阈值把 token 数打成 small / medium / large */
export function gradeScale(tokens: number, cfg: ResolvedConfig): DiffScale {
  if (tokens < cfg.diff.smallThresholdTokens) return 'small';
  if (tokens <= cfg.diff.largeThresholdTokens) return 'medium';
  return 'large';
}

/** 文件清单 + 每文件一行 numstat，供 large 模式 outline */
export function buildOutline(files: FileChange[]): string {
  return files.map((f) => `${f.status}\t${f.path}\t+${f.additions}\t-${f.deletions}`).join('\n');
}

interface Bucket {
  module: string;
  files: FileChange[];
  texts: string[];
  estTokens: number;
}

/** 同目录/同模块聚合分片；单文件超预算按 hunk 切 */
export function splitIntoChunks(files: FileChange[], cfg: ResolvedConfig): DiffChunk[] {
  const budget = cfg.llm.chunkTargetTokens;
  if (files.length === 0) return [];

  const groups = new Map<string, FileChange[]>();
  for (const f of files) {
    const mod = topDirs(f.path, 2);
    const list = groups.get(mod) ?? [];
    list.push(f);
    groups.set(mod, list);
  }

  const buckets: Bucket[] = [];
  for (const [module, group] of groups) {
    group.sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions));
    let bucket: Bucket = { module, files: [], texts: [], estTokens: 0 };
    const pushBucket = (): void => {
      if (bucket.files.length === 0 && bucket.texts.length === 0) return;
      buckets.push(bucket);
      bucket = { module, files: [], texts: [], estTokens: 0 };
    };

    for (const file of group) {
      const pieces = splitFileIfNeeded(file, budget);
      for (const piece of pieces) {
        if (bucket.estTokens > 0 && bucket.estTokens + piece.estTokens > budget) pushBucket();
        bucket.files.push(file);
        bucket.texts.push(piece.text);
        bucket.estTokens += piece.estTokens;
      }
    }
    pushBucket();
  }

  mergeTiny(buckets, budget);
  return buckets.map((b, i) => ({
    id: `c${i}`,
    module: b.module,
    paths: unique(b.files.map((f) => f.path)),
    text: b.texts.join('\n'),
    estTokens: b.estTokens,
  }));
}

function splitFileIfNeeded(file: FileChange, budget: number): { text: string; estTokens: number }[] {
  const whole = fileToUnifiedDiff(file);
  const tokens = estimateTokens(whole);
  if (tokens <= budget || file.hunks.length <= 1) {
    const text = tokens <= budget ? whole : truncateToBudget(whole, budget);
    return [{ text, estTokens: estimateTokens(text) }];
  }

  const pieces: { text: string; estTokens: number }[] = [];
  let acc: Hunk[] = [];
  let accText = fileHeader(file);
  let accTok = estimateTokens(accText);

  const flush = (): void => {
    if (acc.length === 0) return;
    pieces.push({ text: accText, estTokens: accTok });
    acc = [];
    accText = fileHeader(file);
    accTok = estimateTokens(accText);
  };

  for (const hunk of file.hunks) {
    const slice = { ...file, hunks: [hunk] };
    const hunkText = hunkBlock(hunk);
    const tok = estimateTokens(hunkText);
    if (acc.length > 0 && accTok + tok > budget) flush();
    if (acc.length === 0 && tok > budget) {
      const truncated = truncateToBudget(fileToUnifiedDiff(slice), budget);
      pieces.push({ text: truncated, estTokens: estimateTokens(truncated) });
      continue;
    }
    acc.push(hunk);
    accText = `${accText}\n${hunkText}`;
    accTok += tok;
  }
  flush();
  return pieces.length > 0 ? pieces : [{ text: whole, estTokens: tokens }];
}

function fileHeader(file: FileChange): string {
  const oldPath = file.oldPath ?? file.path;
  return [`diff --git a/${oldPath} b/${file.path}`, `--- a/${oldPath}`, `+++ b/${file.path}`].join('\n');
}

function hunkBlock(hunk: Hunk): string {
  const ctx = hunk.context ? ` ${hunk.context}` : '';
  const lines = [`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@${ctx}`];
  for (const l of hunk.lines) {
    const prefix = l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ';
    lines.push(prefix + l.text);
  }
  return lines.join('\n');
}

/** 桶太碎（<3 文件且 token 很少）时与前一个合并 */
function mergeTiny(buckets: Bucket[], budget: number): void {
  const tiny = (b: Bucket): boolean => b.files.length < 3 && b.estTokens < budget / 8;
  for (let i = 1; i < buckets.length; ) {
    const prev = buckets[i - 1] as Bucket;
    const cur = buckets[i] as Bucket;
    if (tiny(cur) && prev.estTokens + cur.estTokens <= budget) {
      prev.files.push(...cur.files);
      prev.texts.push(...cur.texts);
      prev.estTokens += cur.estTokens;
      buckets.splice(i, 1);
      continue;
    }
    i++;
  }
}

function unique(xs: string[]): string[] {
  return [...new Set(xs)];
}
