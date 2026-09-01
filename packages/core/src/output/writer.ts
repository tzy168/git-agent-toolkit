import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ResolvedConfig } from '../config/types.js';
import { GitAgentError } from '../errors.js';
import { safeBranchName } from '../paths.js';

export interface ResolveOutputOptions {
  out?: string;
  branch?: string;
  ext?: string;
}

/** 默认：<repo>/<output.dir>/YYYY-MM/<branch>-<featureId>-<YYYYMMDD-HHmm>.md */
export function resolveOutputPath(
  cfg: ResolvedConfig,
  repoRoot: string,
  featureId: string,
  opts: ResolveOutputOptions = {},
): string {
  if (opts.out) return path.resolve(opts.out);
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
  const branch = safeBranchName(opts.branch ?? 'HEAD');
  const ext = opts.ext ?? (cfg.output.format === 'json' ? 'json' : 'md');
  return path.resolve(repoRoot, cfg.output.dir, ym, `${branch}-${featureId}-${stamp}.${ext}`);
}

/** UTF-8 + LF，递归建目录 */
export async function writeReport(content: string, outPath: string): Promise<void> {
  const text = content.replace(/\r\n?/g, '\n');
  try {
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, text, 'utf8');
  } catch (e) {
    throw new GitAgentError('FS_FAILED', `写报告失败：${outPath}`, '检查目录权限', e);
  }
}

/** 终端一行摘要 + 路径，写 stderr */
export function printSummary(line: string, outPath?: string): void {
  console.error(line);
  if (outPath) console.error(`  → ${outPath}`);
}
