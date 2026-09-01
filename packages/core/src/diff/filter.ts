import picomatch from 'picomatch';

import { toPosix } from '../paths.js';
import type { FileChange } from '../types.js';

export interface FilterRules {
  ignorePaths: string[];
  blockedPaths: string[];
}

export interface FilterResult {
  files: FileChange[];
  ignored: number;
  blocked: number;
}

/** 按 ignorePaths / blockedPaths glob 过滤；命中 blocked 的文件整体剔除 */
export function filterFiles(files: FileChange[], rules: FilterRules): FilterResult {
  const ignore = rules.ignorePaths.length > 0 ? picomatch(rules.ignorePaths, { dot: true }) : () => false;
  const blocked = rules.blockedPaths.length > 0 ? picomatch(rules.blockedPaths, { dot: true }) : () => false;
  const kept: FileChange[] = [];
  let ignored = 0;
  let blockedCount = 0;
  for (const file of files) {
    const p = toPosix(file.path);
    const old = file.oldPath ? toPosix(file.oldPath) : '';
    if (blocked(p) || (old && blocked(old))) {
      blockedCount++;
      continue;
    }
    if (ignore(p) || (old && ignore(old))) {
      ignored++;
      continue;
    }
    kept.push(file);
  }
  return { files: kept, ignored, blocked: blockedCount };
}
