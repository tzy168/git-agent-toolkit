import { z } from 'zod';

export const CommitCandidateSchema = z.object({
  type: z.string().min(1),
  scope: z.string().nullable(),
  subject: z.string().min(1),
  body: z.string(),
});

export const CommitOutputSchema = z.object({
  candidates: z.array(CommitCandidateSchema).min(1).max(10),
  splitHint: z.string().nullable().optional(),
});

export type CommitCandidate = z.infer<typeof CommitCandidateSchema>;
export type CommitOutput = z.infer<typeof CommitOutputSchema>;

/** 拼成 git commit -m 可用的完整信息 */
export function formatCommitMessage(c: CommitCandidate): string {
  const scope = c.scope ? `(${c.scope})` : '';
  const head = `${c.type}${scope}: ${c.subject}`;
  const body = c.body.trim();
  return body ? `${head}\n\n${body}` : head;
}
