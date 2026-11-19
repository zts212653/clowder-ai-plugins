import { z } from 'zod';
import { matterReadDetailsSchema } from './matter.js';

const count = z.number().int().nonnegative();
const window = z.object({ threadIds: z.array(z.string().min(1)), from: count, to: count }).strict();
const ordered = ({ from, to }: { from: number; to: number }) => from <= to;
export const memoryRecallStatsRequest = z.object({
  operation: z.literal('recall.stats'),
  input: window.refine(ordered, { message: 'Recall window ends before it starts' }),
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

export const memoryRecallTimelineRequest = z.object({
  operation: z.literal('recall.timeline'),
  input: window.extend({
    source: z.enum(['all', 'pull', 'push']),
    catId: z.string().min(1).max(120).optional(),
    limit: z.number().int().min(1).max(100),
    before: z.object({ at: count, key: z.string().min(1).max(4000) }).strict().optional(),
  }).refine((input) => ordered(input) &&
    (!input.before || (input.before.at >= input.from && input.before.at <= input.to)), {
    message: 'Recall cursor lies outside its time window',
  }),
}).strict();
export type MemoryRecallTimelineRequest = z.infer<typeof memoryRecallTimelineRequest>;

export const memoryRecallTimelineResult = z.array(z.object({
  key: z.string(),
  at: count,
  thread_id: z.string(),
  invocation_id: z.string(),
  cue_id: z.string().nullable(),
  recall_id: z.string().nullable(),
}).strict());
export type MemoryRecallTimelineResult = z.infer<typeof memoryRecallTimelineResult>;

export const memoryRecallEventRequest = z.object({
  operation: z.literal('recall.event'),
  input: z.object({ recallId: z.string().min(1), threadId: z.string().min(1) }).strict(),
}).strict();
export type MemoryRecallEventRequest = z.infer<typeof memoryRecallEventRequest>;

export const memoryRecallEventResult = z.object({
  recall_id: z.string(),
  cat_id: z.string(),
  invocation_id: z.string(),
  source_event_id: z.string().nullable(),
  tool_name: z.string(),
  query: z.string(),
  mode: z.string().nullable(),
  scope: z.string().nullable(),
  candidates_json: z.string(),
  consumed_json: z.string(),
  result_count: count.nullable(),
  result_status: z.string().nullable(),
  timestamp: count,
  source: z.enum(['pull', 'push']),
  push_surface: z.string().nullable(),
  inspected: count,
}).strict().nullable();
export type MemoryRecallEvent = NonNullable<z.infer<typeof memoryRecallEventResult>>;

export const memoryRecallCandidateRequest = z.object({
  operation: z.literal('recall.candidate'),
  input: z.object({ anchor: z.string().min(1), kinds: z.array(z.string().min(1)).min(1) }).strict(),
}).strict();
export type MemoryRecallCandidateRequest = z.infer<typeof memoryRecallCandidateRequest>;

export const memoryRecallCandidateResult = z.object({ title: z.string(), kind: z.string() }).strict().nullable();
export type MemoryRecallCandidate = NonNullable<z.infer<typeof memoryRecallCandidateResult>>;

export const memoryCueResolverFamilies = [
  'person_entity',
  'operational_precedent',
  'taste',
  'profile',
  'event',
  'decision',
  'project_knowledge',
  'cat_owned_seed',
  'thread_overview',
  'matter',
  'message_evidence',
] as const;

export const memoryCueInvocationRequest = z.object({
  operation: z.literal('cue.invocation'),
  input: z.object({ threadId: z.string().min(1), invocationId: z.string().min(1) }).strict(),
}).strict();
export type MemoryCueInvocationRequest = z.infer<typeof memoryCueInvocationRequest>;

export const memoryCueInvocationResult = z.array(z.object({
  cueId: z.string(),
  resolverFamily: z.enum(memoryCueResolverFamilies),
  sourceAnchor: z.string(),
  sourceRevision: z.string(),
  consumerCatId: z.string(),
  source: z.enum(['push', 'pull']).optional(),
  readDetails: matterReadDetailsSchema.optional(),
  pushSurface: z.literal('profile_opening').optional(),
  status: z.enum(['applied', 'dismissed', 'drilled', 'presented_unreported', 'invalidated']),
  invalidationReason: z.enum(['source_corrected', 'source_forgotten', 'scope_revoked', 'superseded', 'expired']).nullable(),
  presentedAt: count,
  lastEventAt: count,
}).strict());
export type MemoryCueInvocationEntry = z.infer<typeof memoryCueInvocationResult>[number];
