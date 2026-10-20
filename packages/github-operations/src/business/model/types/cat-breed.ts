


// ── F032: Roster types for collaboration rules ─────────────────────────

/**
 * Roster entry for a single cat.
 * F032: Used for reviewer matching, availability tracking, and role checking.
 */
export interface RosterEntry {
  /** Family/species (ragdoll, maine-coon, siamese) */
  readonly family: string;
  /** Roles this cat can fulfill (architect, peer-reviewer, designer, etc.) */
  readonly roles: readonly string[];
  /** Whether this cat is the lead of its family */
  readonly lead: boolean;
  /** Whether this cat is available (has quota). co-creator 40 美刀教训！ */
  readonly available: boolean;
  /** co-creator's evaluation of this cat */
  readonly evaluation: string;
}

/** Map of catId → RosterEntry */
export type Roster = Record<string, RosterEntry>;

/**
 * Review policy configuration.
 * F032: Determines how reviewers are matched to authors.
 */
export interface ReviewPolicy {
  /** Require reviewer to be from a different family than author */
  readonly requireDifferentFamily: boolean;
  /** Prefer cats that are active in the current thread */
  readonly preferActiveInThread: boolean;
  /** Prefer lead cats when multiple candidates exist */
  readonly preferLead: boolean;
  /** Exclude cats with available: false (no quota) */
  readonly excludeUnavailable: boolean;
}
