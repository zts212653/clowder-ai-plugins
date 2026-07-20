/**
 * Disposition conformance fixture vectors — machine-readable test data
 * for the pre-dispatch disposition table (T-A through T-L).
 *
 * Mechanized from §3.8-1 of the #1165 frozen plan. Each vector carries:
 *   - A raw frame (the input to a pre-dispatch classifier)
 *   - The expected unique T-class assignment
 *   - For respond classes: the expected closed-arm error envelope
 *   - For close/accept classes: null response markers
 *
 * These are DATA — they do not classify. A future classifier implementation
 * would be tested against these vectors.
 *
 * Coverage target: ≥1 vector per T-class (12/12), with bonus vectors
 * for respond classes that can emit multiple error codes (T-F, T-G).
 */

import type { DispositionClass, DispositionOutcome } from './disposition.js';

// ---------------------------------------------------------------------------
// Closed error arm names — the 11 concrete envelope types from envelope.ts
// ---------------------------------------------------------------------------

/**
 * Names of the 11 concrete error envelope types.
 * Used to tag fixture vectors with their expected error response arm.
 * Exhaustive — must match the ClosedWireErrorResponse union exactly.
 */
export const CLOSED_ERROR_ARM_NAMES = [
  'ParseErrorEnvelope',
  'InvalidRequestNullIdEnvelope',
  'InvalidRequestValidIdEnvelope',
  'MethodNotFoundEnvelope',
  'InvalidParamsEnvelope',
  'InternalErrorEnvelope',
  'HandshakeRejectedEnvelope',
  'DeliveryRejectedEnvelope',
  'DomainErrorEnvelope',
  'DeadlineExpiredEnvelope',
  'SnapshotUnavailableEnvelope',
] as const;

/** Union of all 11 concrete error envelope type names. */
export type ClosedErrorArmName = (typeof CLOSED_ERROR_ARM_NAMES)[number];

// ---------------------------------------------------------------------------
// Fixture vector shape
// ---------------------------------------------------------------------------

/**
 * A single conformance fixture vector for the disposition table.
 *
 * @property id                    - Unique vector identifier (e.g. 'T-B-1').
 * @property rawFrame              - The raw frame content.
 * @property rawFrameEncoding      - 'utf8' for text, 'hex' for binary.
 * @property expectedClass         - The unique T-class this vector targets.
 * @property expectedOutcome       - 'close', 'respond', or 'accept'.
 * @property expectedErrorArm      - For respond: which closed envelope arm.
 * @property expectedErrorCode     - For respond: the error code.
 * @property expectedResponseFrame - For respond: the compact-JSON response.
 * @property description           - Human-readable description.
 */
export interface DispositionFixtureVector {
  readonly id: string;
  readonly rawFrame: string;
  readonly rawFrameEncoding: 'utf8' | 'hex';
  readonly expectedClass: DispositionClass;
  readonly expectedOutcome: DispositionOutcome;
  /** For respond outcomes: the expected closed error arm. Null for close/accept. */
  readonly expectedErrorArm: ClosedErrorArmName | null;
  /** For respond outcomes: the expected error code. Null for close/accept. */
  readonly expectedErrorCode: number | null;
  /** For respond outcomes: the expected compact-JSON response frame. Null for close/accept. */
  readonly expectedResponseFrame: string | null;
  readonly description: string;
}

// ---------------------------------------------------------------------------
// The fixture vectors
// ---------------------------------------------------------------------------

/**
 * Conformance fixture vectors for the pre-dispatch disposition table.
 *
 * Coverage:
 *   - All 12 T-classes have at least one vector (12/12).
 *   - T-F has two vectors (InvalidRequest + MethodNotFound sub-cases).
 *   - T-G has one vector (InvalidParams sub-case).
 *   - Respond-class vectors include the expected compact-JSON response.
 *   - Close/accept vectors have null response markers.
 */
export const DISPOSITION_FIXTURE_VECTORS: readonly DispositionFixtureVector[] = [
  // ─────────────────────────────────────────────────────────────────────────
  // CLOSE classes (6 vectors) — connection torn down, no response emitted
  // ─────────────────────────────────────────────────────────────────────────

  {
    id: 'T-A-1',
    rawFrame: 'ff',
    rawFrameEncoding: 'hex',
    expectedClass: 'T-A',
    expectedOutcome: 'close',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    description: 'transport/framing failure: invalid UTF-8 byte 0xFF',
  },

  {
    id: 'T-C-1',
    rawFrame: '{ "jsonrpc":"2.0" }',
    rawFrameEncoding: 'utf8',
    expectedClass: 'T-C',
    expectedOutcome: 'close',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    description: 'frame-canonicality failure: whitespace in compact JSON',
  },

  {
    id: 'T-E-1',
    rawFrame: '{"jsonrpc":"2.0","id":"","method":"broker.hello","params":{"meta":{"deadlineUnixMs":1},"input":{}}}',
    rawFrameEncoding: 'utf8',
    expectedClass: 'T-E',
    expectedOutcome: 'close',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    description: 'profile-invalid id: empty string violates RequestId min length 1',
  },

  {
    id: 'T-H-1',
    rawFrame: '{"jsonrpc":"2.0","id":"phantom","result":null}',
    rawFrameEncoding: 'utf8',
    expectedClass: 'T-H',
    expectedOutcome: 'close',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    description: 'response candidate correlation failure: id "phantom" matches no in-flight request',
  },

  {
    id: 'T-I-1',
    rawFrame: '{"jsonrpc":"2.0","id":"dup","method":"broker.hello","params":{"meta":{"deadlineUnixMs":1},"input":{}}}',
    rawFrameEncoding: 'utf8',
    expectedClass: 'T-I',
    expectedOutcome: 'close',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    description: 'in-flight id collision: id "dup" collides with an existing in-flight request',
  },

  {
    id: 'T-K-1',
    rawFrame: '{"jsonrpc":"2.0","method":"host.lifecycle.ping","params":{"meta":{"deadlineUnixMs":1},"input":{"nonce":"x"}}}',
    rawFrameEncoding: 'utf8',
    expectedClass: 'T-K',
    expectedOutcome: 'close',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    description: 'valid Notification v0 violation: ping (row 11) sent as notification, only row 10 is legal in v0',
  },

  // ─────────────────────────────────────────────────────────────────────────
  // RESPOND classes (5 vectors) — error response emitted on the wire
  // ─────────────────────────────────────────────────────────────────────────

  {
    id: 'T-B-1',
    rawFrame: '{invalid json',
    rawFrameEncoding: 'utf8',
    expectedClass: 'T-B',
    expectedOutcome: 'respond',
    expectedErrorArm: 'ParseErrorEnvelope',
    expectedErrorCode: -32700,
    expectedResponseFrame: '{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}',
    description: 'JSON parse error: malformed JSON input',
  },

  {
    id: 'T-D-1',
    rawFrame: '{"jsonrpc":"2.0","method":0}',
    rawFrameEncoding: 'utf8',
    expectedClass: 'T-D',
    expectedOutcome: 'respond',
    expectedErrorArm: 'InvalidRequestNullIdEnvelope',
    expectedErrorCode: -32600,
    expectedResponseFrame: '{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"Invalid Request"}}',
    description: 'canonical idless non-response-candidate: method field is number, not string',
  },

  {
    id: 'T-F-1',
    rawFrame: '{"jsonrpc":"2.0","id":"a","method":"broker.hello"}',
    rawFrameEncoding: 'utf8',
    expectedClass: 'T-F',
    expectedOutcome: 'respond',
    expectedErrorArm: 'InvalidRequestValidIdEnvelope',
    expectedErrorCode: -32600,
    expectedResponseFrame: '{"jsonrpc":"2.0","id":"a","error":{"code":-32600,"message":"Invalid Request"}}',
    description: 'valid id, envelope violation: missing required params field',
  },

  {
    id: 'T-F-2',
    rawFrame: '{"jsonrpc":"2.0","id":"a","method":"unknown.method","params":{"meta":{"deadlineUnixMs":1},"input":{}}}',
    rawFrameEncoding: 'utf8',
    expectedClass: 'T-F',
    expectedOutcome: 'respond',
    expectedErrorArm: 'MethodNotFoundEnvelope',
    expectedErrorCode: -32601,
    expectedResponseFrame: '{"jsonrpc":"2.0","id":"a","error":{"code":-32601,"message":"Method not found"}}',
    description: 'valid id, envelope violation: method "unknown.method" not in 12-row registry',
  },

  {
    id: 'T-G-1',
    rawFrame: '{"jsonrpc":"2.0","id":"a","method":"host.lifecycle.ping","params":{"meta":{"deadlineUnixMs":1},"input":{"nonce":""}}}',
    rawFrameEncoding: 'utf8',
    expectedClass: 'T-G',
    expectedOutcome: 'respond',
    expectedErrorArm: 'InvalidParamsEnvelope',
    expectedErrorCode: -32602,
    expectedResponseFrame: '{"jsonrpc":"2.0","id":"a","error":{"code":-32602,"message":"Invalid params"}}',
    description: 'valid id Request, value violation: nonce empty string violates minLength 1',
  },

  // ─────────────────────────────────────────────────────────────────────────
  // ACCEPT classes (2 vectors) — frame dispatched or settled, no error
  // ─────────────────────────────────────────────────────────────────────────

  {
    id: 'T-J-1',
    rawFrame: '{"jsonrpc":"2.0","method":"host.grants.changed","params":{"meta":{"deadlineUnixMs":1},"input":{"grantRevision":0,"effectiveGrants":[]}}}',
    rawFrameEncoding: 'utf8',
    expectedClass: 'T-J',
    expectedOutcome: 'accept',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    description: 'legal Notification: row 10 host.grants.changed with valid payload',
  },

  {
    id: 'T-L-1',
    rawFrame: '{"jsonrpc":"2.0","id":"req-1","result":{"nonce":"x"}}',
    rawFrameEncoding: 'utf8',
    expectedClass: 'T-L',
    expectedOutcome: 'accept',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    description: 'valid correlated response: id "req-1" matches an in-flight request, result echoed',
  },
] as const;
