import type { ZodType } from 'zod';

import type { DiskCache } from '../cache/disk-cache.js';
import type { ResolvedConfig } from '../config/types.js';
import type { GitProvider } from '../git/types.js';
import type { LLMProvider, ModelTier, ThinkingMode } from '../llm/types.js';
import type { Redactor } from '../redact/redactor.js';
import type { CollectedData, ExitCode, Logger, ProgressEvent, RepoInfo } from '../types.js';

export type { ModelTier, ThinkingMode };
export type StepResults = Record<string, unknown>;

interface StepBase<S> {
  id: string;
  label?: string;
  /** 稳定前缀（system.md + 硬约束） */
  system: string;
  schema: ZodType<S>;
  model?: ModelTier;
  thinking?: ThinkingMode;
  maxOutputTokens?: number;
  runIf?(results: StepResults, data: CollectedData): boolean;
}

export interface SingleStep<S = unknown> extends StepBase<S> {
  kind: 'single';
  buildUser(results: StepResults, data: CollectedData, ctx: FeatureContext): string;
}

export interface MapStep<S = unknown> extends StepBase<S> {
  kind: 'map';
  mapOver(results: StepResults, data: CollectedData): unknown[];
  buildUserItem(item: unknown, index: number, results: StepResults, data: CollectedData, ctx: FeatureContext): string;
  concurrency?: number;
}

export type PromptStep = SingleStep<unknown> | MapStep<unknown>;

export interface ParamDef {
  flag: string;
  description: string;
  type: 'string' | 'boolean' | 'number' | 'string[]';
  default?: unknown;
}

export type ParamSchema = ParamDef[];

export interface FeatureContext {
  repo: RepoInfo;
  git: GitProvider;
  llm: LLMProvider;
  config: ResolvedConfig;
  logger: Logger;
  redactor: Redactor;
  cache: DiskCache;
  onProgress: (e: ProgressEvent) => void;
  /** CLI --dry-run：pipeline 只打印 prompt */
  dryRun: boolean;
  /** CLI --model 覆盖 */
  modelOverride?: string;
}

export interface Feature<I = any, O = any> {
  id: string;
  name: string;
  description: string;
  params: ParamSchema;
  collect(ctx: FeatureContext, input: I): Promise<CollectedData>;
  buildSteps(data: CollectedData, ctx: FeatureContext): PromptStep[];
  reduce?(results: StepResults, data: CollectedData, ctx: FeatureContext): O;
  outputSchema: ZodType<O>;
  render(output: O, ctx: FeatureContext, data: CollectedData): string;
  exitCode?(output: O): ExitCode;
}

const registry = new Map<string, Feature>();

/** 注册一个 Feature；同 id 重复注册以后者为准 */
export function register(f: Feature): void {
  registry.set(f.id, f);
}

/** 按命令名取 Feature */
export function getFeature(id: string): Feature | undefined {
  return registry.get(id);
}

/** 已注册 Feature 列表（稳定顺序：注册顺序） */
export function listFeatures(): Feature[] {
  return [...registry.values()];
}
