import type { CollectedData, UsageTotals } from '../types.js';

export interface JsonEnvelope<O> {
  feature: string;
  generatedAt: string;
  stats: CollectedData['stats'];
  commits: number;
  degraded: string[];
  output: O;
  usage: UsageTotals;
}

/** `--json` 输出的结构化包装；统计数字来自 data（不让模型算） */
export function toJsonEnvelope<O>(
  featureId: string,
  output: O,
  data: CollectedData,
  usage: UsageTotals,
): JsonEnvelope<O> {
  return {
    feature: featureId,
    generatedAt: new Date().toISOString(),
    stats: data.stats,
    commits: data.commits.length,
    degraded: data.degraded,
    output,
    usage,
  };
}
