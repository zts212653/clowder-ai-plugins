import { z } from 'zod';

export const memoryOwnerRevisionSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const memoryOwnerRequestIdSchema = z
  .string()
  .trim()
  .min(32)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const MEMORY_LIFECYCLE_STATUSES = ['active', 'retired'] as const;
export type MemoryLifecycleStatus = (typeof MEMORY_LIFECYCLE_STATUSES)[number];

const ownerActionBase = {
  requestId: memoryOwnerRequestIdSchema,
  expectedRevision: memoryOwnerRevisionSchema,
};

const hardForgetActionSchema = z
  .object({
    action: z.literal('hard_forget'),
    ...ownerActionBase,
    confirmed: z.literal(true),
  })
  .strict();

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

export const profileDispatchSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('profile.list'), input: z.object({}).strict() }).strict(),
  z.object({ operation: z.literal('profile.get'), input: profileIdentity }).strict(),
  z.object({ operation: z.literal('profile.mutate'), input: profileIdentity.extend({ command: profileMemoryOwnerActionSchema }) }).strict(),
  z.object({ operation: z.literal('profile.action_evidence'), input: profileIdentity.extend({ requestId: memoryOwnerRequestIdSchema }) }).strict(),
]);

export type ProfileDispatchInput = z.infer<typeof profileDispatchSchema>;

export const profileOutputSchemas = {
  'profile.list': profileEntrySchema.array(),
  'profile.get': profileEntrySchema.nullable(),
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
