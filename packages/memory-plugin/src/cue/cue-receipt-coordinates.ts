import { z } from 'zod';
import { recallScopeV1Schema } from '@clowder-ai/plugin-memory-contract/matter';

export const RECALL_OPPORTUNITY_CATALOG_VERSION = 9 as const;

export const RECALL_RESOLVER_FAMILIES = [
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

export type RecallResolverFamily = (typeof RECALL_RESOLVER_FAMILIES)[number];

const MEMORY_CUE_DRILL_FAMILY_BY_RESOLVER = Object.freeze({
  person_entity: 'person_memory' as const,
  operational_precedent: 'evidence' as const,
  taste: 'taste' as const,
  profile: 'profile' as const,
  event: 'event' as const,
  decision: 'evidence' as const,
  project_knowledge: 'evidence' as const,
  cat_owned_seed: 'owned_seed' as const,
  thread_overview: 'thread_overview' as const,
  matter: 'matter' as const,
  message_evidence: 'evidence' as const,
});

export function memoryCueDrillFamilyForResolver(
  resolverFamily: RecallResolverFamily,
): MemoryCueDrillCoordinate['family'] {
  return MEMORY_CUE_DRILL_FAMILY_BY_RESOLVER[resolverFamily];
}

const identifierSchema = z.string().trim().min(1).max(500);

export const memoryCueDrillCoordinateSchema = z
  .object({
    cueId: identifierSchema,
    opportunityId: identifierSchema,
    catalogVersion: z.literal(RECALL_OPPORTUNITY_CATALOG_VERSION),
    resolverFamily: z.enum(RECALL_RESOLVER_FAMILIES),
    resolverVersion: z.number().int().positive(),
    family: z.enum([
      'person_memory',
      'evidence',
      'taste',
      'profile',
      'event',
      'owned_seed',
      'thread_overview',
      'matter',
    ]),
    anchor: identifierSchema,
    revision: identifierSchema,
    scope: recallScopeV1Schema,
    consumerCatId: z.string().trim().min(1).max(120).optional(),
    expiresAt: z.number().int().nonnegative().finite(),
  })
  .strict();

export type MemoryCueDrillCoordinate = z.infer<typeof memoryCueDrillCoordinateSchema>;
