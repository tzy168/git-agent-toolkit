import type { ZodType } from 'zod';

import type { DiffChunk } from '../../types.js';
import type { CollectedData } from '../../types.js';
import type { FeatureContext, MapStep, ModelTier, SingleStep, StepResults, ThinkingMode } from '../registry.js';

export interface ChunkMapOptions<S> {
  id: string;
  label?: string;
  /** 稳定前缀；所有分片必须复用同一个字符串实例 */
  system: string;
  schema: ZodType<S>;
  /** 拼该片的 user 内容（diff 永远在末尾） */
  buildUser(chunk: DiffChunk, data: CollectedData, ctx: FeatureContext): string;
  model?: ModelTier;
  thinking?: ThinkingMode;
  concurrency?: number;
  /** 可选：按前序结果（如 outline 挑出的重点文件）筛选分片 */
  selectChunks?(results: StepResults, data: CollectedData): DiffChunk[];
}

/** 分片 map step 工厂：mapOver chunks 并发，system 字节一致 */
export function chunkMapStep<S>(o: ChunkMapOptions<S>): MapStep<S> {
  return {
    kind: 'map',
    id: o.id,
    label: o.label,
    system: o.system,
    schema: o.schema,
    model: o.model ?? 'fast',
    thinking: o.thinking ?? 'off',
    concurrency: o.concurrency,
    mapOver(results, data) {
      return o.selectChunks ? o.selectChunks(results, data) : data.chunks;
    },
    buildUserItem(item, _index, _results, data, ctx) {
      return o.buildUser(item as DiffChunk, data, ctx);
    },
  };
}

export interface SummaryStepOptions<S> {
  id: string;
  label?: string;
  system: string;
  schema: ZodType<S>;
  buildUser(results: StepResults, data: CollectedData, ctx: FeatureContext): string;
  model?: ModelTier;
  thinking?: ThinkingMode;
  maxOutputTokens?: number;
}

/** 单步汇总工厂（review Pass B / test-plan plan / pr-desc 等复用） */
export function summaryStep<S>(o: SummaryStepOptions<S>): SingleStep<S> {
  return {
    kind: 'single',
    id: o.id,
    label: o.label,
    system: o.system,
    schema: o.schema,
    model: o.model ?? 'strong',
    thinking: o.thinking ?? 'high',
    maxOutputTokens: o.maxOutputTokens,
    buildUser(results, data, ctx) {
      return o.buildUser(results, data, ctx);
    },
  };
}

/** 把非重点文件合并成一片"摘要级"分片（large 模式 outline 之后用） */
export function summaryChunk(data: CollectedData, focusFiles: string[], budget: number): DiffChunk | null {
  const wanted = new Set(focusFiles);
  const restPaths = data.files.filter((f) => !wanted.has(f.path)).map((f) => f.path);
  if (restPaths.length === 0) return null;
  const lines = restPaths.map((p) => {
    const f = data.files.find((x) => x.path === p)!;
    return `${f.status}\t${p}\t+${f.additions}\t-${f.deletions}`;
  });
  const text = `以下文件只做摘要级审查（未深挖）：\n${lines.join('\n')}`.slice(0, budget * 4);
  return {
    id: 'c-rest',
    module: '(其余文件)',
    paths: restPaths,
    text,
    estTokens: 10,
  };
}
