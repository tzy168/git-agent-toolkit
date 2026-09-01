import type { CommitInfo } from './git/types.js';

/** 进程退出码：0 成功 / 1 出错 / 2 发现阻断项（CI 用） / 3 无数据 */
export type ExitCode = 0 | 1 | 2 | 3;

/** 日志级别：-v → debug，默认 info，--quiet → silent */
export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

/** 仓库元信息 */
export interface RepoInfo {
  /** 绝对路径，posix 分隔符 */
  root: string;
  /** 当前分支；detached HEAD 时为 'HEAD' */
  branch: string;
  headSha: string;
  isDirty: boolean;
  /** git config user.*；没配过则为 null */
  author: { name: string; email: string } | null;
}

/** 进度事件，由 FeatureContext.onProgress 发出，CLI 渲染为进度提示 */
export interface ProgressEvent {
  phase: 'collect' | 'enrich' | 'llm' | 'render' | 'write';
  message: string;
  current?: number;
  total?: number;
}

/** 分级日志器，一律写 stderr（stdout 留给报告全文与 JSON） */
export interface Logger {
  debug(m: string): void;
  info(m: string): void;
  warn(m: string): void;
  error(m: string): void;
  child(prefix: string): Logger;
}

/** 任务级用量汇总，写入报告尾部与 --json 的 usage 字段 */
export interface UsageTotals {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  /** 前缀缓存命中部分；DeepSeek 未返回则为 0 */
  cachedPromptTokens: number;
  elapsedMs: number;
}

/* ------------------------------------------------------------------ */
/* Diff 层数据结构（src/diff/* 的产物）                                  */
/* ------------------------------------------------------------------ */

export type FileStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U';

export interface DiffLine {
  type: 'add' | 'del' | 'ctx';
  oldNo: number | null;
  newNo: number | null;
  /** 不含 +/- 前缀的原文 */
  text: string;
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** @@ 行尾的函数上下文，有助于定位被改函数 */
  context?: string;
  lines: DiffLine[];
}

export interface FileChange {
  /** posix 路径 */
  path: string;
  /** 重命名场景的原路径 */
  oldPath?: string;
  status: FileStatus;
  additions: number;
  deletions: number;
  isBinary: boolean;
  /** lock / dist / *.min.js / __snapshots__ 等 */
  isGenerated: boolean;
  /** 由扩展名推断：ts / tsx / js / css / md ... */
  language: string | null;
  hunks: Hunk[];
}

export interface DiffStats {
  files: number;
  additions: number;
  deletions: number;
  byExt: Record<string, { files: number; additions: number; deletions: number }>;
}

export type DiffScale = 'small' | 'medium' | 'large';

export interface DiffChunk {
  /** 'c0' / 'c1' ... */
  id: string;
  /** 分片代表目录，用于日志与报告署名 */
  module: string;
  paths: string[];
  /** 该片的 unified diff */
  text: string;
  estTokens: number;
}

/** 上下文补全产物：path → 追加给模型的片段文本 */
export type EnrichmentMap = Record<string, string>;

/* ------------------------------------------------------------------ */
/* 采集结果（缓存的单位）                                                */
/* ------------------------------------------------------------------ */

export type CollectKind = 'branch-diff' | 'staged-diff' | 'log-range';

export interface CollectedData {
  kind: CollectKind;
  /** 缓存键，构造规则见 architecture.md §5.4 */
  fingerprint: string;
  repo: RepoInfo;
  /** branch-diff 才有 */
  base?: string;
  head?: string;
  mergeBase?: string;
  /** 过滤后 */
  files: FileChange[];
  /** 过滤后的完整 unified diff */
  diffText: string;
  stats: DiffStats;
  commits: CommitInfo[];
  scale: DiffScale;
  chunks: DiffChunk[];
  enriched: EnrichmentMap;
  /** feature 私有：如 test-plan 的已有测试清单、pr-desc 的模板 */
  extra: Record<string, unknown>;
  /** 降级说明，如 'ts-morph 不可用，符号解析退化为正则' */
  degraded: string[];
}
