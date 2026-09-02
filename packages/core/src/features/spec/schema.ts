import { z } from 'zod';

/** 决策权衡：每条必须给出「不这么选的后果」 */
export const SpecDecisionSchema = z.object({
  decision: z.string().min(1),
  rationale: z.string().min(1),
  /** 不这么选的后果（必填，验收硬标准） */
  alternative: z.string().min(1),
  /** 出处 path:line */
  evidence: z.string().min(1),
});

/** outline step：挑重点文件 */
export const SpecOutlineSchema = z.object({
  focusFiles: z.array(z.string().min(1)).min(1),
  requirements: z.array(z.string()),
});

/** draft map step：每个重点分片的实现要点与决策 */
export const ChunkNotesSchema = z.object({
  files: z.array(z.string()),
  notes: z.array(z.string()),
  decisions: z.array(SpecDecisionSchema),
});

/** 八章结构 */
export const SpecOutputSchema = z.object({
  background: z.string().min(1),
  requirements: z.array(z.string()),
  design: z.string().min(1),
  implementation: z.array(z.string()),
  decisions: z.array(SpecDecisionSchema),
  impactScope: z.array(z.string()),
  risks: z.array(z.string()),
  acceptance: z.array(z.string()),
  notes: z.string(),
});

export type SpecDecision = z.infer<typeof SpecDecisionSchema>;
export type SpecOutlineOutput = z.infer<typeof SpecOutlineSchema>;
export type ChunkNotes = z.infer<typeof ChunkNotesSchema>;
export type SpecOutput = z.infer<typeof SpecOutputSchema>;
