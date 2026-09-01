export type { ExitCode, LogLevel, Logger, ProgressEvent, RepoInfo, UsageTotals } from './types.js';
export type { CollectedData, CollectKind, DiffChunk, DiffScale, DiffStats, FileChange, FileStatus, Hunk } from './types.js';
export { GitAgentError, ERROR_CODES, isGitAgentError, toGitAgentError } from './errors.js';
export { createLogger, noopLogger } from './logger.js';
export { absPosix, extOf, relativeTo, safeBranchName, samePath, toPosix, topDirs } from './paths.js';

export { loadConfig, loadEnvFiles, mergeConfigs, DEFAULT_CONFIG, MODEL_FAST, MODEL_STRONG, validateConfig } from './config/index.js';
export type { GitAgentConfig, LoadConfigOptions, ResolvedConfig } from './config/index.js';

export { createDiskCache } from './cache/index.js';
export type { DiskCache } from './cache/index.js';

export { createRedactor, redactFiles } from './redact/index.js';
export type { Redactor } from './redact/index.js';

export { composePrompt, loadPrompt, loadShared } from './prompt/index.js';

export { createLLMProvider } from './llm/index.js';
export type { LLMProvider, LLMRequest, LLMResponse } from './llm/index.js';

export { createGitProvider } from './git/index.js';
export type { CommitInfo, GitProvider } from './git/index.js';

export { parseDiff, filterFiles, splitIntoChunks, gradeScale } from './diff/index.js';

export { registerAll, register, getFeature, listFeatures, runPipeline, previewPrompts, commitFeature, formatCommitMessage } from './features/index.js';
export type { Feature, FeatureContext, PipelineResult, CommitOutput, CommitCandidate, SingleStep } from './features/index.js';

export { resolveOutputPath, writeReport, printSummary } from './output/index.js';
