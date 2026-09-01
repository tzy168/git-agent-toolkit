import type { ResolvedConfig } from './types.js';

/**
 * 模型 id 全项目只允许出现在这两个常量里。
 * deepseek-chat / deepseek-reasoner 已于 2026-07-24 废弃，禁止使用。
 */
export const MODEL_FAST = 'deepseek-v4-flash';
export const MODEL_STRONG = 'deepseek-v4-pro';

/** 全量默认值：方案 §7 + architecture.md §3.8 新增的 diff / cache 两节 */
export const DEFAULT_CONFIG: ResolvedConfig = {
  version: 1,
  repoRoot: '',
  configPaths: [],

  git: {
    defaultBase: 'origin/main',
    includeAuthors: [],
  },

  review: {
    ignorePaths: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/*.lock',
      'package-lock.json',
      'pnpm-lock.yaml',
      'yarn.lock',
      '**/*.min.js',
      '**/*.map',
      '**/__snapshots__/**',
    ],
    focusDimensions: ['正确性', '边界与异常', '错误处理', '性能', '安全', '可维护性', '测试覆盖'],
    contextPaths: ['.git-agent/context'],
  },

  testPlan: {
    priorityLevels: ['P0', 'P1', 'P2'],
    detectExisting: true,
    focus: [],
  },

  impact: {
    maxDepth: 2,
    symbolParser: 'grep',
    includeTests: false,
  },

  prDesc: {
    templatePaths: [
      '.git/pull_request_template.md',
      '.github/PULL_REQUEST_TEMPLATE.md',
      '.github/pull_request_template.md',
      '.gitlab/merge_request_templates/Default.md',
    ],
    includeReviewSummary: true,
  },

  commit: {
    convention: 'conventional',
    types: ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert'],
    maxSubjectLength: 72,
    learnFromLog: 50,
    candidates: 3,
    language: 'zh-CN',
    hooks: { enabled: false, skipEnvVar: 'GIT_AGENT_DISABLE' },
  },

  llm: {
    provider: 'deepseek',
    model: { fast: MODEL_FAST, strong: MODEL_STRONG },
    reasoningEffort: 'high',
    maxInputTokens: 120_000,
    chunkTargetTokens: 24_000,
    concurrency: 3,
    timeoutMs: 120_000,
    maxRetries: 2,
  },

  security: {
    redact: true,
    redactEmails: false,
    blockedPaths: ['.env', '.env.*', '**/.env.*', '**/*secret*', '**/*credential*', '**/*.pem', '**/*.key', '**/id_rsa*'],
  },

  output: {
    dir: '.git-agent/reports',
    format: 'markdown',
    language: 'zh-CN',
  },

  diff: {
    smallThresholdTokens: 8_000,
    largeThresholdTokens: 60_000,
    enrichThresholdLines: 30,
    enrichMaxTokens: 20_000,
  },

  cache: {
    enabled: true,
    maxAgeDays: 7,
    dir: '.git-agent/cache',
  },
};
