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
import {
  L0_CAPABILITIES,
  L1_CAPABILITIES,
  L2_CAPABILITIES,
} from '../generated/contract.generated.js';

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
 * Frozen set of all valid Capability values, derived from the generated
 * L0/L1/L2 capability arrays. Used for closed-enum membership checks.
 */
export const VALID_CAPABILITIES: ReadonlySet<string> = new Set<string>([
  ...L0_CAPABILITIES,
  ...L1_CAPABILITIES,
  ...L2_CAPABILITIES,
]);

/**
 * Validate that effectiveGrants:
 *   1. Does not exceed MAX_GRANT_ITEMS (17).
 *   2. Contains no duplicates.
 *   3. Contains only valid Capability enum members (closed-enum check).
 *
 * Fail-closed: any unrecognized capability value returns false.
 * This is an authorization boundary — fail-open would allow
 * uncontrolled privilege escalation.
 */
export function validateEffectiveGrants(grants: readonly string[]): boolean {
  if (grants.length > MAX_GRANT_ITEMS) return false;
  const seen = new Set<string>();
  for (const g of grants) {
    if (!VALID_CAPABILITIES.has(g)) return false; // unknown capability
    if (seen.has(g)) return false;                // duplicate
    seen.add(g);
  }
  return true;
}
