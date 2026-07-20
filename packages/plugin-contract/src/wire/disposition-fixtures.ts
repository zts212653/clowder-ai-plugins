/**
 * Disposition conformance fixture vectors — machine-readable test data
 * for the pre-dispatch disposition table (T-A through T-L).
 *
 * Mechanized from §3.8-1 of the #1165 frozen plan. Each vector carries:
 *   - A raw frame (the input to a pre-dispatch classifier)
 *   - Machine-readable pre-state with correlation records (FC-6B-3)
 *   - The expected unique T-class assignment
 *   - For respond classes: a type-checked closed-arm error envelope
 *   - For close/accept classes: null response markers
 *
 * These are DATA — they do not classify. A future classifier
 * implementation would be tested against these vectors.
 *
 * Coverage per §3.8-1:
 *   - 9 response-candidate sub-cases (RESPONSE_CANDIDATE_CASES)
 *   - 7 notification-partition sub-cases (NOTIFICATION_PARTITION_CASES)
 *   - All 12 T-classes have ≥1 vector
 *   - Pre-state mutual-exclusivity proof pair (T-H-3 / T-L-2)
 *
 * Response frames are DERIVED from type-checked ClosedWireErrorResponse
 * objects (FC-F0-3), not hand-written strings.
 *
 * Partition records use semantic keys (FC-6B-1), NOT bare counts.
 * Each key is a distinct classification path for frames bearing
 * result/error (response-candidate partition) or method without id
 * (notification partition). Tests verify every key maps to a real
 * fixture vector, preventing arbitrary self-certification.
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
// Pre-state shape (FC-6B-3)
//
// inFlightRequests carries per-id correlation records, NOT bare id strings.
// This lets a future classifier validate the response schema against the
// expected row's response shape — just knowing "id X is in-flight" is
// insufficient to distinguish a valid settlement from a schema mismatch.
// ---------------------------------------------------------------------------

/**
 * A single in-flight request record for pre-state correlation.
 *
 * @property id     — The request id (matches RequestId profile).
 * @property method — The method that was called (determines expected response shape).
 */
export interface InFlightRecord {
  readonly id: string;
  readonly method: string;
}

/**
 * Machine-readable pre-state for state-dependent classification.
 * Without this, T-H vs T-L cannot be distinguished from rawFrame alone.
 *
 * @property inFlightRequests — Requests with pending responses at the
 *   moment the rawFrame arrives. Empty array = no in-flight requests.
 *   Each record carries id + method for response schema validation.
 */
export interface FixturePreState {
  readonly inFlightRequests: readonly InFlightRecord[];
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
// §3.8-1 partition records — semantic keys, not bare counts (FC-6B-1)
//
// Each key is a distinct classification sub-case from the frozen plan.
// Values are fixture vector ids. Tests verify every key maps to a real
// vector, preventing "arbitrary 9/7 self-certification" (sol FC-6B root
// cause: "用 9/7 数量替代冻结案例身份").
// ---------------------------------------------------------------------------

/**
 * 9 response-candidate sub-cases per §3.8-1.
 *
 * A "response candidate" is any frame bearing result/error fields.
 * The 9 sub-cases cover every distinct classification path such a
 * frame can take — including exit paths where method presence
 * reroutes the frame to a non-T-H/T-L class.
 *
 * Sub-case key → representative fixture vector id.
 */
export const RESPONSE_CANDIDATE_CASES = {
  /** result/error + numeric id (profile-invalid) → T-H validation failure */
  'rc-invalid-id': 'T-H-6',
  /** result + no id field at all → T-H validation failure */
  'rc-missing-id': 'T-H-7',
  /** result + valid id not in-flight → T-H correlation failure */
  'rc-uncorrelated': 'T-H-1',
  /** both result AND error present → T-H structural failure */
  'rc-result-and-error': 'T-H-2',
  /** error body is string, not object → T-H structural failure */
  'rc-error-structural': 'T-H-5',
  /** result + valid id in-flight → T-L correlated success */
  'rc-settled-success': 'T-L-1',
  /** error + valid id in-flight → T-L correlated error */
  'rc-settled-error': 'T-L-3',
  /** result + valid method + valid id → exits to T-F (request envelope violation) */
  'rc-with-method': 'T-F-4',
  /** result + invalid method (number) → exits to T-D */
  'rc-with-invalid-method': 'T-D-3',
} as const;

/**
 * 7 notification-partition sub-cases per §3.8-1.
 *
 * A "notification" is any frame with method and no id. The 7 sub-cases
 * cover every distinct classification path: T-D (malformed), T-J
 * (legal row-10), T-K (v0 violation).
 *
 * Sub-case key → representative fixture vector id.
 */
export const NOTIFICATION_PARTITION_CASES = {
  /** method field is number, not string → T-D */
  'nt-method-type': 'T-D-1',
  /** jsonrpc version wrong ("1.0") → T-D */
  'nt-version': 'T-D-2',
  /** missing required params field → T-D */
  'nt-missing-params': 'T-D-4',
  /** legal row-10, empty grants → T-J accept */
  'nt-legal-empty': 'T-J-1',
  /** legal row-10, populated grants → T-J accept */
  'nt-legal-populated': 'T-J-2',
  /** known non-row-10 method as notification → T-K v0 violation */
  'nt-known-v0': 'T-K-1',
  /** unknown method as notification → T-K v0 violation */
  'nt-unknown-method': 'T-K-3',
} as const;

// ---------------------------------------------------------------------------
// The fixture vectors (29 total)
// ---------------------------------------------------------------------------

export const DISPOSITION_FIXTURE_VECTORS: readonly DispositionFixtureVector[] = [

  // ═════════════════════════════════════════════════════════════════════════
  // PRE-STRUCTURAL (T-A, T-B, T-C) — before id/method analysis
  // ═════════════════════════════════════════════════════════════════════════

  {
    id: 'T-A-1',
    rawFrame: 'ff',
    rawFrameEncoding: 'hex',
    preState: { inFlightRequests: [] },
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
    preState: { inFlightRequests: [] },
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
    preState: { inFlightRequests: [] },
    expectedClass: 'T-C',
    expectedOutcome: 'close',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    description: 'frame-canonicality failure: whitespace in compact JSON',
  },

  // ═════════════════════════════════════════════════════════════════════════
  // NOTIFICATION PARTITION — 8 vectors covering 7 sub-cases (§3.8-1)
  // Frames with method + no id → T-D (malformed) / T-J (legal) / T-K (v0)
  //
  // Sub-case mapping: see NOTIFICATION_PARTITION_CASES record.
  // T-K-2 is additional coverage (known method variant), not a distinct
  // sub-case — T-K-1 is the representative for 'nt-known-v0'.
  // ═════════════════════════════════════════════════════════════════════════

  {
    id: 'T-D-1',
    rawFrame: '{"jsonrpc":"2.0","method":0}',
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [] },
    expectedClass: 'T-D',
    expectedOutcome: 'respond',
    expectedErrorArm: 'InvalidRequestNullIdEnvelope',
    expectedErrorCode: -32600,
    expectedResponseFrame: JSON.stringify(RESPONSE_INVALID_REQUEST_NULL),
    description: 'notification partition [nt-method-type]: method is number, not string',
  },

  {
    id: 'T-D-2',
    rawFrame: '{"jsonrpc":"1.0","method":"broker.hello","params":{"meta":{"deadlineUnixMs":1},"input":{}}}',
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [] },
    expectedClass: 'T-D',
    expectedOutcome: 'respond',
    expectedErrorArm: 'InvalidRequestNullIdEnvelope',
    expectedErrorCode: -32600,
    expectedResponseFrame: JSON.stringify(RESPONSE_INVALID_REQUEST_NULL),
    description: 'notification partition [nt-version]: wrong jsonrpc version "1.0"',
  },

  {
    id: 'T-D-3',
    rawFrame: '{"jsonrpc":"2.0","method":0,"result":null}',
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [] },
    expectedClass: 'T-D',
    expectedOutcome: 'respond',
    expectedErrorArm: 'InvalidRequestNullIdEnvelope',
    expectedErrorCode: -32600,
    expectedResponseFrame: JSON.stringify(RESPONSE_INVALID_REQUEST_NULL),
    description: 'response-candidate boundary [rc-with-invalid-method]: method:0 + result:null, method presence routes to T-D',
  },

  {
    id: 'T-D-4',
    rawFrame: '{"jsonrpc":"2.0","method":"host.grants.changed"}',
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [] },
    expectedClass: 'T-D',
    expectedOutcome: 'respond',
    expectedErrorArm: 'InvalidRequestNullIdEnvelope',
    expectedErrorCode: -32600,
    expectedResponseFrame: JSON.stringify(RESPONSE_INVALID_REQUEST_NULL),
    description: 'notification partition [nt-missing-params]: valid method but missing required params field',
  },

  {
    id: 'T-J-1',
    rawFrame: '{"jsonrpc":"2.0","method":"host.grants.changed","params":{"meta":{"deadlineUnixMs":1},"input":{"grantRevision":0,"effectiveGrants":[]}}}',
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [] },
    expectedClass: 'T-J',
    expectedOutcome: 'accept',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    description: 'notification partition [nt-legal-empty]: legal row-10 grants.changed, empty grants',
  },

  {
    id: 'T-J-2',
    rawFrame: '{"jsonrpc":"2.0","method":"host.grants.changed","params":{"meta":{"deadlineUnixMs":1},"input":{"grantRevision":1,"effectiveGrants":["message.event.subscribe"]}}}',
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [] },
    expectedClass: 'T-J',
    expectedOutcome: 'accept',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    description: 'notification partition [nt-legal-populated]: legal row-10 grants.changed, non-empty grants (message.event.subscribe)',
  },

  {
    id: 'T-K-1',
    rawFrame: '{"jsonrpc":"2.0","method":"host.lifecycle.ping","params":{"meta":{"deadlineUnixMs":1},"input":{"nonce":"x"}}}',
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [] },
    expectedClass: 'T-K',
    expectedOutcome: 'close',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    description: 'notification partition [nt-known-v0]: ping (row 11) as notification, v0 violation',
  },

  {
    id: 'T-K-2',
    rawFrame: '{"jsonrpc":"2.0","method":"broker.hello","params":{"meta":{"deadlineUnixMs":1},"input":{}}}',
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [] },
    expectedClass: 'T-K',
    expectedOutcome: 'close',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    description: 'notification partition: broker.hello (row 1) as notification, v0 violation (additional coverage for nt-known-v0)',
  },

  {
    id: 'T-K-3',
    rawFrame: '{"jsonrpc":"2.0","method":"unknown.rpc","params":{"meta":{"deadlineUnixMs":1},"input":{}}}',
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [] },
    expectedClass: 'T-K',
    expectedOutcome: 'close',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    description: 'notification partition [nt-unknown-method]: unknown method as notification, v0 violation',
  },

  // ═════════════════════════════════════════════════════════════════════════
  // ID ANALYSIS — T-E (profile-invalid id on request/notification path)
  //
  // T-E is exclusively for frames on the request/notification path (has
  // method). Response candidates with profile-invalid id go to T-H
  // (response-candidate validation failure). See FC-6B-1.
  // ═════════════════════════════════════════════════════════════════════════

  {
    id: 'T-E-1',
    rawFrame: '{"jsonrpc":"2.0","id":"","method":"broker.hello","params":{"meta":{"deadlineUnixMs":1},"input":{}}}',
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [] },
    expectedClass: 'T-E',
    expectedOutcome: 'close',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    description: 'profile-invalid id on request: empty string violates RequestId min length 1',
  },

  // ═════════════════════════════════════════════════════════════════════════
  // REQUEST PATH — T-F (envelope violation), T-G (value violation), T-I
  // ═════════════════════════════════════════════════════════════════════════

  {
    id: 'T-F-1',
    rawFrame: '{"jsonrpc":"2.0","id":"a","method":"broker.hello"}',
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [] },
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
    preState: { inFlightRequests: [] },
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
    preState: { inFlightRequests: [] },
    expectedClass: 'T-F',
    expectedOutcome: 'respond',
    expectedErrorArm: 'InvalidParamsEnvelope',
    expectedErrorCode: -32602,
    expectedResponseFrame: JSON.stringify(RESPONSE_INVALID_PARAMS_A),
    description: 'envelope violation: params is array, must be object with meta+input',
  },

  {
    id: 'T-F-4',
    rawFrame: '{"jsonrpc":"2.0","id":"a","method":"broker.hello","params":{"meta":{"deadlineUnixMs":1},"input":{}},"result":null}',
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [] },
    expectedClass: 'T-F',
    expectedOutcome: 'respond',
    expectedErrorArm: 'InvalidRequestValidIdEnvelope',
    expectedErrorCode: -32600,
    expectedResponseFrame: JSON.stringify(RESPONSE_INVALID_REQUEST_A),
    description: 'response-candidate boundary [rc-with-method]: request with extra result field, method routes to T-F',
  },

  {
    id: 'T-G-1',
    rawFrame: '{"jsonrpc":"2.0","id":"a","method":"host.lifecycle.ping","params":{"meta":{"deadlineUnixMs":1},"input":{"nonce":""}}}',
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [] },
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
    preState: { inFlightRequests: [{ id: 'dup', method: 'broker.hello' }] },
    expectedClass: 'T-I',
    expectedOutcome: 'close',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    description: 'in-flight id collision: id "dup" is already in preState.inFlightRequests',
  },

  // ═════════════════════════════════════════════════════════════════════════
  // RESPONSE-CANDIDATE PARTITION — 13 vectors covering 9 sub-cases (§3.8-1)
  //
  // A "response candidate" = frame bearing result/error. The 9 sub-cases
  // (RESPONSE_CANDIDATE_CASES) cover every distinct classification path,
  // including exit paths where method presence reroutes to T-D/T-F.
  //
  // Vectors beyond the 9 representative cases are additional coverage:
  //   - T-H-3 / T-L-2: mutual-exclusivity proof pair (correlation check)
  //   - T-H-4: additional uncorrelated case (error variant of T-H-1)
  //
  // T-D-3 and T-F-4 (above) are ALSO response-candidate sub-cases
  // — they have result/error but method presence routes them elsewhere.
  // ═════════════════════════════════════════════════════════════════════════

  // ── T-H: response-candidate validation/correlation failure ────────────

  {
    id: 'T-H-1',
    rawFrame: '{"jsonrpc":"2.0","id":"phantom","result":null}',
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [] },
    expectedClass: 'T-H',
    expectedOutcome: 'close',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    description: 'response-candidate [rc-uncorrelated]: id "phantom" not in-flight, correlation failure',
  },

  {
    id: 'T-H-2',
    rawFrame: '{"jsonrpc":"2.0","id":"x","result":null,"error":{"code":-32603,"message":"Internal error"}}',
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [{ id: 'x', method: 'messaging.subscribe' }] },
    expectedClass: 'T-H',
    expectedOutcome: 'close',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    description: 'response-candidate [rc-result-and-error]: both result AND error present, mutual-exclusivity violation',
  },

  // ── MUTUAL-EXCLUSIVITY PROOF PAIR ─────────────────────────────────────
  // T-H-3 and T-L-2 share IDENTICAL rawFrame. Only preState differs.
  // This proves the classifier MUST consult preState, not just rawFrame.
  // Additional coverage for rc-uncorrelated (T-H-3) and rc-settled-success
  // (T-L-2), not distinct sub-cases.
  {
    id: 'T-H-3',
    rawFrame: '{"jsonrpc":"2.0","id":"corr-test","result":null}',
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [] },
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
    preState: { inFlightRequests: [] },
    expectedClass: 'T-H',
    expectedOutcome: 'close',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    description: 'response-candidate: error response with uncorrelated id (additional coverage for rc-uncorrelated)',
  },

  {
    id: 'T-H-5',
    rawFrame: '{"jsonrpc":"2.0","id":"r1","error":"not an object"}',
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [{ id: 'r1', method: 'messaging.subscribe' }] },
    expectedClass: 'T-H',
    expectedOutcome: 'close',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    description: 'response-candidate [rc-error-structural]: error body is string not object, structural validation failure',
  },

  {
    id: 'T-H-6',
    rawFrame: '{"jsonrpc":"2.0","id":42,"result":null}',
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [] },
    expectedClass: 'T-H',
    expectedOutcome: 'close',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    description: 'response-candidate [rc-invalid-id]: numeric id on response candidate → T-H validation failure (FC-6B-1: not T-E, response candidates bypass T-E)',
  },

  {
    id: 'T-H-7',
    rawFrame: '{"jsonrpc":"2.0","result":null}',
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [] },
    expectedClass: 'T-H',
    expectedOutcome: 'close',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    description: 'response-candidate [rc-missing-id]: result present but no id field, cannot correlate',
  },

  // ── T-L: valid correlated response (settlement) ──────────────────────

  {
    id: 'T-L-1',
    rawFrame: '{"jsonrpc":"2.0","id":"req-1","result":{"nonce":"x"}}',
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [{ id: 'req-1', method: 'host.lifecycle.ping' }] },
    expectedClass: 'T-L',
    expectedOutcome: 'accept',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    description: 'response-candidate [rc-settled-success]: valid success response, id "req-1" correlates to ping',
  },

  // ── PAIR with T-H-3 ──────────────────────────────────────────────────
  {
    id: 'T-L-2',
    rawFrame: '{"jsonrpc":"2.0","id":"corr-test","result":null}',
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [{ id: 'corr-test', method: 'host.lifecycle.ping' }] },
    expectedClass: 'T-L',
    expectedOutcome: 'accept',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    description: 'response-candidate PAIR: "corr-test" IS in-flight (ping) → T-L (see T-H-3 for pair)',
  },

  {
    id: 'T-L-3',
    rawFrame: '{"jsonrpc":"2.0","id":"req-err","error":{"code":-32602,"message":"Invalid params"}}',
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [{ id: 'req-err', method: 'host.lifecycle.ping' }] },
    expectedClass: 'T-L',
    expectedOutcome: 'accept',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    description: 'response-candidate [rc-settled-error]: valid error response, id "req-err" correlates to ping',
  },
];
