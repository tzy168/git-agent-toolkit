import type { RepoInfo } from '../types.js';

/** git 采集层接口；除 commit 外全部只读 */
export interface GitProvider {
  getRepoInfo(): Promise<RepoInfo>;
  /** ref → sha，不存在则抛 REF_NOT_FOUND */
  resolveRef(ref: string): Promise<string>;
  getMergeBase(base: string, head?: string): Promise<string>;
  /** 内部必须用三点语法：git diff base...head */
  getBranchDiff(base: string, head?: string): Promise<{ text: string; numstat: string }>;
  getStagedDiff(): Promise<{ text: string; numstat: string; isEmpty: boolean }>;
  getLog(opts: LogOptions): Promise<CommitInfo[]>;
  getRecentSubjects(n: number): Promise<string[]>;
  /** 读 base/head 版本文件内容 */
  getFileAt(ref: string, path: string): Promise<string | null>;
  /** git ls-files，已天然排除 ignored */
  listRepoFiles(): Promise<string[]>;
  searchText(pattern: RegExp, opts?: { paths?: string[]; maxHits?: number }): Promise<GrepHit[]>;
  /** 全项目唯一写操作，仅 commit 命令调用 */
  commit(message: string): Promise<void>;
  installHook(name: string, script: string): Promise<void>;
  uninstallHook(name: string): Promise<void>;
}

export interface LogOptions {
  /** weekly 用 --all（本周可能切过多个分支） */
  all?: boolean;
  authors?: string[];
  /** ISO 或 git 可读日期（'last monday'） */
  since?: string;
  until?: string;
  maxCount?: number;
  withNumstat?: boolean;
  /** 如 'origin/main..HEAD' */
  range?: string;
}

export interface CommitInfo {
  sha: string;
  shortSha: string;
  author: string;
  email: string;
  /** ISO 8601 */
  date: string;
  subject: string;
  body: string;
  branch?: string;
  /** --numstat */
  files?: { path: string; add: number; del: number }[];
}

export interface GrepHit {
  path: string;
  line: number;
  text: string;
}
