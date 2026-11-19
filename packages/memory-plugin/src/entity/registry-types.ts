import type { EntityProvenance, EntityType } from '@clowder-ai/plugin-memory-contract/entity';
export type { EntityProvenance, EntityType } from '@clowder-ai/plugin-memory-contract/entity';

export const EVIDENCE_KINDS = [
  'feature',
  'decision',
  'plan',
  'session',
  'lesson',
  'thread',
  'discussion',
  'research',
  'architecture',
  'diary',
  'pack-knowledge',
] as const;

export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export type EvidenceStatus =
  | 'active'
  | 'done'
  | 'archived'
  | 'review'
  | 'invalidated'
  | 'superseded'
  | 'drifted'
  | 'stale'
  | 'historical'
  | 'retired';


export type ProvenanceTier = 'authoritative' | 'derived' | 'soft_clue';

export interface EntityRecord {
  entityId: string;
  type: EntityType;
  canonicalName: string;
  aliases: string[];
  provenance: EntityProvenance[];
  /** F260: entity stance from proposal approval (default 'unknown'). */
  stance?: string;
  /** F260: visibility scope from proposal approval (default 'workspace'). KD-7: private entities must carry through. */
  visibilityScope?: string;
  /** F260: entity lifecycle status (default 'active'). */
  status?: string;
  createdAt?: string;
  updatedAt: string;
}

export type EntityMutationSource = 'proposal-approval' | 'seed-sync' | 'system' | 'owner-action';

export interface EntityMutationContext {
  source: EntityMutationSource;
  actorId?: string;
  proposalId?: string;
  reason?: string;
  conflictPolicy?: 'allow-update' | 'reject-conflict' | 'owner-correction';
}

export interface QueryEntityMatch {
  entityId: string;
  type: EntityType;
  canonicalName: string;
  matchedAlias: string;
  provenance: EntityProvenance[];
  /** Exact hash of the current Entity projection; changes on correction or retirement. */
  sourceRevision: string;
}

export interface EntityMatch {
  entityId: string;
  type: EntityType;
  canonicalName: string;
  matchedAlias: string;
  surface: string;
  source: 'doc' | 'passage';
  docAnchor: string;
  passageId?: string;
  provenance: EntityProvenance[];
  why: string;
}
