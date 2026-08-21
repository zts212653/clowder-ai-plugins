/**
 * Stable identities for the canonical M0-C behavior fixture.
 *
 * The executable cases remain owned by the published JSON fixture. This
 * ordered ID projection lets SDK and Host conformance select that exact
 * matrix without copying its setup, operations, or oracles.
 */
export const M0C_BEHAVIOR_CASE_IDS = [
  'raw-thread-id-rejection',
  'system-audience-dual-rejection',
  'cross-instance-handle-rejection',
  'origin-forgery-rejection',
  'base-revision-conflict-zero-change',
  'stale-cursor-snapshot-roundtrip',
  'cross-subscription-ack-rejection',
  'reply-to-cross-thread-leakage',
  'epistemic-status-upgrade-rejection',
  'preset-l2-rejected',
  'preset-visible-revocable',
  'whisper-target-beyond-default-empty-grant-rejected',
  'append-without-grant-rejected',
  'denied-on-message-rejected',
  'permission-matrix-complete',
  'delete-replay-events-preserves-canonical-messages',
  'snapshot-without-grant-rejected',
  'foreign-replay-delete-rejected',
] as const;

export type M0CBehaviorCaseId = (typeof M0C_BEHAVIOR_CASE_IDS)[number];

/** Public package export containing the executable case data and oracles. */
export const M0C_BEHAVIOR_FIXTURE_EXPORT =
  '@clowder-ai/plugin-contract/fixtures/behavior/messaging/adversarial-invariants' as const;
