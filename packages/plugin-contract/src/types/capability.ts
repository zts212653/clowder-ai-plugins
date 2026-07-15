/**
 * Capability table — three-layer authorization model (G-0 件 2).
 *
 * @candidate  Layer assignments are candidate values awaiting co-sign.
 *             Structure (L0/L1/L2 semantics) is from merged proposal §3.3.
 *             DO NOT consume these values in any implementation until
 *             published — five-step freeze flow (roadmap §0 原则 2).
 *
 * @packageDocumentation
 */

// ---------------------------------------------------------------------------
// Authorization layer definitions (§3.3 + G-0 件 2)
// ---------------------------------------------------------------------------

/**
 * L0 — install-time, no confirmation needed.
 * Minimal sandbox: own config, own state, lifecycle hooks.
 */
export const L0_CAPABILITIES = [
  'plugin.config.read',
  'plugin.state.get',
  'plugin.state.set',
  // lifecycle callbacks (onLifecycle) are implicit — not a grant
] as const;

/**
 * L1 — declared in manifest + one-time install confirmation.
 * Listed on install summary page; user confirms once.
 *
 * Note (G-0 件 2 注 1): first-party preset grants cover L1 (skip install
 * confirmation), but all presets are STILL visible in UI and individually
 * revocable (P14/P13).
 *
 * Note (G-0 件 2 注 2): `messaging.appendElements` at L1 only grants the
 * publish channel — actual invocation requires a legitimate messageHandle
 * (delivered via subscription or callback).  This does NOT bypass L2 content
 * read authorization.
 *
 * Note (G-0 件 2 注 3): dual-gate for probe signals — `events.publish` (L1)
 * governs the publish channel; Tier 0/1 authorization governs the collection
 * source.  Two independent gates; revoking either cuts the flow.
 */
export const L1_CAPABILITIES = [
  'messaging.send',
  'schedule.register',
  'events.publish',
  'messaging.appendElements',
] as const;

/**
 * L2 — explicit per-item authorization + individually revocable.
 * Independent authorization dialog, can be re-triggered at runtime.
 *
 * `onMessage` (callback) includes content read; scoped to own-created /
 * bound threads by default — global scope requires separate upgrade.
 * First-party has NO silent L2 channel (P14).
 */
export const L2_CAPABILITIES = [
  'onMessage',
  'message.event.subscribe',
  'secret.read',
  'thread.listMetadata',
  'thread.readContent',
  'memory.query',
  'memory.append',
  'memory.retrieve',
  'windows.create',
  'whisper.extend',
] as const;

// ---------------------------------------------------------------------------
// Aggregate types
// ---------------------------------------------------------------------------

export type L0Capability = (typeof L0_CAPABILITIES)[number];
export type L1Capability = (typeof L1_CAPABILITIES)[number];
export type L2Capability = (typeof L2_CAPABILITIES)[number];

/** Any capability known to the contract. */
export type Capability = L0Capability | L1Capability | L2Capability;

/** Authorization layer identifier. */
export type AuthorizationLayer = 'L0' | 'L1' | 'L2';

/**
 * Map a capability to its authorization layer.
 * Returns undefined for unknown capabilities (future-proof).
 */
export function getCapabilityLayer(cap: string): AuthorizationLayer | undefined {
  if ((L0_CAPABILITIES as readonly string[]).includes(cap)) return 'L0';
  if ((L1_CAPABILITIES as readonly string[]).includes(cap)) return 'L1';
  if ((L2_CAPABILITIES as readonly string[]).includes(cap)) return 'L2';
  return undefined;
}

/**
 * The full capability table as a structured object.
 * @candidate — do not consume until published.
 */
export const CAPABILITY_TABLE = {
  L0: L0_CAPABILITIES,
  L1: L1_CAPABILITIES,
  L2: L2_CAPABILITIES,
} as const;
