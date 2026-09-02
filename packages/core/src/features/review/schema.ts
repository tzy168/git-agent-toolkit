import { z } from 'zod';

export const ReviewIssueSchema = z.object({
  file: z.string().min(1),
  /** 问题所在行（新文件侧行号）；文件级问题可为 null */
  line: z.number().int().positive().nullable(),
  category: z.string().min(1),
  severity: z.enum(['blocker', 'major', 'minor', 'nit']),
  title: z.string().min(1),
  detail: z.string().min(1),
  /** 修改建议；吹毛求疵可空串 */
  suggestion: z.string(),
  confidence: z.enum(['high', 'medium', 'low']),
});

export const ChunkIssuesSchema = z.object({
  issues: z.array(ReviewIssueSchema),
});

export const OutlineSchema = z.object({
  /** 大 diff 挑出的重点文件路径（posix） */
  focusFiles: z.array(z.string().min(1)).min(1),
});

export const CrossFileIssueSchema = z.object({
  title: z.string().min(1),
  detail: z.string().min(1),
  files: z.array(z.string().min(1)).min(2),
});

export const CrossFileOutputSchema = z.object({
  crossFile: z.array(CrossFileIssueSchema),
});

export const ReviewOutputSchema = z.object({
  overview: z.string().min(1),
  /** 变更意图推断；必须有依据，不确定处标 [推断] */
  intent: z.string().min(1),
  issues: z.array(ReviewIssueSchema),
  risks: z.array(z.string()),
  highlights: z.array(z.string()),
  questions: z.array(z.string()),
  /** Pass C 产出；文件数 ≤ 3 时为空 */
  crossFile: z.array(CrossFileIssueSchema),
});

export type ReviewIssue = z.infer<typeof ReviewIssueSchema>;
export type CrossFileIssue = z.infer<typeof CrossFileIssueSchema>;
export type CrossFileOutput = z.infer<typeof CrossFileOutputSchema>;
export type OutlineOutput = z.infer<typeof OutlineSchema>;
export type ReviewOutput = z.infer<typeof ReviewOutputSchema>;
