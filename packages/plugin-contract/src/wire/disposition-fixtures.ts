/**
 * Disposition conformance fixture vectors — machine-readable test data
 * for the pre-dispatch disposition table (T-A through T-L).
 *
 * Mechanized from §3.8-1 of the #1165 frozen plan. Each vector carries:
 *   - A raw frame (the input to a pre-dispatch classifier)
 *   - Machine-readable pre-state (in-flight ids for correlation)
 *   - The expected unique T-class assignment
 *   - For respond classes: a type-checked closed-arm error envelope
 *   - For close/accept classes: null response markers
 *
 * These are DATA — they do not classify. A future classifier
 * implementation would be tested against these vectors.
 *
 * Coverage per §3.8-1:
 *   - 9 response-candidate sub-cases (T-E/T-H/T-L path)
 *   - 7 notification-partition sub-cases (T-D/T-J/T-K path)
 *   - All 12 T-classes have ≥1 vector
 *   - Pre-state mutual-exclusivity proof pair (T-H-3 / T-L-2)
 *
 * Response frames are DERIVED from type-checked ClosedWireErrorResponse
 * objects (FC-F0-3), not hand-written strings.
 */

import type { DispositionClass, DispositionOutcome } from './disposition.js';
import type { RequestId } from './request-id.js';
import type {
  ParseErrorEnvelope,
  InvalidRequestNullIdEnvelope,
  InvalidRequestValidIdEnvelope,
  MethodNotFoundEnvelope,
  InvalidParamsEnvelope,
} from './envelope.js';
import {
  PARSE_ERROR_CODE, PARSE_ERROR_MESSAGE,
  INVALID_REQUEST_CODE, INVALID_REQUEST_MESSAGE,
  METHOD_NOT_FOUND_CODE, METHOD_NOT_FOUND_MESSAGE,
  INVALID_PARAMS_CODE, INVALID_PARAMS_MESSAGE,
} from './errors.js';

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
// Type-checked response envelopes (FC-F0-3)
//
// Each object is annotated with its corresponding concrete envelope type.
// The expectedResponseFrame strings are DERIVED from these typed objects
// via JSON.stringify — not hand-written. This breaks the self-certification
// loop: if an envelope type changes, the fixture fails to compile.
// ---------------------------------------------------------------------------

const RESPONSE_PARSE_ERROR: ParseErrorEnvelope = {
  jsonrpc: '2.0' as const,
  id: null,
  error: { code: PARSE_ERROR_CODE, message: PARSE_ERROR_MESSAGE },
};

const RESPONSE_INVALID_REQUEST_NULL: InvalidRequestNullIdEnvelope = {
  jsonrpc: '2.0' as const,
  id: null,
  error: { code: INVALID_REQUEST_CODE, message: INVALID_REQUEST_MESSAGE },
};

const RESPONSE_INVALID_REQUEST_A: InvalidRequestValidIdEnvelope = {
  jsonrpc: '2.0' as const,
  id: 'a' as RequestId,
  error: { code: INVALID_REQUEST_CODE, message: INVALID_REQUEST_MESSAGE },
};

const RESPONSE_METHOD_NOT_FOUND_A: MethodNotFoundEnvelope = {
  jsonrpc: '2.0' as const,
  id: 'a' as RequestId,
  error: { code: METHOD_NOT_FOUND_CODE, message: METHOD_NOT_FOUND_MESSAGE },
};

const RESPONSE_INVALID_PARAMS_A: InvalidParamsEnvelope = {
  jsonrpc: '2.0' as const,
  id: 'a' as RequestId,
  error: { code: INVALID_PARAMS_CODE, message: INVALID_PARAMS_MESSAGE },
};

// ---------------------------------------------------------------------------
// Pre-state shape (FC-F0-2)
// ---------------------------------------------------------------------------

/**
 * Machine-readable pre-state for state-dependent classification.
 * Without this, T-H vs T-L cannot be distinguished from rawFrame alone.
 *
 * @property inFlightIds — Request IDs with pending responses at the
 *   moment the rawFrame arrives. Empty array = no in-flight requests.
 */
export interface FixturePreState {
  readonly inFlightIds: readonly string[];
}

// ---------------------------------------------------------------------------
// Fixture vector shape
// ---------------------------------------------------------------------------

/**
 * A single conformance fixture vector for the disposition table.
 */
export interface DispositionFixtureVector {
  readonly id: string;
  readonly rawFrame: string;
  readonly rawFrameEncoding: 'utf8' | 'hex';
  readonly preState: FixturePreState;
  readonly expectedClass: DispositionClass;
  readonly expectedOutcome: DispositionOutcome;
  /** For respond outcomes: the expected closed error arm. Null for close/accept. */
  readonly expectedErrorArm: ClosedErrorArmName | null;
  /** For respond outcomes: the expected error code. Null for close/accept. */
  readonly expectedErrorCode: number | null;
  /** For respond outcomes: compact-JSON derived from typed envelope. Null for close/accept. */
  readonly expectedResponseFrame: string | null;
  readonly description: string;
}

// ---------------------------------------------------------------------------
// §3.8-1 partition tags — used by tests to verify coverage counts
// ---------------------------------------------------------------------------

/**
 * Vectors in the response-candidate partition (frames with result/error,
 * no method — enter the id-validation → correlation → settlement path).
 * Target: 9 sub-cases per §3.8-1.
 */
export const RESPONSE_CANDIDATE_IDS = [
  'T-E-2', 'T-H-1', 'T-H-2', 'T-H-3', 'T-H-4', 'T-H-5',
  'T-L-1', 'T-L-2', 'T-L-3',
] as const;

/**
 * Vectors in the notification partition (frames with method, no id —
 * enter the method-validation → row-10-check → v0-enforcement path).
 * Target: 7 sub-cases per §3.8-1.
 */
export const NOTIFICATION_PARTITION_IDS = [
  'T-D-1', 'T-D-2', 'T-J-1', 'T-J-2', 'T-K-1', 'T-K-2', 'T-K-3',
] as const;

// ---------------------------------------------------------------------------
// The fixture vectors (25 total)
// ---------------------------------------------------------------------------

export const DISPOSITION_FIXTURE_VECTORS: readonly DispositionFixtureVector[] = [

  // ═════════════════════════════════════════════════════════════════════════
  // PRE-STRUCTURAL (T-A, T-B, T-C) — before id/method analysis
  // ═════════════════════════════════════════════════════════════════════════

  {
    id: 'T-A-1',
    rawFrame: 'ff',
    rawFrameEncoding: 'hex',
    preState: { inFlightIds: [] },
    expectedClass: 'T-A',
    expectedOutcome: 'close',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    description: 'transport/framing failure: invalid UTF-8 byte 0xFF',
  },

  {
    id: 'T-B-1',
    rawFrame: '{invalid json',
    rawFrameEncoding: 'utf8',
    preState: { inFlightIds: [] },
    expectedClass: 'T-B',
    expectedOutcome: 'respond',
    expectedErrorArm: 'ParseErrorEnvelope',
    expectedErrorCode: -32700,
    expectedResponseFrame: JSON.stringify(RESPONSE_PARSE_ERROR),
    description: 'JSON parse error: malformed JSON input',
  },

  {
    id: 'T-C-1',
    rawFrame: '{ "jsonrpc":"2.0" }',
    rawFrameEncoding: 'utf8',
    preState: { inFlightIds: [] },
    expectedClass: 'T-C',
    expectedOutcome: 'close',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    description: 'frame-canonicality failure: whitespace in compact JSON',
  },

  // ═════════════════════════════════════════════════════════════════════════
  // NOTIFICATION PARTITION — 7 vectors (§3.8-1)
  // Frames with method + no id → T-D (malformed) / T-J (legal) / T-K (v0)
  // ═════════════════════════════════════════════════════════════════════════

  {
    id: 'T-D-1',
    rawFrame: '{"jsonrpc":"2.0","method":0}',
    rawFrameEncoding: 'utf8',
    preState: { inFlightIds: [] },
    expectedClass: 'T-D',
    expectedOutcome: 'respond',
    expectedErrorArm: 'InvalidRequestNullIdEnvelope',
    expectedErrorCode: -32600,
    expectedResponseFrame: JSON.stringify(RESPONSE_INVALID_REQUEST_NULL),
    description: 'notification partition: method is number, not string',
  },

  {
    id: 'T-D-2',
    rawFrame: '{"jsonrpc":"1.0","method":"broker.hello","params":{"meta":{"deadlineUnixMs":1},"input":{}}}',
    rawFrameEncoding: 'utf8',
    preState: { inFlightIds: [] },
    expectedClass: 'T-D',
    expectedOutcome: 'respond',
    expectedErrorArm: 'InvalidRequestNullIdEnvelope',
    expectedErrorCode: -32600,
    expectedResponseFrame: JSON.stringify(RESPONSE_INVALID_REQUEST_NULL),
    description: 'notification partition: wrong jsonrpc version "1.0"',
  },

  {
    id: 'T-J-1',
    rawFrame: '{"jsonrpc":"2.0","method":"host.grants.changed","params":{"meta":{"deadlineUnixMs":1},"input":{"grantRevision":0,"effectiveGrants":[]}}}',
    rawFrameEncoding: 'utf8',
    preState: { inFlightIds: [] },
    expectedClass: 'T-J',
    expectedOutcome: 'accept',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    description: 'notification partition: legal row-10 grants.changed, empty grants',
  },

  {
    id: 'T-J-2',
    rawFrame: '{"jsonrpc":"2.0","method":"host.grants.changed","params":{"meta":{"deadlineUnixMs":1},"input":{"grantRevision":1,"effectiveGrants":["messaging.subscribe"]}}}',
    rawFrameEncoding: 'utf8',
    preState: { inFlightIds: [] },
    expectedClass: 'T-J',
    expectedOutcome: 'accept',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    description: 'notification partition: legal row-10 grants.changed, non-empty grants',
  },

  {
    id: 'T-K-1',
    rawFrame: '{"jsonrpc":"2.0","method":"host.lifecycle.ping","params":{"meta":{"deadlineUnixMs":1},"input":{"nonce":"x"}}}',
    rawFrameEncoding: 'utf8',
    preState: { inFlightIds: [] },
    expectedClass: 'T-K',
    expectedOutcome: 'close',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    description: 'notification partition: ping (row 11) as notification, v0 violation',
  },

  {
    id: 'T-K-2',
    rawFrame: '{"jsonrpc":"2.0","method":"broker.hello","params":{"meta":{"deadlineUnixMs":1},"input":{}}}',
    rawFrameEncoding: 'utf8',
    preState: { inFlightIds: [] },
    expectedClass: 'T-K',
    expectedOutcome: 'close',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    description: 'notification partition: broker.hello (row 1) as notification, v0 violation',
  },

  {
    id: 'T-K-3',
    rawFrame: '{"jsonrpc":"2.0","method":"unknown.rpc","params":{"meta":{"deadlineUnixMs":1},"input":{}}}',
    rawFrameEncoding: 'utf8',
    preState: { inFlightIds: [] },
    expectedClass: 'T-K',
    expectedOutcome: 'close',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    description: 'notification partition: unknown method as notification, v0 violation',
  },

  // ═════════════════════════════════════════════════════════════════════════
  // ID ANALYSIS — T-E (profile-invalid id)
  // ═════════════════════════════════════════════════════════════════════════

  {
    id: 'T-E-1',
    rawFrame: '{"jsonrpc":"2.0","id":"","method":"broker.hello","params":{"meta":{"deadlineUnixMs":1},"input":{}}}',
    rawFrameEncoding: 'utf8',
    preState: { inFlightIds: [] },
    expectedClass: 'T-E',
    expectedOutcome: 'close',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    description: 'profile-invalid id: empty string violates RequestId min length 1',
  },

  // T-E-2 is ALSO a response-candidate sub-case: response-shaped frame
  // with a detected but invalid id enters the id-validation path and fails.
  {
    id: 'T-E-2',
    rawFrame: '{"jsonrpc":"2.0","id":42,"result":null}',
    rawFrameEncoding: 'utf8',
    preState: { inFlightIds: [] },
    expectedClass: 'T-E',
    expectedOutcome: 'close',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    description: 'response-candidate + profile-invalid id: numeric id violates string requirement',
  },

  // ═════════════════════════════════════════════════════════════════════════
  // REQUEST PATH — T-F (envelope violation), T-G (value violation), T-I
  // ═════════════════════════════════════════════════════════════════════════

  {
    id: 'T-F-1',
    rawFrame: '{"jsonrpc":"2.0","id":"a","method":"broker.hello"}',
    rawFrameEncoding: 'utf8',
    preState: { inFlightIds: [] },
    expectedClass: 'T-F',
    expectedOutcome: 'respond',
    expectedErrorArm: 'InvalidRequestValidIdEnvelope',
    expectedErrorCode: -32600,
    expectedResponseFrame: JSON.stringify(RESPONSE_INVALID_REQUEST_A),
    description: 'envelope violation: missing required params field',
  },

  {
    id: 'T-F-2',
    rawFrame: '{"jsonrpc":"2.0","id":"a","method":"unknown.method","params":{"meta":{"deadlineUnixMs":1},"input":{}}}',
    rawFrameEncoding: 'utf8',
    preState: { inFlightIds: [] },
    expectedClass: 'T-F',
    expectedOutcome: 'respond',
    expectedErrorArm: 'MethodNotFoundEnvelope',
    expectedErrorCode: -32601,
    expectedResponseFrame: JSON.stringify(RESPONSE_METHOD_NOT_FOUND_A),
    description: 'envelope violation: method "unknown.method" not in 12-row registry',
  },

  {
    id: 'T-F-3',
    rawFrame: '{"jsonrpc":"2.0","id":"a","method":"broker.hello","params":[]}',
    rawFrameEncoding: 'utf8',
    preState: { inFlightIds: [] },
    expectedClass: 'T-F',
    expectedOutcome: 'respond',
    expectedErrorArm: 'InvalidParamsEnvelope',
    expectedErrorCode: -32602,
    expectedResponseFrame: JSON.stringify(RESPONSE_INVALID_PARAMS_A),
    description: 'envelope violation: params is array, must be object with meta+input',
  },

  {
    id: 'T-G-1',
    rawFrame: '{"jsonrpc":"2.0","id":"a","method":"host.lifecycle.ping","params":{"meta":{"deadlineUnixMs":1},"input":{"nonce":""}}}',
    rawFrameEncoding: 'utf8',
    preState: { inFlightIds: [] },
    expectedClass: 'T-G',
    expectedOutcome: 'respond',
    expectedErrorArm: 'InvalidParamsEnvelope',
    expectedErrorCode: -32602,
    expectedResponseFrame: JSON.stringify(RESPONSE_INVALID_PARAMS_A),
    description: 'value violation: nonce empty string violates minLength 1',
  },

  {
    id: 'T-I-1',
    rawFrame: '{"jsonrpc":"2.0","id":"dup","method":"broker.hello","params":{"meta":{"deadlineUnixMs":1},"input":{}}}',
    rawFrameEncoding: 'utf8',
    preState: { inFlightIds: ['dup'] },
    expectedClass: 'T-I',
    expectedOutcome: 'close',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    description: 'in-flight id collision: id "dup" is already in preState.inFlightIds',
  },

  // ═════════════════════════════════════════════════════════════════════════
  // RESPONSE-CANDIDATE PARTITION — 9 vectors (§3.8-1)
  // Frames with result/error, no method → T-E (bad id) / T-H (fail) / T-L
  //
  // T-E-2 (above) is counted as the 1st response-candidate sub-case.
  // T-H-3 and T-L-2 form a mutual-exclusivity proof pair:
  //   same rawFrame, different preState → different T-class.
  // ═════════════════════════════════════════════════════════════════════════

  {
    id: 'T-H-1',
    rawFrame: '{"jsonrpc":"2.0","id":"phantom","result":null}',
    rawFrameEncoding: 'utf8',
    preState: { inFlightIds: [] },
    expectedClass: 'T-H',
    expectedOutcome: 'close',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    description: 'response-candidate: id "phantom" not in preState.inFlightIds, correlation failure',
  },

  {
    id: 'T-H-2',
    rawFrame: '{"jsonrpc":"2.0","id":"x","result":null,"error":{"code":-32603,"message":"Internal error"}}',
    rawFrameEncoding: 'utf8',
    preState: { inFlightIds: ['x'] },
    expectedClass: 'T-H',
    expectedOutcome: 'close',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    description: 'response-candidate: both result AND error present, mutual-exclusivity violation',
  },

  // ── MUTUAL-EXCLUSIVITY PROOF PAIR ─────────────────────────────────────
  // T-H-3 and T-L-2 share IDENTICAL rawFrame. Only preState differs.
  // This proves the classifier MUST consult preState, not just rawFrame.
  {
    id: 'T-H-3',
    rawFrame: '{"jsonrpc":"2.0","id":"corr-test","result":null}',
    rawFrameEncoding: 'utf8',
    preState: { inFlightIds: [] },
    expectedClass: 'T-H',
    expectedOutcome: 'close',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    description: 'response-candidate PAIR: "corr-test" NOT in-flight → T-H (see T-L-2 for pair)',
  },

  {
    id: 'T-H-4',
    rawFrame: '{"jsonrpc":"2.0","id":"lost-req","error":{"code":-32602,"message":"Invalid params"}}',
    rawFrameEncoding: 'utf8',
    preState: { inFlightIds: [] },
    expectedClass: 'T-H',
    expectedOutcome: 'close',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    description: 'response-candidate: error response with uncorrelated id "lost-req"',
  },

  {
    id: 'T-H-5',
    rawFrame: '{"jsonrpc":"2.0","id":"r1","error":"not an object"}',
    rawFrameEncoding: 'utf8',
    preState: { inFlightIds: ['r1'] },
    expectedClass: 'T-H',
    expectedOutcome: 'close',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    description: 'response-candidate: error body is string not object, structural validation failure',
  },

  {
    id: 'T-L-1',
    rawFrame: '{"jsonrpc":"2.0","id":"req-1","result":{"nonce":"x"}}',
    rawFrameEncoding: 'utf8',
    preState: { inFlightIds: ['req-1'] },
    expectedClass: 'T-L',
    expectedOutcome: 'accept',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    description: 'response-candidate: valid success response, id "req-1" correlates',
  },

  // ── PAIR with T-H-3 ──────────────────────────────────────────────────
  {
    id: 'T-L-2',
    rawFrame: '{"jsonrpc":"2.0","id":"corr-test","result":null}',
    rawFrameEncoding: 'utf8',
    preState: { inFlightIds: ['corr-test'] },
    expectedClass: 'T-L',
    expectedOutcome: 'accept',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    description: 'response-candidate PAIR: "corr-test" IS in-flight → T-L (see T-H-3 for pair)',
  },

  {
    id: 'T-L-3',
    rawFrame: '{"jsonrpc":"2.0","id":"req-err","error":{"code":-32602,"message":"Invalid params"}}',
    rawFrameEncoding: 'utf8',
    preState: { inFlightIds: ['req-err'] },
    expectedClass: 'T-L',
    expectedOutcome: 'accept',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    description: 'response-candidate: valid error response, id "req-err" correlates',
  },
];
