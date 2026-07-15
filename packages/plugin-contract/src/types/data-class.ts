/**
 * Data classification and lifecycle strategy types (§3.6).
 *
 * Core invariant: user-visible/recoverable data MUST be `retained` or
 * `ask-on-uninstall`.  Only `cache`/`ephemeral` may use `lifecycle`.
 * This constraint is enforced at install-time by the host (§3.6).
 *
 * @candidate  Values are structurally fixed from the merged proposal;
 *             specific dataClass enum members and strategy parameters
 *             await co-sign confirmation (G-0 件 3).
 *
 * @packageDocumentation
 */

// ---------------------------------------------------------------------------
// Data classification (§3.6 dataClass)
// ---------------------------------------------------------------------------

/**
 * Data class — determines which lifecycle strategies are legal.
 *
 * @candidate  Enum members from proposal §3.6; final values confirmed
 *             at G-0 co-sign.
 */
export type DataClass =
  | 'cache'
  | 'ephemeral'
  | 'user-authored'
  | 'derived-user-visible'
  | 'relationship'
  | 'interaction-history';

// ---------------------------------------------------------------------------
// Lifecycle strategy (§3.6 三选一)
// ---------------------------------------------------------------------------

/**
 * Data lifecycle strategy — developer declares per data-set.
 *
 * - `lifecycle`: removed when plugin uninstalled (ONLY for cache/ephemeral)
 * - `retained`: persists independently of plugin lifecycle (user-managed)
 * - `ask-on-uninstall`: user chooses at uninstall time
 */
export type DataStrategy = 'lifecycle' | 'retained' | 'ask-on-uninstall';

// ---------------------------------------------------------------------------
// Data declaration in manifest (§3.6)
// ---------------------------------------------------------------------------

/**
 * A data-set declaration in a plugin manifest.
 * The host validates (dataClass, strategy) pairs at install time.
 */
export interface DataDeclaration {
  /** Developer-chosen name for this data set. */
  readonly name: string;
  readonly dataClass: DataClass;
  readonly strategy: DataStrategy;
  /**
   * Schema version for this data set — plugin owns migration logic,
   * host owns atomic switch + rollback on failure (§3.6).
   */
  readonly schemaVersion?: string;
}

// ---------------------------------------------------------------------------
// Validation constraint (machine-checkable)
// ---------------------------------------------------------------------------

/**
 * Allowed (dataClass → strategy) combinations.
 *
 * Invariant (§3.6 + 家规 铁律 #5 "用户状态默认持久化"):
 * - cache / ephemeral → any strategy (lifecycle | retained | ask-on-uninstall)
 * - user-authored / derived-user-visible → retained | ask-on-uninstall ONLY
 * - relationship / interaction-history → retained | ask-on-uninstall ONLY
 *
 * The `lifecycle` strategy on user-visible/relationship data violates the
 * hard boundary: user state defaults to persistent, deletion is user opt-in.
 */
export const DATA_CLASS_ALLOWED_STRATEGIES: Record<DataClass, readonly DataStrategy[]> = {
  'cache': ['lifecycle', 'retained', 'ask-on-uninstall'],
  'ephemeral': ['lifecycle', 'retained', 'ask-on-uninstall'],
  'user-authored': ['retained', 'ask-on-uninstall'],
  'derived-user-visible': ['retained', 'ask-on-uninstall'],
  'relationship': ['retained', 'ask-on-uninstall'],
  'interaction-history': ['retained', 'ask-on-uninstall'],
} as const;

/**
 * Validate a (dataClass, strategy) pair.
 * Returns `true` if the combination is allowed.
 */
export function isValidDataClassStrategy(
  dataClass: DataClass,
  strategy: DataStrategy,
): boolean {
  const allowed = DATA_CLASS_ALLOWED_STRATEGIES[dataClass];
  return allowed.includes(strategy);
}
