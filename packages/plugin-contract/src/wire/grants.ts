/**
 * Grant snapshot types — GrantSnapshot for SessionBinding and host.grants.changed.
 * Mechanized verbatim from #1165 frozen shape.
 *
 * GrantSnapshot represents the effective capability set at a point in time.
 * It appears in two locations:
 *   - SessionBinding (initial grant state at handshake)
 *   - host.grants.changed notification (runtime grant mutations)
 *
 * grantRevision is strictly monotonic per plugin instance — the Host
 * increments it on every grant mutation. A plugin that observes
 * revision N may discard any notification with revision < N.
 */

import type { Capability } from '../generated/contract.generated.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum number of items in effectiveGrants.
 * Derived from the 17-value Capability enum — a plugin cannot hold
 * more capabilities than exist.
 */
export const MAX_GRANT_ITEMS = 17 as const;

// ---------------------------------------------------------------------------
// GrantSnapshot
// ---------------------------------------------------------------------------

/**
 * GrantSnapshot captures a versioned capability set.
 *
 * Used in SessionBinding (handshake) and host.grants.changed (notification).
 * The two fields are always paired and always travel together.
 */
export interface GrantSnapshot {
  /**
   * WireUInt53(0, 9_007_199_254_740_991).
   * Monotonically increasing per plugin instance.
   * The Host is the sole writer; plugins observe only.
   */
  readonly grantRevision: number;
  /**
   * Unique Capability[], 0..17 items.
   * Duplicates are a protocol violation (Host guarantees uniqueness).
   * Empty array is valid (plugin has no capabilities).
   */
  readonly effectiveGrants: readonly Capability[];
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

/**
 * Validate that effectiveGrants contains no duplicates and
 * does not exceed MAX_GRANT_ITEMS.
 */
export function validateEffectiveGrants(grants: readonly Capability[]): boolean {
  if (grants.length > MAX_GRANT_ITEMS) return false;
  return new Set(grants).size === grants.length;
}
