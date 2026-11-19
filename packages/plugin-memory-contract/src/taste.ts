import { z } from 'zod';
import { hardForgetActionSchema, memoryOwnerRequestIdSchema, memoryOwnerRevisionSchema, ownerActionBase, retireActionSchema } from './owner-actions.js';
export type { MemoryLifecycleStatus } from './owner-actions.js';

export const TASTE_DIMENSIONS = [
  'relationship-stance',
  'cognitive-honesty',
  'architecture-aesthetics',
  'visual-quality',
  'authentic-expression',
  'system-philosophy',
  'creative-craft',
] as const;

const tasteCorrectionPatchSchema = z
  .object({
    takeaway: z.string().trim().min(1).max(500).nullable().optional(),
    quotes: z.array(z.string().trim().min(1).max(2_000)).max(16).optional(),
    scene: z.string().trim().min(1).max(8_000).optional(),
    tags: z.array(z.string().trim().min(1).max(160)).min(1).max(24).optional(),
    dimension: z.enum(TASTE_DIMENSIONS).optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, { message: 'Taste correction patch must not be empty' });
export type TasteMemoryCorrectionPatch = z.infer<typeof tasteCorrectionPatchSchema>;

export const MEMORY_CORRECTION_REASONS = ['unsupported_by_source', 'outdated', 'not_applicable_here'] as const;
export const memoryCorrectionReasonSchema = z.enum(MEMORY_CORRECTION_REASONS);
export type MemoryCorrectionReason = z.infer<typeof memoryCorrectionReasonSchema>;

const tasteVignetteAnchorSchema = z
  .string()
  .regex(/^taste-vignette:(?:docs\/taste\/vignettes|private\/taste)\/[\p{L}\p{N}][\p{L}\p{N}._-]*\.md$/u);

export const tasteMemoryCorrectionTargetSchema = z
  .object({
    sourceAnchor: tasteVignetteAnchorSchema,
    expectedRevision: memoryOwnerRevisionSchema,
    reason: memoryCorrectionReasonSchema,
    suggestedPatch: tasteCorrectionPatchSchema,
  })
  .strict();
export type TasteMemoryCorrectionTarget = z.infer<typeof tasteMemoryCorrectionTargetSchema>;

export const tasteMemoryCorrectionProposalInputSchema = z
  .object({
    target: tasteMemoryCorrectionTargetSchema,
    clientRequestId: memoryOwnerRequestIdSchema,
  })
  .strict();
export type TasteMemoryCorrectionProposalInput = z.infer<typeof tasteMemoryCorrectionProposalInputSchema>;

export const tasteMemoryOwnerActionSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('confirm_takeaway'),
      ...ownerActionBase,
      candidateRevision: memoryOwnerRevisionSchema,
      takeaway: z.string().trim().min(1).max(500),
    })
    .strict(),
  z
    .object({
      action: z.literal('correct'),
      ...ownerActionBase,
      patch: tasteCorrectionPatchSchema,
    })
    .strict(),
  retireActionSchema,
  hardForgetActionSchema,
]);
export type TasteMemoryOwnerAction = z.infer<typeof tasteMemoryOwnerActionSchema>;
export type TasteDimension = (typeof TASTE_DIMENSIONS)[number];

export interface TasteTakeawayCandidate {
  status: 'pending_owner_confirmation';
  takeaway: string;
  basedOnRevision: string;
  candidateRevision: string;
}

const tastePayload = z.object({
  when: z.string(),
  quotes: z.array(z.string()),
  takeaway: z.string().optional(),
  scene: z.string(),
  tags: z.array(z.string()),
  dimension: z.enum(TASTE_DIMENSIONS).optional(),
  catId: z.string().optional(),
  proposalId: z.string().optional(),
});
const tasteBrowseEntry = z.object({
  ownerUserId: z.string(),
  visibility: z.enum(['public', 'private']),
  sourcePath: z.string(),
  revision: memoryOwnerRevisionSchema,
  status: z.enum(['active', 'retired']),
  payload: tastePayload,
  takeawayCandidate: z.object({
    status: z.literal('pending_owner_confirmation'),
    takeaway: z.string(),
    basedOnRevision: memoryOwnerRevisionSchema,
    candidateRevision: memoryOwnerRevisionSchema,
  }).nullable(),
});
const tasteMemoryIdSchema = z.string().regex(/^taste-[0-9a-f]{24}$/u);
export const tasteBrowseDispatchSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('taste.list'), input: z.object({}).strict() }).strict(),
  z.object({
    operation: z.literal('taste.get'),
    input: z.object({ memoryId: tasteMemoryIdSchema }).strict(),
  }).strict(),
  z.object({
    operation: z.literal('taste.action_source'),
    input: z.object({ memoryId: tasteMemoryIdSchema }).strict(),
  }).strict(),
]);
export type TasteBrowseDispatchInput = z.infer<typeof tasteBrowseDispatchSchema>;
export type TasteBrowseEntry = z.infer<typeof tasteBrowseEntry>;
export const tasteBrowseOutputSchemas = {
  'taste.list': tasteBrowseEntry.array(),
  'taste.get': tasteBrowseEntry.nullable(),
  'taste.action_source': z.string().nullable(),
} satisfies Record<TasteBrowseDispatchInput['operation'], z.ZodType>;
