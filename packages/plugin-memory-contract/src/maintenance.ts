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

const projectPath = z.string().min(1);
const indexState = z.object({
  id: z.string(),
  project_path: projectPath,
  status: z.enum(['missing', 'stale', 'building', 'ready', 'failed']),
  fingerprint: z.string(),
  last_scan_at: z.string().nullable(),
  snoozed_until: z.string().nullable(),
  docs_indexed: count.nullable(),
  docs_total: count.nullable(),
  error_message: z.string().nullable(),
  summary_json: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
}).strict();
export type MemoryProjectIndexState = z.infer<typeof indexState>;

const projectIndexSettlement = z.discriminatedUnion('status', [
  z.object({ projectPath, status: z.literal('ready'), docsIndexed: count, summaryJson: z.string() }).strict(),
  z.object({ projectPath, status: z.literal('failed'), error: z.string() }).strict(),
]);
export const memoryProjectIndexRequest = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('index.project.read'),
    input: z.object({ projectPath, fingerprint: z.string().optional() }).strict(),
  }).strict(),
  z.object({
    operation: z.literal('index.project.claim'),
    input: z.object({ projectPath, fingerprint: z.string() }).strict(),
  }).strict(),
  z.object({ operation: z.literal('index.project.settle'), input: projectIndexSettlement }).strict(),
  z.object({ operation: z.literal('index.project.snooze'), input: z.object({ projectPath }).strict() }).strict(),
]);
export type MemoryProjectIndexRequest = z.infer<typeof memoryProjectIndexRequest>;
export const memoryProjectIndexResponses = {
  'index.project.read': indexState,
  'index.project.claim': z.boolean(),
  'index.project.settle': z.null(),
  'index.project.snooze': z.string(),
} satisfies Record<MemoryProjectIndexRequest['operation'], z.ZodType>;
