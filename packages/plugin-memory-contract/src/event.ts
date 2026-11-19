import { z } from 'zod';

export const EVENT_TRIGGERS = ['human_brake', 'cat_brake', 'cat_shout', 'flywheel_selffix', 'lesson_settle'] as const;
export const COGNITIVE_TRANSITIONS = [
  'user_brake', 'self_brake', 'coordinate_correction', 'capability_gap', 'scope_correction',
  'aha', 'repeated_need', 'harness_internalized', 'lesson_crystallized',
] as const;
export const EVENT_CONFIDENCES = ['high', 'mid', 'low'] as const;

const identifier = z.string().min(1);
const eventTrigger = z.enum(EVENT_TRIGGERS);
const cognitiveTransition = z.enum(COGNITIVE_TRANSITIONS);
const eventConfidence = z.enum(EVENT_CONFIDENCES);
const eventRecord = z.object({
  type: identifier,
  trigger: eventTrigger,
  cat: identifier,
  threadId: identifier,
  messageId: identifier,
  timestamp: z.number().finite(),
  summary: z.string(),
  cognitiveTransition: cognitiveTransition.nullable(),
  relatedHarness: z.array(z.string()).nullable(),
  confidence: eventConfidence,
});
const lifecycleStatus = z.enum(['active', 'retired']);
const storedEvent = eventRecord.extend({
  eventId: identifier,
  ownerUserId: identifier,
  status: lifecycleStatus,
  updatedAt: z.number().finite(),
});
export type EventMemoryRecord = z.infer<typeof eventRecord>;
export type EventTrigger = z.infer<typeof eventTrigger>;
export type CognitiveTransition = z.infer<typeof cognitiveTransition>;
export type EventConfidence = z.infer<typeof eventConfidence>;
export type StoredEventMemoryLifecycle = z.infer<typeof storedEvent>;
const eventList = z.object({
  trigger: eventTrigger.optional(), cat: identifier.optional(), type: identifier.optional(),
  threadId: identifier.optional(), confidence: eventConfidence.optional(),
  cognitiveTransition: cognitiveTransition.optional(), since: z.number().finite().optional(),
  until: z.number().finite().optional(), limit: z.number().int().min(1).optional(),
  offset: z.number().int().nonnegative().optional(),
}).strict();
const eventRead = z.object({ eventId: identifier }).strict();
const identityAndRevision = eventRead.extend({ expectedRevision: identifier, requestId: identifier });
const eventClearInput = identityAndRevision.extend({ updatedAt: z.number().finite() });
const eventCorrection = eventClearInput.extend({ patch: eventRecord.pick({
  summary: true, cognitiveTransition: true, relatedHarness: true, confidence: true,
}).partial().strict() });
const eventMutationResult = z.union([
  z.object({ outcome: z.literal('applied'), event: storedEvent }),
  z.object({ outcome: z.enum(['forgotten', 'not_available', 'stale_revision']) }),
]);

export const eventDispatchSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('event.mark'), input: eventRecord.strict() }).strict(),
  z.object({ operation: z.literal('event.list'), input: eventList }).strict(),
  z.object({ operation: z.literal('event.get'), input: eventRead }).strict(),
  z.object({ operation: z.literal('event.by_coordinate'), input: eventRecord.pick({ threadId: true, messageId: true }).strict() }).strict(),
  z.object({ operation: z.literal('event.correct'), input: eventCorrection }).strict(),
  z.object({ operation: z.literal('event.retire'), input: eventClearInput }).strict(),
  z.object({ operation: z.literal('event.forget'), input: identityAndRevision }).strict(),
  z.object({ operation: z.literal('event.action_evidence'), input: identityAndRevision.omit({ expectedRevision: true }) }).strict(),
]);

export type EventDispatchInput = z.infer<typeof eventDispatchSchema>;

export const eventOutputSchemas = {
  'event.mark': z.union([
    z.object({ event: storedEvent, inserted: z.boolean(), suppressed: z.literal(false).optional() }),
    z.object({ event: z.null(), inserted: z.literal(false), suppressed: z.literal(true) }),
  ]),
  'event.list': storedEvent.array(),
  'event.get': storedEvent.nullable(),
  'event.by_coordinate': storedEvent.array(),
  'event.correct': eventMutationResult,
  'event.retire': eventMutationResult,
  'event.forget': eventMutationResult,
  'event.action_evidence': z.object({
    action: z.enum(['correct', 'retire', 'hard_forget']), revision: identifier.optional(), status: lifecycleStatus.optional(),
  }).nullable(),
} satisfies Record<EventDispatchInput['operation'], z.ZodType>;
