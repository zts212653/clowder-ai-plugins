/**
 * P-1a wire bounds — the public/internal split (#1165 revision 3,
 * maintainer R3 P1#5) and the frozen-compatible bounding rule (R3 P1#4).
 *
 * PUBLIC schema bounds are fixed by co-sign: any change is a reviewed
 * shape delta that reopens the gate. INTERNAL budgets are generator/
 * assembler values that may change under proof without touching the
 * public schema. Issued entitlements bind an immutable shape/budget
 * digest — a budget change invalidates continuation, never silently
 * alters replay output.
 *
 * Frozen-compatible rule: fields K-1 has historically admitted keep
 * exactly their frozen bounds (or no per-field bound where frozen has
 * none — the byte ceilings govern); only contract-minted wire fields
 * with no historical data carry new exact bounds.
 */

export interface StringBound {
  readonly minLength: 1;
  readonly maxLength: number;
}

/** PUBLIC — contract-minted wire fields (no historical data exists). */
export const CONTRACT_MINTED_BOUNDS = {
  /** Read-page / snapshot tokens and entitlement carriers. */
  ackToken: { minLength: 1, maxLength: 512 },
  pageToken: { minLength: 1, maxLength: 512 },
  nextPageToken: { minLength: 1, maxLength: 512 },
  snapshotAckToken: { minLength: 1, maxLength: 512 },
  /** Handshake / lifecycle contract-minted tokens (R22 sweep). */
  bindingNonce: { minLength: 1, maxLength: 512 },
  pingNonce: { minLength: 1, maxLength: 512 },
  /** Host-side business identities minted by this contract. */
  deliveryId: { minLength: 1, maxLength: 128 },
  /** Owner-specified in the R3 addendum MessagingAckRequest. */
  subscriptionId: { minLength: 1, maxLength: 128 },
} as const satisfies Record<string, StringBound>;

/** PUBLIC — page cardinality bounds (literal, frozen-aligned). */
export const PAGE_CARDINALITY_BOUNDS = {
  /** Read: aligned to frozen SubscriptionNormalResponse events maxItems. */
  readLimit: { min: 1, max: 32 },
  readEventsPerPage: { min: 1, max: 32 },
  /** Snapshot: intermediate 1..64, final 0..64 (empty snapshot = one empty final page). */
  snapshotMaxItems: { min: 1, max: 64 },
  snapshotItemsIntermediate: { min: 1, max: 64 },
  snapshotItemsFinal: { min: 0, max: 64 },
} as const;

/**
 * FROZEN byte ceilings (x-clowder-bounds, verbatim) — the exact wire
 * bound for frozen-unbounded fields and open payloads; enforced by the
 * K-1 semantic validator today, landed as generated wire validators.
 */
export const FROZEN_BYTE_CEILINGS = {
  maxElementPayloadBytes: 65_536,
  maxTotalPayloadBytes: 262_144,
} as const;

/** v0 framing hard cap (raw UTF-8 bytes excluding LF). */
export const MAX_FRAME_BYTES = 1_048_576 as const;

/**
 * INTERNAL assembler budgets — generator-derived; adjustable under proof
 * without a shape delta, provided every public bound and the
 * strictly-below-MAX_FRAME_BYTES proof still hold. NOT part of the
 * public schema.
 */
export const INTERNAL_ASSEMBLER_BUDGETS = {
  pageByteBudget: 786_432,
  maxSerializedItemBytes: 393_216,
} as const;
