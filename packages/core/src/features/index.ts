import { register } from './registry.js';
import { commitFeature } from './commit/index.js';
import { impactFeature } from './impact/index.js';
import { prDescFeature } from './pr-desc/index.js';
import { reviewFeature } from './review/index.js';
import { specFeature } from './spec/index.js';
import { testPlanFeature } from './test-plan/index.js';
import { weeklyFeature } from './weekly/index.js';

/** 注册本包已实现的 Feature；CLI 启动时调一次 */
export function registerAll(): void {
  register(commitFeature);
  register(weeklyFeature);
  register(reviewFeature);
  register(testPlanFeature);
  register(impactFeature);
  register(prDescFeature);
  register(specFeature);
}

export { register, getFeature, listFeatures } from './registry.js';
export type { Feature, FeatureContext, ParamDef, PromptStep, SingleStep } from './registry.js';
export { runPipeline, previewPrompts } from './pipeline.js';
export type { PipelineResult } from './pipeline.js';
export { commitFeature } from './commit/index.js';
export { formatCommitMessage } from './commit/schema.js';
export type { CommitCandidate, CommitOutput } from './commit/schema.js';
export { weeklyFeature } from './weekly/index.js';
export { findLastWeeklyReport } from './weekly/history.js';
export type { WeeklyInput, WeeklyOutput, WorkItem } from './weekly/index.js';
