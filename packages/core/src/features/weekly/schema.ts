import { z } from 'zod';

export const WorkItemSchema = z.object({
  title: z.string().min(1),
  /** 占本周工作量的大致百分比，0-100 */
  weightPercent: z.number().int().min(0).max(100),
  bullets: z.array(z.string()),
  status: z.enum(['done', 'in_progress', 'blocked']),
});

export const WeeklyOutputSchema = z.object({
  /** 一句话总结本周 */
  overview: z.string().min(1),
  workItems: z.array(WorkItemSchema).min(1),
  /** 遇到的问题 / 阻塞 */
  problems: z.array(z.string()),
  /** 下周计划 */
  nextWeek: z.array(z.string()),
  /** 需要的支持 / 协作 */
  needsSupport: z.array(z.string()),
  /** 人工补充内容，必须原样搬运，禁止改写 */
  manualNotes: z.string(),
});

export type WorkItem = z.infer<typeof WorkItemSchema>;
export type WeeklyOutput = z.infer<typeof WeeklyOutputSchema>;
