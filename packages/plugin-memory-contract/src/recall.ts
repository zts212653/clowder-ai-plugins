import { z } from 'zod';

const count = z.number().int().nonnegative();
export const memoryRecallStatsRequest = z.object({
  operation: z.literal('recall.stats'),
  input: z.object({
    threadIds: z.array(z.string().min(1)),
    from: count,
    to: count,
  }).strict().refine(({ from, to }) => from <= to, { message: 'Recall window ends before it starts' }),
}).strict();
export type MemoryRecallStatsRequest = z.infer<typeof memoryRecallStatsRequest>;

export const memoryRecallStatsResult = z.array(z.object({
  source: z.string(),
  surface: z.string().nullable(),
  presented: count,
  inspected: count.nullable(),
  used: count,
}).strict());
export type MemoryRecallStatsResult = z.infer<typeof memoryRecallStatsResult>;
