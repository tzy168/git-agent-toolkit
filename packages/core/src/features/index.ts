import { register } from './registry.js';
import { commitFeature } from './commit/index.js';

/** 注册本包已实现的 Feature；CLI 启动时调一次 */
export function registerAll(): void {
  register(commitFeature);
}

export { register, getFeature, listFeatures } from './registry.js';
export type { Feature, FeatureContext, ParamDef, PromptStep, SingleStep } from './registry.js';
export { runPipeline, previewPrompts } from './pipeline.js';
export type { PipelineResult } from './pipeline.js';
export { commitFeature } from './commit/index.js';
export { formatCommitMessage } from './commit/schema.js';
export type { CommitCandidate, CommitOutput } from './commit/schema.js';
