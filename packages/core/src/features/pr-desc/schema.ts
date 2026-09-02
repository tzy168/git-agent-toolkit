import { z } from 'zod';

/** 模板章节的动态填充：heading 必须来自模板，模型不得新造章节 */
export const PrSectionSchema = z.object({
  heading: z.string().min(1),
  body: z.string().min(1),
});

export const PrDescOutputSchema = z.object({
  title: z.string().min(1),
  sections: z.array(PrSectionSchema).min(1),
  notes: z.string(),
});

export type PrSection = z.infer<typeof PrSectionSchema>;
export type PrDescOutput = z.infer<typeof PrDescOutputSchema>;
