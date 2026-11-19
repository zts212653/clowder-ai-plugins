import { z } from 'zod';
import { entityProvenanceSchema } from './entity-provenance.js';
import { hardForgetActionSchema, memoryOwnerRequestIdSchema, memoryOwnerRevisionSchema, ownerActionBase, retireActionSchema } from './owner-actions.js';
export { entityProvenanceSchema, type EntityProvenance } from './entity-provenance.js';

export type EntityType = 'person' | 'cat' | 'feature' | 'concept' | 'external';

/**
 * F260 stance enum — includes negative values for critique targets.
 * endorsed: canonical positive entity
 * rejected: explicitly rejected name/concept (future: auto-flag)
 * critique_target: entity under critique (e.g. "六边形架构" as critique subject)
 * deliverable_only: entity that is a deliverable, not a concept
 * unknown: default, no stance determined
 */
export const ENTITY_STANCES = Object.freeze([
  'endorsed',
  'rejected',
  'critique_target',
  'deliverable_only',
  'unknown',
] as const);

export type EntityStance = (typeof ENTITY_STANCES)[number];

/** Visibility scope — workspace-wide or private to an owner. */
export const ENTITY_VISIBILITY_SCOPES = Object.freeze(['workspace'] as const);

export type EntityVisibilityScope = 'workspace' | `private:${string}`;

export type EntityProposalStatus = 'pending' | 'approved' | 'rejected';

/** Why an entity proposal cannot be approved as a plain create/update. */
export type EntityConflictReason = 'existing-entity-change' | 'surface-collision';

/** Explicit mutations offered by the F260 conflict-resolution UI. */
export const ENTITY_CONFLICT_RESOLUTION_ACTIONS = Object.freeze([
  'merge-aliases',
  'replace',
  'correct',
  'transfer',
  'polysemy',
] as const);

export type EntityConflictResolutionAction = (typeof ENTITY_CONFLICT_RESOLUTION_ACTIONS)[number];

/**
 * Privacy-minimal entity projection used for conflict decisions.
 * Provenance bodies stay server-side; the operator only receives fields needed to
 * compare current truth with the proposal.
 */
export interface EntityConflictRecord {
  entityId: string;
  entityType: EntityType;
  canonicalName: string;
  aliases: string[];
  stance: string;
  visibilityScope: string;
  status: string;
  updatedAt?: string;
}

/** Derived, refresh-safe conflict context shown by the Approval Hub. */
export interface EntityConflictContext {
  version: 1;
  reason: EntityConflictReason;
  fingerprint: string;
  incoming: EntityConflictRecord;
  candidates: EntityConflictRecord[];
  conflictingSurfaces: string[];
  canonicalReplacementRequiredFor: string[];
  allowedActions: Array<EntityConflictResolutionAction | 'reject'>;
}

/** Body accepted by POST /api/entity-proposals/:proposalId/resolve. */
export interface EntityConflictResolutionRequest {
  action: EntityConflictResolutionAction;
  fingerprint: string;
  replacementCanonicalNames?: Record<string, string>;
}

const entityCorrectionPatchSchema = z
  .object({
    entityType: z.enum(['person', 'cat', 'feature', 'concept', 'external']).optional(),
    canonicalName: z.string().trim().min(1).max(200).optional(),
    aliases: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
    stance: z.enum(ENTITY_STANCES).optional(),
    visibilityScope: z.literal('workspace').optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, { message: 'Entity correction patch must not be empty' });
export type EntityMemoryCorrectionPatch = z.infer<typeof entityCorrectionPatchSchema>;

export const entityMemoryOwnerActionSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('correct'),
      ...ownerActionBase,
      patch: entityCorrectionPatchSchema,
    })
    .strict(),
  retireActionSchema,
  hardForgetActionSchema,
]);
export type EntityMemoryOwnerAction = z.infer<typeof entityMemoryOwnerActionSchema>;

const entityIdentity = z.object({ entityId: z.string().min(1).max(500) }).strict();
const storedEntity = entityIdentity.extend({
  type: z.enum(['person', 'cat', 'feature', 'concept', 'external']),
  canonicalName: z.string(),
  aliases: z.array(z.string()),
  provenance: entityProvenanceSchema.array(),
  stance: z.string(),
  visibilityScope: z.string(),
  status: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  revision: memoryOwnerRevisionSchema,
});
export type EntityMemoryRecord = z.infer<typeof storedEntity>;
export const entityDispatchSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('entity.list'), input: z.object({}).strict() }).strict(),
  z.object({ operation: z.literal('entity.get'), input: entityIdentity }).strict(),
  z.object({ operation: z.literal('entity.mutate'), input: entityIdentity.extend({
    command: entityMemoryOwnerActionSchema, updatedAt: z.number().finite(),
  }) }).strict(),
  z.object({ operation: z.literal('entity.action_evidence'), input: entityIdentity.extend({
    requestId: memoryOwnerRequestIdSchema,
  }) }).strict(),
]);
export type EntityDispatchInput = z.infer<typeof entityDispatchSchema>;
export const entityOutputSchemas = {
  'entity.list': storedEntity.array(),
  'entity.get': storedEntity.nullable(),
  'entity.mutate': z.union([
    z.object({ outcome: z.literal('applied'), entity: storedEntity }),
    z.object({ outcome: z.enum(['forgotten', 'not_available', 'stale_revision', 'conflict']) }),
  ]),
  'entity.action_evidence': z.object({
    action: z.enum(['correct', 'retire', 'hard_forget']),
    revision: z.string().optional(),
    status: z.enum(['active', 'retired']).optional(),
  }).nullable(),
} satisfies Record<EntityDispatchInput['operation'], z.ZodType>;

export type EntityMemoryMutation = z.infer<(typeof entityOutputSchemas)['entity.mutate']>;
export type EntityActionEvidence = z.infer<(typeof entityOutputSchemas)['entity.action_evidence']>;
