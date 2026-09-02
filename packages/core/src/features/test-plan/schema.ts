import { z } from 'zod';

export const ChangePointSchema = z.object({
  /** 变更点标识：文件 + 行为变化，如 "src/foo.ts: bar() 新增重试" */
  changePoint: z.string().min(1),
  files: z.array(z.string().min(1)),
});

export const ChunkChangePointsSchema = z.object({
  changePoints: z.array(ChangePointSchema),
});

export const TestCaseSchema = z.object({
  changePoint: z.string().min(1),
  scenario: z.string().min(1),
  priority: z.enum(['P0', 'P1', 'P2']),
  type: z.enum(['unit', 'integration', 'manual']),
  /** 已有测试是否覆盖（对照 EXISTING TESTS 判断） */
  alreadyCovered: z.boolean(),
});

export const TestPlanOutputSchema = z.object({
  overview: z.string().min(1),
  cases: z.array(TestCaseSchema).min(1),
  /** 覆盖缺口：重要但没有用例的路径 */
  gaps: z.array(z.string()),
  notes: z.string(),
});

export type ChangePoint = z.infer<typeof ChangePointSchema>;
export type ChunkChangePoints = z.infer<typeof ChunkChangePointsSchema>;
export type TestCase = z.infer<typeof TestCaseSchema>;
export type TestPlanOutput = z.infer<typeof TestPlanOutputSchema>;
