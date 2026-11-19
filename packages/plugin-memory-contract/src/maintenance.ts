import { z } from 'zod';

export const memoryIndexStatusRequest = z
  .object({
    operation: z.literal('index.status'),
    input: z.object({ generationId: z.enum(['g0', 'g1']) }).strict(),
  })
  .strict();
export type MemoryIndexStatusRequest = z.infer<typeof memoryIndexStatusRequest>;

const count = z.number().int().nonnegative();
export const memoryIndexStatusResult = z
  .object({
    docs_count: count,
    threads_count: count,
    passages_count: count,
    edges_count: count,
    vectors_count: count,
    passage_vectors_count: count,
    passageVectorsReadable: z.boolean(),
    generationQuarantined: z.boolean(),
    last_rebuild_at: z.string().nullable(),
    last_document_updated_at: z.string().nullable(),
    embedding_model: z.string().nullable(),
  })
  .strict();
export type MemoryIndexStatusResult = z.infer<typeof memoryIndexStatusResult>;
