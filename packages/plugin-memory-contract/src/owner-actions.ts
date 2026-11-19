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

export const ownerActionBase = {
  requestId: memoryOwnerRequestIdSchema,
  expectedRevision: memoryOwnerRevisionSchema,
};

export const hardForgetActionSchema = z
  .object({
    action: z.literal('hard_forget'),
    ...ownerActionBase,
    confirmed: z.literal(true),
  })
  .strict();

export const retireActionSchema = z
  .object({
    action: z.literal('retire'),
    ...ownerActionBase,
  })
  .strict();
