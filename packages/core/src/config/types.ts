/** 提交信息规范类型 */
export type CommitConvention = 'conventional' | 'angular' | 'custom';
/** 测试优先级 */
export type PriorityLevel = 'P0' | 'P1' | 'P2';
/** 符号解析器：ts-morph 精准但依赖重，grep 零依赖 */
export type SymbolParser = 'ts-morph' | 'grep';
/** 推理强度：non-think 走普通模式，high / max 走思考模式 */
export type ReasoningEffort = 'non-think' | 'high' | 'max';
/** LLM 档位 */
export type ModelTierName = 'fast' | 'strong';

/** 全部必填的最终配置（defaults 与各层合并后的产物） */
export interface ResolvedConfig {
  version: 1;
  /** 运行时注入，不来自 yml */
  repoRoot: string;
  /** 实际加载到的配置文件，用于 -v 打印 */
  configPaths: string[];
  git: {
    defaultBase: string;
    includeAuthors: string[];
  };
  review: {
    ignorePaths: string[];
    focusDimensions: string[];
    contextPaths: string[];
  };
  testPlan: {
    priorityLevels: PriorityLevel[];
    detectExisting: boolean;
    focus: string[];
  };
  impact: {
    maxDepth: number;
    symbolParser: SymbolParser;
    includeTests: boolean;
  };
  prDesc: {
    templatePaths: string[];
    includeReviewSummary: boolean;
  };
  commit: {
    convention: CommitConvention;
    types: string[];
    maxSubjectLength: number;
    learnFromLog: number;
    candidates: number;
    hooks: { enabled: boolean; skipEnvVar: string };
  };
  llm: {
    provider: 'deepseek';
    model: { fast: string; strong: string };
    reasoningEffort: ReasoningEffort;
    maxInputTokens: number;
    /** 单片目标上限，用于分片预算 */
    chunkTargetTokens: number;
    concurrency: number;
    timeoutMs: number;
    maxRetries: number;
  };
  security: {
    redact: boolean;
    /** 邮箱默认不脱敏（git 元数据需要） */
    redactEmails: boolean;
    blockedPaths: string[];
  };
  output: {
    dir: string;
    format: 'markdown' | 'html' | 'json';
    language: string;
  };
  diff: {
    smallThresholdTokens: number;
    largeThresholdTokens: number;
    /** 单文件改动超过此行数才做上下文补全 */
    enrichThresholdLines: number;
    /** 补全总量上限 */
    enrichMaxTokens: number;
  };
  cache: {
    enabled: boolean;
    maxAgeDays: number;
    dir: string;
  };
}

/** 递归可选；数组整体替换，不做元素级合并 */
export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

/** 用户写进 yml 的形态：除版本信息外全部可选 */
export type GitAgentConfig = DeepPartial<Omit<ResolvedConfig, 'version' | 'repoRoot' | 'configPaths'>>;
