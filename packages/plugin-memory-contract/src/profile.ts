import { z } from 'zod';
import { hardForgetActionSchema, memoryOwnerRequestIdSchema, memoryOwnerRevisionSchema, ownerActionBase } from './owner-actions.js';
import { profileUsageSummarySchema } from './profile-usage.js';
export type { ProfileUsageSummary } from './profile-usage.js';

export const profileMemoryOwnerActionSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('replace_content'),
      ...ownerActionBase,
      content: z.string().min(1).max(20_000),
    })
    .strict(),
  hardForgetActionSchema,
]);
export type ProfileMemoryOwnerAction = z.infer<typeof profileMemoryOwnerActionSchema>;

const profileEntrySchema = z.object({
  id: z.string().min(1).max(200),
  type: z.literal('profile'),
  layer: z.enum(['primer', 'corpus', 'capsule']),
  relationshipKey: z.string().nullable(),
  uri: z.string(),
  title: z.string(),
  status: z.literal('active'),
  revision: memoryOwnerRevisionSchema,
  content: z.string(),
  updatedAt: z.number().finite().optional(),
});
export type ProfileMemoryEntry = z.infer<typeof profileEntrySchema>;

const profileIdentity = z.object({ memoryId: z.string().min(1).max(200) }).strict();
const profileRevisionIdentity = profileIdentity.extend({ revision: memoryOwnerRevisionSchema });

const profileProvenanceCoordinate = z.object({
  label: z.string().optional(),
  threadId: z.string().optional(),
  messageId: z.string().optional(),
  occurredAt: z.number().finite().nullable(),
});
export type ProfileProvenanceCoordinate = z.infer<typeof profileProvenanceCoordinate>;

export const profileDispatchSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('profile.list'), input: z.object({}).strict() }).strict(),
  z.object({ operation: z.literal('profile.get'), input: profileIdentity }).strict(),
  z.object({ operation: z.literal('profile.provenance'), input: profileRevisionIdentity }).strict(),
  z.object({ operation: z.literal('profile.usage'), input: profileRevisionIdentity }).strict(),
  z.object({ operation: z.literal('profile.mutate'), input: profileIdentity.extend({ command: profileMemoryOwnerActionSchema }) }).strict(),
  z.object({ operation: z.literal('profile.action_evidence'), input: profileIdentity.extend({ requestId: memoryOwnerRequestIdSchema }) }).strict(),
]);

export type ProfileDispatchInput = z.infer<typeof profileDispatchSchema>;
const profileReadFailure = z.object({ outcome: z.enum(['not_available', 'stale_revision']) });

export const profileOutputSchemas = {
  'profile.list': profileEntrySchema.array(),
  'profile.get': profileEntrySchema.nullable(),
  'profile.provenance': z.union([
    z.object({ outcome: z.literal('found'), coordinates: profileProvenanceCoordinate.array() }),
    profileReadFailure,
  ]),
  'profile.usage': z.union([
    z.object({ outcome: z.literal('found'), usage: profileUsageSummarySchema }),
    profileReadFailure,
  ]),
  'profile.mutate': z.union([
    z.object({ outcome: z.literal('applied'), entry: profileEntrySchema }),
    z.object({ outcome: z.enum(['forgotten', 'not_available', 'stale_revision', 'idempotency_conflict', 'invalid_content']) }),
  ]),
  'profile.action_evidence': z.object({
    action: z.enum(['replace_content', 'hard_forget']),
    commandDigest: memoryOwnerRevisionSchema,
    applied: z.boolean(),
    revision: memoryOwnerRevisionSchema.optional(),
  }).nullable(),
} satisfies Record<ProfileDispatchInput['operation'], z.ZodType>;
