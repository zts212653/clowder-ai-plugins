/**
 * Per-row input/result shapes for the 12-row method registry.
 * Mechanized from #1165 frozen shape.
 *
 * CLOSED rows (5, 7, 10, 11, 12): full executable shapes with bounds.
 * RESERVED rows (1, 2, 3, 4, 6, 8, 9): type stubs only — no executable
 * contract may be exported until the row's matrix entries close.
 *
 * Each closed row's shape is additionalProperties: false.
 * Bounds constants are provided for runtime validation.
 */

import type { Capability } from '../generated/contract.generated.js';
import type { GrantSnapshot } from './grants.js';
import type {
  BrokerReadyParams,
  CandidateHello,
  SessionBinding,
} from './handshake.js';

// ═══════════════════════════════════════════════════════════════════════════
// Row 5 — messaging.subscribe (CLOSED leaf shape)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Row 5 input: subscribe to a handle for event delivery.
 * Wire shape: `{ handle: string }` — additionalProperties: false.
 *
 * The handle is a reference identifier (1..256 code points, M4 CLOSED).
 * The peer responds with a subscriptionId for subsequent read/ack calls.
 */
export interface SubscribeInput {
  /** M4 CLOSED — 1..256 code points. */
  readonly handle: string;
}

/**
 * Row 5 result: the created subscription identifier.
 * Wire shape: `{ subscriptionId: string }` — additionalProperties: false.
 */
export interface SubscribeResult {
  /** M4 CLOSED — 1..128 code points. */
  readonly subscriptionId: string;
}

/** Minimum code-point length for subscribe handle. */
export const SUBSCRIBE_HANDLE_MIN_LENGTH = 1 as const;

/** Maximum code-point length for subscribe handle. */
export const SUBSCRIBE_HANDLE_MAX_LENGTH = 256 as const;

/**
 * Maximum compact-JSON encoded bytes for subscribe handle.
 * Worst case: every code point is a 6-byte escape (\uXXXX).
 * 6 * 256 + 2 quotes = 1538 bytes.
 */
export const SUBSCRIBE_HANDLE_MAX_ENCODED_BYTES = 1538 as const;

/** Minimum code-point length for subscriptionId. */
export const SUBSCRIBE_SUBSCRIPTION_ID_MIN_LENGTH = 1 as const;

/** Maximum code-point length for subscriptionId. */
export const SUBSCRIBE_SUBSCRIPTION_ID_MAX_LENGTH = 128 as const;

/**
 * Maximum compact-JSON encoded bytes for subscriptionId.
 * 6 * 128 + 2 quotes = 770 bytes.
 */
export const SUBSCRIBE_SUBSCRIPTION_ID_MAX_ENCODED_BYTES = 770 as const;

// ═══════════════════════════════════════════════════════════════════════════
// Row 7 — messaging.ack (CLOSED leaf shape)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Row 7 input: acknowledge consumed events on a subscription.
 * Wire shape: `{ subscriptionId, ackToken }` — additionalProperties: false.
 *
 * Closed shape per R3 addendum (owner-specified).
 */
export interface MessagingAckRequest {
  /** M4 CLOSED — 1..128 code points. */
  readonly subscriptionId: string;
  /** M4 CLOSED — 1..512 code points. */
  readonly ackToken: string;
}

/**
 * Row 7 result: null.
 * Ack is fire-and-confirm — a null result signals success.
 */
export type MessagingAckResult = null;

/** Minimum code-point length for ack subscriptionId. */
export const ACK_SUBSCRIPTION_ID_MIN_LENGTH = 1 as const;

/** Maximum code-point length for ack subscriptionId. */
export const ACK_SUBSCRIPTION_ID_MAX_LENGTH = 128 as const;

/**
 * Maximum compact-JSON encoded bytes for ack subscriptionId.
 * 6 * 128 + 2 quotes = 770 bytes.
 */
export const ACK_SUBSCRIPTION_ID_MAX_ENCODED_BYTES = 770 as const;

/** Minimum code-point length for ackToken. */
export const ACK_TOKEN_MIN_LENGTH = 1 as const;

/** Maximum code-point length for ackToken. */
export const ACK_TOKEN_MAX_LENGTH = 512 as const;

/**
 * Maximum compact-JSON encoded bytes for ackToken.
 * 6 * 512 + 2 quotes = 3074 bytes.
 */
export const ACK_TOKEN_MAX_ENCODED_BYTES = 3074 as const;

// ═══════════════════════════════════════════════════════════════════════════
// Row 10 — host.grants.changed (CLOSED leaf shape, NOTIFICATION)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Row 10 input: grant-change notification payload.
 *
 * This is a NOTIFICATION (no id, no response). In v0, row 10 is the
 * only legal notification — all other rows are request/response.
 *
 * The input shape is the GrantSnapshot defined in grants.ts:
 *   { grantRevision: WireUInt53, effectiveGrants: Capability[] 0..17 }
 *
 * additionalProperties: false. CLOSED.
 */
export type GrantsChangedInput = GrantSnapshot;

// Re-export GrantSnapshot for downstream convenience — consumers of
// row shapes should not need to import grants.ts separately.
export type { GrantSnapshot } from './grants.js';

// ═══════════════════════════════════════════════════════════════════════════
// Row 11 — host.lifecycle.ping (CLOSED leaf shape)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Row 11 input: liveness ping carrying a nonce.
 * Wire shape: `{ nonce: string }` — additionalProperties: false.
 *
 * The peer MUST echo the nonce verbatim in the result.
 */
export interface PingInput {
  /** M4 CLOSED — string 1..512 code points. */
  readonly nonce: string;
}

/**
 * Row 11 result: echo of the input nonce.
 * Wire shape: `{ nonce: string }` — additionalProperties: false.
 *
 * The nonce in the result MUST be byte-equal to the nonce in the input.
 */
export interface PingResult {
  /** Byte-equal echo of the input nonce. */
  readonly nonce: string;
}

/** Minimum code-point length for ping nonce. */
export const PING_NONCE_MIN_LENGTH = 1 as const;

/** Maximum code-point length for ping nonce. */
export const PING_NONCE_MAX_LENGTH = 512 as const;

/**
 * Maximum compact-JSON encoded bytes for ping nonce.
 * Worst case: every code point is a 6-byte escape (\uXXXX).
 * 6 * 512 + 2 quotes = 3074 bytes.
 */
export const PING_NONCE_MAX_ENCODED_BYTES = 3074 as const;

// ═══════════════════════════════════════════════════════════════════════════
// Row 12 — host.lifecycle.drain (CLOSED leaf shape)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Row 12 input: graceful drain with a drain-specific deadline.
 * Wire shape: `{ deadlineUnixMs: number }` — additionalProperties: false.
 *
 * Note: this deadlineUnixMs is the drain-specific deadline in
 * `params.input`, distinct from the request-level deadline in
 * `params.meta.deadlineUnixMs` (CallMeta). Both may coexist.
 *
 * W2 covers "row 12 `params.input.deadlineUnixMs`".
 */
export interface DrainInput {
  /**
   * Drain-specific deadline.
   * WireUInt53(1, 9_007_199_254_740_991) — same profile as CallMeta.
   */
  readonly deadlineUnixMs: number;
}

/**
 * Row 12 result: null.
 * Drain is fire-and-confirm — a null result signals the plugin
 * has completed its graceful shutdown sequence.
 */
export type DrainResult = null;

// ═══════════════════════════════════════════════════════════════════════════
// RESERVED rows — type stubs only
//
// No executable input/result contract may be exported for these rows
// until their matrix entries close. The `never` type ensures no code
// can accidentally construct or consume these shapes.
//
// Row numbering matches WIRE_METHOD_REGISTRY in registry.ts.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Row 1 — broker.hello: CLOSED in beta.8.
 *
 * Plugin → Host handshake. CandidateHello → SessionBinding.
 * See handshake.ts for structural types.
 * Candidate grammar and the Host-authoritative binding are closed by beta.8.
 */
export type HelloInput = CandidateHello;
export type HelloResult = SessionBinding;

/**
 * Row 2 — broker.ready: CLOSED in beta.8.
 *
 * Plugin → Host activation. The structural type (BrokerReadyParams)
 * is the executable input shape; success is a null JSON-RPC result.
 */
export type ReadyInput = BrokerReadyParams;
export type ReadyResult = null;

/**
 * Row 3 — messaging.send: RESERVED (M1/M2/M5/I1).
 *
 * Plugin → Host message send. The domain types (MessageDraft,
 * SendReceipt) exist in the generated contract types, but the wire
 * input/result shapes remain reserved until the row's matrix entries close.
 */
export type SendInput = never;
export type SendResult = never;

/**
 * Row 4 — messaging.appendElements: RESERVED (M1/M2/M5/I1).
 *
 * Plugin → Host element append. The domain types exist in the
 * generated contract types, but the wire input/result shapes remain
 * reserved until the row's matrix entries close.
 */
export type AppendInput = never;
export type AppendResult = never;

/**
 * Row 6 — messaging.read: RESERVED (M1/M2/M3/M4/M5/M6/M7/I1).
 *
 * Plugin → Host subscription read. The wire input/result shapes
 * remain reserved until the row's matrix entries close.
 */
export type ReadInput = never;
export type ReadResult = never;

/**
 * Row 8 — messaging.snapshot: RESERVED (M1/M2/M5/M7/I1).
 *
 * Plugin → Host snapshot request. The wire input/result shapes
 * remain reserved until the row's matrix entries close.
 */
export type SnapshotInput = never;
export type SnapshotResult = never;

/**
 * Row 9 — host.messaging.deliver: RESERVED (M1/M2/M5/M7/I1).
 *
 * Host → Plugin delivery push. The wire input/result shapes
 * remain reserved until the row's matrix entries close.
 */
export type DeliverInput = never;
export type DeliverResult = never;
