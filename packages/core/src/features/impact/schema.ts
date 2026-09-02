import { z } from 'zod';

/** 单个引用点的影响判定（yes/no/unknown，unknown 渲染成 [待确认]） */
export const ImpactPointSchema = z.object({
  location: z.string().min(1),
  symbol: z.string().min(1),
  needsChange: z.enum(['yes', 'no', 'unknown']),
  reason: z.string().min(1),
});

export const ImpactOutputSchema = z.object({
  overview: z.string().min(1),
  impacts: z.array(ImpactPointSchema),
  /** 建议回归路径（文件或场景） */
  regressionPaths: z.array(z.string()),
  /** 判不了的项，报告里逐条列出等人工确认 */
  confirmations: z.array(z.string()),
  notes: z.string(),
});

export type ImpactPoint = z.infer<typeof ImpactPointSchema>;
export type ImpactOutput = z.infer<typeof ImpactOutputSchema>;
