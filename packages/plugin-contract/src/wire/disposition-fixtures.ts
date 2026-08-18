/**
 * Disposition conformance fixture vectors — machine-readable test data
 * for the pre-dispatch disposition table (T-A through T-M).
 *
 * Mechanized VERBATIM from §3.8-1 of the #1165 frozen plan (rev11,
 * SHA 7e26e5af). Each vector carries:
 *   - A raw frame (the input to a pre-dispatch classifier)
 *   - Machine-readable pre-state with correlation records + cross-frame oracle
 *   - The expected unique T-class assignment
 *   - For respond classes: a type-checked closed-arm error envelope
 *   - For close/accept classes: null response markers
 *
 * These are DATA — they do not classify. A future classifier
 * implementation would be tested against these vectors.
 *
 * Coverage per §3.8-1 (frozen enumerations, not arbitrary counts):
 *   - 9 response-candidate sub-cases (RESPONSE_CANDIDATE_CASES)
 *     "your R9 correction #5's five required cases plus four controls"
 *   - 7 notification-partition sub-cases (NOTIFICATION_PARTITION_CASES)
 *     "your correction #4's five, the idless-envelope fixture,
 *      and the R8 row-10 value-failure fixture"
 *   - All 13 T-classes have ≥1 vector
 *   - Pre-state mutual-exclusivity proof pairs:
 *       ping nonce (T-H-3 / T-L-2), row-9 deliveryId (T-H-9 / T-L-4)
 *
 * Response frames are DERIVED from type-checked ClosedWireErrorResponse
 * objects, not hand-written strings.
 *
 * Partition records carry {vectorId, expectedClass} per case (FC-70-4).
 * Tests verify both existence AND class correctness per key.
 */

import type { DispositionClass, DispositionOutcome } from './disposition.js';
import {
  BINDING_NONCE_MAX_LENGTH,
  PLUGIN_ID_MAX_LENGTH,
} from './handshake.js';
import { VALID_CAPABILITIES } from './grants.js';
import { PING_NONCE_MAX_LENGTH } from './row-shapes.js';
import { WIRE_UINT53_MAX } from './wire-uint53.js';
import type { CandidateHello, SessionBinding } from './handshake.js';
import type { RequestId } from './request-id.js';
import type { WireMethodName } from './registry.js';
import type {
  ParseErrorEnvelope,
  InvalidRequestNullIdEnvelope,
  InvalidRequestValidIdEnvelope,
  MethodNotFoundEnvelope,
  InvalidParamsEnvelope,
  HandshakeRejectedEnvelope,
  DeadlineExpiredEnvelope,
} from './envelope.js';
import {
  PARSE_ERROR_CODE, PARSE_ERROR_MESSAGE,
  INVALID_REQUEST_CODE, INVALID_REQUEST_MESSAGE,
  METHOD_NOT_FOUND_CODE, METHOD_NOT_FOUND_MESSAGE,
  INVALID_PARAMS_CODE, INVALID_PARAMS_MESSAGE,
  HANDSHAKE_REJECTED_CODE, HANDSHAKE_REJECTED_MESSAGE,
  DEADLINE_EXPIRED_CODE, DEADLINE_EXPIRED_MESSAGE,
} from './errors.js';

// ---------------------------------------------------------------------------
// Closed error arm names — the 11 concrete envelope types from envelope.ts
// ---------------------------------------------------------------------------

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

export type ClosedErrorArmName = (typeof CLOSED_ERROR_ARM_NAMES)[number];

// ---------------------------------------------------------------------------
// Type-checked response envelopes
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

const RESPONSE_HANDSHAKE_REJECTED_AUTHORITY_A: HandshakeRejectedEnvelope = {
  jsonrpc: '2.0' as const,
  id: 'a' as RequestId,
  error: {
    code: HANDSHAKE_REJECTED_CODE,
    message: HANDSHAKE_REJECTED_MESSAGE,
    data: { reason: 'AUTHORITY_VIOLATION' },
  },
};

const RESPONSE_DEADLINE_EXPIRED_DRAIN: DeadlineExpiredEnvelope = {
  jsonrpc: '2.0' as const,
  id: 'drain-deadline' as RequestId,
  error: {
    code: DEADLINE_EXPIRED_CODE,
    message: DEADLINE_EXPIRED_MESSAGE,
    data: {},
  },
};

const BETA8_HELLO: CandidateHello = {
  pluginId: 'example.loopback',
  packageDigest: `sha512-${'A'.repeat(86)}==`,
  contractVersion: '0.1.0-beta.8',
  wireVersion: '0.1.0',
};

const RAW_UTF8_BOUNDARY_CODE_POINTS = {
  ascii: 'a',
  multibyte: '😀',
  escaping: '\u0000',
} as const;

const ALL_CAPABILITY_VALUES = [...VALID_CAPABILITIES];

const BETA8_BINDING: SessionBinding = {
  ...BETA8_HELLO,
  pluginInstanceId: 'instance-1',
  brokerSessionId: 'session-1',
  grantRevision: 0,
  effectiveGrants: [],
  bindingNonce: 'nonce-1',
};

const RESPONSE_HANDSHAKE_REJECTED_HELLO: HandshakeRejectedEnvelope = {
  jsonrpc: '2.0' as const,
  id: 'hello-error' as RequestId,
  error: {
    code: HANDSHAKE_REJECTED_CODE,
    message: HANDSHAKE_REJECTED_MESSAGE,
    data: { reason: 'PACKAGE_MISMATCH' },
  },
};

function helloRequestFrame(id: string, input: Record<string, unknown>): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'broker.hello',
    params: { meta: { deadlineUnixMs: 1 }, input },
  });
}

function readyRequestFrame(id: string, input: Record<string, unknown>): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'broker.ready',
    params: { meta: { deadlineUnixMs: 1 }, input },
  });
}

function helloResultFrame(id: string, result: object): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function lifecycleRequestFrame(
  id: string,
  method: 'host.lifecycle.ping' | 'host.lifecycle.drain',
  input: Record<string, unknown>,
): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method,
    params: { meta: { deadlineUnixMs: WIRE_UINT53_MAX }, input },
  });
}

function grantsChangedNotificationFrame(
  effectiveGrants: readonly string[],
): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    method: 'host.grants.changed',
    params: {
      meta: { deadlineUnixMs: WIRE_UINT53_MAX },
      input: { grantRevision: WIRE_UINT53_MAX, effectiveGrants },
    },
  });
}

type MessagingMethod =
  | 'messaging.send'
  | 'messaging.appendElements'
  | 'messaging.subscribe'
  | 'messaging.read'
  | 'messaging.ack'
  | 'messaging.snapshot'
  | 'host.messaging.deliver';

function messagingRequestFrame(
  id: string,
  method: MessagingMethod,
  input: Record<string, unknown>,
): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method,
    params: { meta: { deadlineUnixMs: WIRE_UINT53_MAX }, input },
  });
}

const M0C_DRAFT = {
  address: { kind: 'thread_handle', handle: 'thread-handle-1' },
  idempotencyKey: 'send-1',
  payload: {
    provenance: { epistemicStatus: 'inference' },
    elements: [
      { elementId: 'element-1', kind: 'text', payload: { text: 'hello' } },
    ],
  },
} as const;

const M0C_ENVELOPE = {
  messageId: 'message-1',
  revision: 1,
  threadId: 'thread-1',
  actor: { kind: 'user', id: 'user-1' },
  audience: { kind: 'public' },
  occurredAt: '2026-08-18T03:00:00.000Z',
  payload: {
    provenance: {
      origin: { kind: 'host' },
      epistemicStatus: 'user_intent',
    },
    elements: [
      { elementId: 'element-1', kind: 'text', payload: { text: 'hello' } },
    ],
  },
} as const;

const M0C_PUBLISH_EVENT = {
  eventId: 'event-1',
  sequence: 1,
  type: 'message.publish',
  envelope: M0C_ENVELOPE,
} as const;

// ---------------------------------------------------------------------------
// Pre-state shape (FC-6B-3 / FC-70-3)
//
// InFlightRecord carries:
//   - id: the request id
//   - method: closed WireMethodName (not bare string) — compiler-checked
//   - requestSnapshot: original request fields for cross-frame oracle
//     (hello candidate echoes, ping nonce echo, row-9 deliveryId ack match)
//
// T-L requires the response to satisfy "the correlated row's result/error
// schema AND every cross-frame semantic oracle" (§3.8-1). The request
// snapshot carries enough data for a future classifier to validate this.
// ---------------------------------------------------------------------------

/**
 * Original request fields needed for cross-frame semantic oracle validation.
 * Optional: only populated for rows that have cross-frame invariants.
 */
export interface RequestSnapshot {
  /** Row 11 ping: the nonce that must be echoed byte-equal in the result. */
  readonly nonce?: string;
  /** Row 9 deliver: the deliveryId that must match byte-equal in the ack. */
  readonly deliveryId?: string;
  /** Row 6 read: the validated request limit that bounds result.events. */
  readonly readLimit?: number;
  /** Row 8 snapshot: the validated request maxItems that bounds result.items. */
  readonly snapshotMaxItems?: number;
  /** Row 1 hello: the candidate claims that SessionBinding must echo byte-equal. */
  readonly candidateHello?: CandidateHello;
}

/**
 * A single in-flight request record for pre-state correlation.
 * The method field is a closed WireMethodName, not a bare string —
 * the compiler catches typos and detects registry drift.
 */
export interface InFlightRecord {
  readonly id: string;
  readonly method: WireMethodName;
  /** Original request fields for cross-frame semantic oracle. */
  readonly requestSnapshot?: RequestSnapshot;
}

/**
 * Machine-readable pre-state for state-dependent classification.
 * Without this, T-H vs T-L cannot be distinguished from rawFrame alone.
 */
export interface FixturePreState {
  readonly inFlightRequests: readonly InFlightRecord[];
}

// ---------------------------------------------------------------------------
// Fixture vector shape
// ---------------------------------------------------------------------------

export interface DispositionFixtureVector {
  readonly id: string;
  readonly rawFrame: string;
  readonly rawFrameEncoding: 'utf8' | 'hex';
  readonly preState: FixturePreState;
  readonly expectedClass: DispositionClass;
  readonly expectedOutcome: DispositionOutcome;
  readonly expectedErrorArm: ClosedErrorArmName | null;
  readonly expectedErrorCode: number | null;
  readonly expectedResponseFrame: string | null;
  /** This vector must not allocate state, enqueue work, or activate. */
  readonly zeroSideEffects?: true;
  readonly description: string;
}

// ---------------------------------------------------------------------------
// §3.8-1 partition records — verbatim from the frozen enumeration (FC-70-4)
//
// Each case carries {vectorId, expectedClass}. Tests verify BOTH that the
// vector exists AND that its expectedClass matches — preventing
// misclassification from passing as a false green.
// ---------------------------------------------------------------------------

/**
 * A single named case from the frozen plan's partition enumeration.
 */
export interface PartitionCase {
  readonly vectorId: string;
  readonly expectedClass: DispositionClass;
}

/**
 * 9 response-candidate sub-cases per §3.8-1:
 * "your R9 correction #5's five required cases plus four controls"
 *
 * A "response candidate" enters the response lane: no method + at least
 * one of result/error. Controls prove the boundary: frames with method
 * that exit to T-F/T-K/T-D despite carrying result/error.
 */
export const RESPONSE_CANDIDATE_CASES: Readonly<Record<string, PartitionCase>> = {
  /** §3.8-1 RC required #1: missing-id success shape → T-H close */
  'rc-1-missing-id-success': { vectorId: 'T-H-7', expectedClass: 'T-H' },
  /** §3.8-1 RC required #2: missing-id error shape → T-H close */
  'rc-2-missing-id-error': { vectorId: 'T-H-8', expectedClass: 'T-H' },
  /** §3.8-1 RC required #3: invalid/malformed-id → T-H close */
  'rc-3-invalid-id': { vectorId: 'T-H-6', expectedClass: 'T-H' },
  /** §3.8-1 RC required #4: schema-valid correlated WireSuccessResponse → T-L */
  'rc-4-settled-valid': { vectorId: 'T-L-1', expectedClass: 'T-L' },
  /** §3.8-1 RC required #5: row-9 ack wrong deliveryId → T-H, never T-L */
  'rc-5-row9-wrong-deliveryid': { vectorId: 'T-H-9', expectedClass: 'T-H' },
  /** §3.8-1 RC control #6: method-bearing Request + extra result → T-F */
  'rc-6-request-extra-result': { vectorId: 'T-F-4', expectedClass: 'T-F' },
  /** §3.8-1 RC control #7: idless Notification + extra error → T-K */
  'rc-7-notification-extra-error': { vectorId: 'T-K-4', expectedClass: 'T-K' },
  /** §3.8-1 RC control #8: structurally-invalid method:0+result → T-D */
  'rc-8-invalid-method-result': { vectorId: 'T-D-3', expectedClass: 'T-D' },
  /** §3.8-1 RC control #9: idless {"jsonrpc":"1.0","method":"x"} → T-D */
  'rc-9-idless-version-control': { vectorId: 'T-D-5', expectedClass: 'T-D' },
};

/**
 * 7 notification-partition sub-cases per §3.8-1:
 * "your correction #4's five, the idless-envelope fixture,
 *  and the R8 row-10 value-failure fixture"
 */
export const NOTIFICATION_PARTITION_CASES: Readonly<Record<string, PartitionCase>> = {
  /** §3.8-1 NT #1: legal row-10 notification → T-J accept */
  'nt-1-legal-row10': { vectorId: 'T-J-1', expectedClass: 'T-J' },
  /** §3.8-1 NT #2: request-only method without id → T-K close */
  'nt-2-request-method': { vectorId: 'T-K-1', expectedClass: 'T-K' },
  /** §3.8-1 NT #3: unknown method without id → T-K close */
  'nt-3-unknown-method': { vectorId: 'T-K-3', expectedClass: 'T-K' },
  /** §3.8-1 NT #4: structurally valid notification, invalid params → T-K */
  'nt-4-invalid-params': { vectorId: 'T-K-6', expectedClass: 'T-K' },
  /** §3.8-1 NT #5: idless notification extra/missing envelope member → T-K */
  'nt-5-envelope-violation': { vectorId: 'T-K-5', expectedClass: 'T-K' },
  /** §3.8-1 NT #6: row-10 deadlineUnixMs:0 value failure (H7/H8) → T-K */
  'nt-6-value-failure': { vectorId: 'T-K-7', expectedClass: 'T-K' },
  /** §3.8-1 NT #7: structurally invalid idless object → T-D respond */
  'nt-7-structurally-invalid': { vectorId: 'T-D-1', expectedClass: 'T-D' },
};

// ---------------------------------------------------------------------------
// The fixture vectors (35 total)
// ---------------------------------------------------------------------------

export const DISPOSITION_FIXTURE_VECTORS: readonly DispositionFixtureVector[] = [

  // ═════════════════════════════════════════════════════════════════════════
  // PRE-STRUCTURAL (T-A, T-B, T-C)
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
  {
    id: 'T-C-2',
    rawFrame: helloResultFrame('hello-h7-negative', {
      ...BETA8_BINDING,
      grantRevision: -1,
    }),
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [{ id: 'hello-h7-negative', method: 'broker.hello', requestSnapshot: { candidateHello: BETA8_HELLO } }] },
    expectedClass: 'T-C',
    expectedOutcome: 'close',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    zeroSideEffects: true,
    description: '[beta.8 H7 raw token] negative SessionBinding grantRevision is rejected at canonicality before correlation',
  },

  // ═════════════════════════════════════════════════════════════════════════
  // T-D: canonical idless NON-response-candidate, NOT a valid Request
  // object (missing/non-string jsonrpc/method)
  //
  // §3.8-1: "not a valid JSON-RPC Request object at all"
  // Frozen vectors: NT-7 (T-D-1), RC-8 (T-D-3), RC-9 (T-D-5)
  // Additional: T-D-2 (wrong jsonrpc version variant)
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
    description: '[NT-7] structurally invalid: method is number, not string',
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
    description: 'structurally invalid: wrong jsonrpc version "1.0" (additional NT-7 variant)',
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
    description: '[RC-8] response-candidate boundary: method:0+result, method routes to T-D',
  },

  {
    id: 'T-D-5',
    rawFrame: '{"jsonrpc":"1.0","method":"x"}',
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [] },
    expectedClass: 'T-D',
    expectedOutcome: 'respond',
    expectedErrorArm: 'InvalidRequestNullIdEnvelope',
    expectedErrorCode: -32600,
    expectedResponseFrame: JSON.stringify(RESPONSE_INVALID_REQUEST_NULL),
    description: '[RC-9] response-candidate control: idless {"jsonrpc":"1.0","method":"x"} → T-D (not a response candidate)',
  },

  // ═════════════════════════════════════════════════════════════════════════
  // T-E: profile-invalid id on request/notification path
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
    description: 'profile-invalid id on request: empty string violates min length 1',
  },

  // ═════════════════════════════════════════════════════════════════════════
  // T-F: envelope violation (valid id, structural problem)
  // Frozen: RC-6 (T-F-4). Additional: T-F-1, T-F-2, T-F-3.
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
    description: 'envelope violation: unknown method not in 13-row registry',
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
    description: 'envelope violation: params is array, must be object',
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
    description: '[RC-6] response-candidate control: Request with extra result member → T-F',
  },

  // ═════════════════════════════════════════════════════════════════════════
  // T-G: value violation (valid envelope, bad params values)
  // ═════════════════════════════════════════════════════════════════════════

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
    zeroSideEffects: true,
    description: 'value violation: nonce empty string violates minLength 1',
  },

  // ═════════════════════════════════════════════════════════════════════════
  // T-I: in-flight id collision
  // ═════════════════════════════════════════════════════════════════════════

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
    description: 'in-flight id collision: id "dup" already in preState',
  },

  // ═════════════════════════════════════════════════════════════════════════
  // NOTIFICATION PARTITION — frozen 7 cases + additional coverage
  //
  // §3.8-1: "once a canonical object is classified as a Notification,
  // no JSON-RPC Response is emitted for any downstream method/params/
  // profile rejection."
  //
  // Frozen cases: T-J-1 (NT-1), T-K-1 (NT-2), T-K-3 (NT-3),
  //   T-K-6 (NT-4), T-K-5 (NT-5), T-K-7 (NT-6), T-D-1 (NT-7).
  // Additional: T-J-2, T-K-2.
  // ═════════════════════════════════════════════════════════════════════════

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
    description: '[NT-1] legal row-10 grants.changed notification, empty grants',
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
    description: 'legal row-10 grants.changed, non-empty grants (additional NT-1 variant)',
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
    zeroSideEffects: true,
    description: '[NT-2] request-only method (ping, row 11) as notification → v0 violation',
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
    description: 'request-only method (hello, row 1) as notification (additional NT-2 variant)',
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
    description: '[NT-3] unknown method as notification → v0 violation',
  },

  {
    id: 'T-K-4',
    rawFrame: '{"jsonrpc":"2.0","method":"host.grants.changed","params":{"meta":{"deadlineUnixMs":1},"input":{"grantRevision":0,"effectiveGrants":[]}},"error":{"code":-32600,"message":"Invalid Request"}}',
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [] },
    expectedClass: 'T-K',
    expectedOutcome: 'close',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    zeroSideEffects: true,
    description: '[RC-7 / NT-5 variant] Notification with extra error member → T-K close',
  },

  {
    id: 'T-K-5',
    rawFrame: '{"jsonrpc":"2.0","method":"host.grants.changed"}',
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [] },
    expectedClass: 'T-K',
    expectedOutcome: 'close',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    zeroSideEffects: true,
    description: '[NT-5] Notification missing params → idless envelope violation → T-K close',
  },

  {
    id: 'T-K-6',
    rawFrame: '{"jsonrpc":"2.0","method":"host.grants.changed","params":{"meta":{"deadlineUnixMs":1},"input":{"grantRevision":"not-a-number","effectiveGrants":[]}}}',
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [] },
    expectedClass: 'T-K',
    expectedOutcome: 'close',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    zeroSideEffects: true,
    description: '[NT-4] structurally valid Notification, invocation-level invalid params (grantRevision wrong type)',
  },

  {
    id: 'T-K-7',
    rawFrame: '{"jsonrpc":"2.0","method":"host.grants.changed","params":{"meta":{"deadlineUnixMs":0},"input":{"grantRevision":0,"effectiveGrants":[]}}}',
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [] },
    expectedClass: 'T-K',
    expectedOutcome: 'close',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    zeroSideEffects: true,
    description: '[NT-6] row-10 notification with deadlineUnixMs:0 → value failure (H7), T-K close',
  },

  // ═════════════════════════════════════════════════════════════════════════
  // RESPONSE-CANDIDATE PARTITION — frozen 9 cases + additional coverage
  //
  // §3.8-1: "an object with no method and at least one of result/error
  // is a response candidate and enters the response lane BEFORE any
  // Request/Notification or ID-profile routing"
  //
  // Frozen cases: T-H-7 (RC-1), T-H-8 (RC-2), T-H-6 (RC-3),
  //   T-L-1 (RC-4), T-H-9 (RC-5), T-F-4 (RC-6), T-K-4 (RC-7),
  //   T-D-3 (RC-8), T-D-5 (RC-9).
  // Additional coverage: T-H-1..T-H-5, T-L-2..T-L-4 (proof pairs + extras)
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
    description: 'response-candidate: phantom id, uncorrelated (additional coverage)',
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
    zeroSideEffects: true,
    description: 'response-candidate: both result AND error present (additional coverage)',
  },

  // ── MUTUAL-EXCLUSIVITY PROOF PAIR ─────────────────────────────────────
  // T-H-3 and T-L-2 share IDENTICAL rawFrame with schema-valid ping
  // result. Only preState differs. FC-70-3 fix: rawFrame now has valid
  // PingResult {nonce:"x"} instead of null.
  {
    id: 'T-H-3',
    rawFrame: '{"jsonrpc":"2.0","id":"corr-test","result":{"nonce":"x"}}',
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [] },
    expectedClass: 'T-H',
    expectedOutcome: 'close',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    zeroSideEffects: true,
    description: 'proof pair: "corr-test" NOT in-flight → T-H (see T-L-2)',
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
    description: 'response-candidate: uncorrelated error (additional coverage)',
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
    zeroSideEffects: true,
    description: 'response-candidate: error body is string not object (additional coverage)',
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
    description: '[RC-3] invalid/malformed-id response candidate: numeric id → T-H',
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
    description: '[RC-1] missing-id success shape: result present, no id → T-H',
  },

  {
    id: 'T-H-8',
    rawFrame: '{"jsonrpc":"2.0","error":{"code":-32602,"message":"Invalid params"}}',
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [] },
    expectedClass: 'T-H',
    expectedOutcome: 'close',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    description: '[RC-2] missing-id error shape: error present, no id → T-H',
  },

  {
    id: 'T-H-9',
    rawFrame: '{"jsonrpc":"2.0","id":"del-1","result":{"deliveryId":"wrong-id"}}',
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [{ id: 'del-1', method: 'host.messaging.deliver', requestSnapshot: { deliveryId: 'correct-id' } }] },
    expectedClass: 'T-H',
    expectedOutcome: 'close',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    zeroSideEffects: true,
    description: '[RC-5] row-9 ack with wrong deliveryId: byte-equality fails → T-H, never T-L',
  },

  // ── T-L: valid correlated response (settlement) ──────────────────────

  {
    id: 'T-L-1',
    rawFrame: '{"jsonrpc":"2.0","id":"req-1","result":{"nonce":"x"}}',
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [{ id: 'req-1', method: 'host.lifecycle.ping', requestSnapshot: { nonce: 'x' } }] },
    expectedClass: 'T-L',
    expectedOutcome: 'accept',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    description: '[RC-4] schema-valid correlated WireSuccessResponse: ping nonce echoed byte-equal',
  },

  // ── PAIR with T-H-3 ──────────────────────────────────────────────────
  {
    id: 'T-L-2',
    rawFrame: '{"jsonrpc":"2.0","id":"corr-test","result":{"nonce":"x"}}',
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [{ id: 'corr-test', method: 'host.lifecycle.ping', requestSnapshot: { nonce: 'x' } }] },
    expectedClass: 'T-L',
    expectedOutcome: 'accept',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    description: 'proof pair: "corr-test" IS in-flight (ping), nonce matches → T-L (see T-H-3)',
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
    description: 'correlated error settlement: valid WireErrorResponse (additional coverage)',
  },

  // ── ROW-9 DELIVERYID EXCLUSIVE PAIR (R47) ────────────────────────────
  // T-H-9 and T-L-4 share the same method/preState structure for
  // host.messaging.deliver. Only the result.deliveryId differs:
  //   T-H-9: result.deliveryId="wrong-id"  ≠ snapshot.deliveryId="correct-id" → T-H
  //   T-L-4: result.deliveryId="correct-id" = snapshot.deliveryId="correct-id" → T-L
  // This locks the byte-equality oracle's success AND failure sides.
  {
    id: 'T-L-4',
    rawFrame: '{"jsonrpc":"2.0","id":"del-1","result":{"deliveryId":"correct-id"}}',
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [{ id: 'del-1', method: 'host.messaging.deliver', requestSnapshot: { deliveryId: 'correct-id' } }] },
    expectedClass: 'T-L',
    expectedOutcome: 'accept',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    description: '[R47 pair] row-9 ack with correct deliveryId: byte-equality passes → T-L (see T-H-9)',
  },

  // ── T-M: legal Request on a ready row ─────────────────────────────────
  {
    id: 'T-M-1',
    rawFrame: '{"jsonrpc":"2.0","id":"hello-1","method":"broker.hello","params":{"meta":{"deadlineUnixMs":1},"input":{"pluginId":"example.loopback","packageDigest":"sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==","contractVersion":"0.1.0-beta.8","wireVersion":"0.1.0"}}}',
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [] },
    expectedClass: 'T-M',
    expectedOutcome: 'accept',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    zeroSideEffects: true,
    description: 'legal broker.hello Request after beta.8 closes and readies row 1',
  },
  {
    id: 'T-M-2',
    rawFrame: '{"jsonrpc":"2.0","id":"ready-1","method":"broker.ready","params":{"meta":{"deadlineUnixMs":1},"input":{"bindingNonce":"nonce-1"}}}',
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [] },
    expectedClass: 'T-M',
    expectedOutcome: 'accept',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    zeroSideEffects: true,
    description: 'legal broker.ready activation request reaches dispatch but does not activate during classification',
  },
  {
    id: 'T-G-2',
    rawFrame: '{"jsonrpc":"2.0","id":"a","method":"broker.hello","params":{"meta":{"deadlineUnixMs":1},"input":{"pluginId":"example.loopback","packageDigest":"sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==","contractVersion":"0.1.0-beta.8","wireVersion":"0.1.0","pluginInstanceId":"caller-injected"}}}',
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [] },
    expectedClass: 'T-G',
    expectedOutcome: 'respond',
    expectedErrorArm: 'HandshakeRejectedEnvelope',
    expectedErrorCode: HANDSHAKE_REJECTED_CODE,
    expectedResponseFrame: JSON.stringify(RESPONSE_HANDSHAKE_REJECTED_AUTHORITY_A),
    zeroSideEffects: true,
    description: 'broker.hello authority injection is rejected before dispatch with zero side effects',
  },
  {
    id: 'T-M-3',
    rawFrame: helloRequestFrame('a', {
      ...BETA8_HELLO,
      pluginId: RAW_UTF8_BOUNDARY_CODE_POINTS.ascii.repeat(PLUGIN_ID_MAX_LENGTH),
    }),
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [] },
    expectedClass: 'T-M',
    expectedOutcome: 'accept',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    zeroSideEffects: true,
    description: '[beta.8 H1 raw-byte N] maximum pluginId request is legal before dispatch',
  },
  {
    id: 'T-G-3',
    rawFrame: helloRequestFrame('a', { ...BETA8_HELLO, pluginId: '' }),
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [] },
    expectedClass: 'T-G',
    expectedOutcome: 'respond',
    expectedErrorArm: 'InvalidParamsEnvelope',
    expectedErrorCode: INVALID_PARAMS_CODE,
    expectedResponseFrame: JSON.stringify(RESPONSE_INVALID_PARAMS_A),
    zeroSideEffects: true,
    description: '[beta.8 H1] empty pluginId is rejected before dispatch',
  },
  {
    id: 'T-G-4',
    rawFrame: helloRequestFrame('a', { ...BETA8_HELLO, packageDigest: 'sha512-invalid==' }),
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [] },
    expectedClass: 'T-G',
    expectedOutcome: 'respond',
    expectedErrorArm: 'InvalidParamsEnvelope',
    expectedErrorCode: INVALID_PARAMS_CODE,
    expectedResponseFrame: JSON.stringify(RESPONSE_INVALID_PARAMS_A),
    zeroSideEffects: true,
    description: '[beta.8 H2] malformed package digest is rejected before dispatch',
  },
  {
    id: 'T-G-5',
    rawFrame: helloRequestFrame('a', { ...BETA8_HELLO, contractVersion: 'beta.8' }),
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [] },
    expectedClass: 'T-G',
    expectedOutcome: 'respond',
    expectedErrorArm: 'InvalidParamsEnvelope',
    expectedErrorCode: INVALID_PARAMS_CODE,
    expectedResponseFrame: JSON.stringify(RESPONSE_INVALID_PARAMS_A),
    zeroSideEffects: true,
    description: '[beta.8 H3] non-SemVer contractVersion is rejected before dispatch',
  },
  {
    id: 'T-G-6',
    rawFrame: helloRequestFrame('a', { ...BETA8_HELLO, wireVersion: 'wire-v1' }),
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [] },
    expectedClass: 'T-G',
    expectedOutcome: 'respond',
    expectedErrorArm: 'InvalidParamsEnvelope',
    expectedErrorCode: INVALID_PARAMS_CODE,
    expectedResponseFrame: JSON.stringify(RESPONSE_INVALID_PARAMS_A),
    zeroSideEffects: true,
    description: '[beta.8 H4] non-SemVer wireVersion is rejected before dispatch',
  },
  {
    id: 'T-G-7',
    rawFrame: helloRequestFrame('a', {
      ...BETA8_HELLO,
      pluginId: RAW_UTF8_BOUNDARY_CODE_POINTS.ascii.repeat(PLUGIN_ID_MAX_LENGTH + 1),
    }),
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [] },
    expectedClass: 'T-G',
    expectedOutcome: 'respond',
    expectedErrorArm: 'InvalidParamsEnvelope',
    expectedErrorCode: INVALID_PARAMS_CODE,
    expectedResponseFrame: JSON.stringify(RESPONSE_INVALID_PARAMS_A),
    zeroSideEffects: true,
    description: '[beta.8 H1 raw-byte N+1] oversize pluginId is rejected before dispatch',
  },
  {
    id: 'T-M-4',
    rawFrame: helloRequestFrame('a', {
      ...BETA8_HELLO,
      pluginId: RAW_UTF8_BOUNDARY_CODE_POINTS.multibyte.repeat(PLUGIN_ID_MAX_LENGTH),
    }),
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [] },
    expectedClass: 'T-M',
    expectedOutcome: 'accept',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    zeroSideEffects: true,
    description: '[beta.8 H1 multibyte N] maximum pluginId request is legal before dispatch',
  },
  {
    id: 'T-G-11',
    rawFrame: helloRequestFrame('a', {
      ...BETA8_HELLO,
      pluginId: RAW_UTF8_BOUNDARY_CODE_POINTS.multibyte.repeat(PLUGIN_ID_MAX_LENGTH + 1),
    }),
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [] },
    expectedClass: 'T-G',
    expectedOutcome: 'respond',
    expectedErrorArm: 'InvalidParamsEnvelope',
    expectedErrorCode: INVALID_PARAMS_CODE,
    expectedResponseFrame: JSON.stringify(RESPONSE_INVALID_PARAMS_A),
    zeroSideEffects: true,
    description: '[beta.8 H1 multibyte N+1] oversize pluginId is rejected before dispatch',
  },
  {
    id: 'T-M-5',
    rawFrame: helloRequestFrame('a', {
      ...BETA8_HELLO,
      pluginId: RAW_UTF8_BOUNDARY_CODE_POINTS.escaping.repeat(PLUGIN_ID_MAX_LENGTH),
    }),
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [] },
    expectedClass: 'T-M',
    expectedOutcome: 'accept',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    zeroSideEffects: true,
    description: '[beta.8 H1 JSON-escaping N] maximum pluginId request is legal before dispatch',
  },
  {
    id: 'T-G-12',
    rawFrame: helloRequestFrame('a', {
      ...BETA8_HELLO,
      pluginId: RAW_UTF8_BOUNDARY_CODE_POINTS.escaping.repeat(PLUGIN_ID_MAX_LENGTH + 1),
    }),
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [] },
    expectedClass: 'T-G',
    expectedOutcome: 'respond',
    expectedErrorArm: 'InvalidParamsEnvelope',
    expectedErrorCode: INVALID_PARAMS_CODE,
    expectedResponseFrame: JSON.stringify(RESPONSE_INVALID_PARAMS_A),
    zeroSideEffects: true,
    description: '[beta.8 H1 JSON-escaping N+1] oversize pluginId is rejected before dispatch',
  },
  {
    id: 'T-G-8',
    rawFrame: readyRequestFrame('a', { bindingNonce: 1 }),
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [] },
    expectedClass: 'T-G',
    expectedOutcome: 'respond',
    expectedErrorArm: 'InvalidParamsEnvelope',
    expectedErrorCode: INVALID_PARAMS_CODE,
    expectedResponseFrame: JSON.stringify(RESPONSE_INVALID_PARAMS_A),
    zeroSideEffects: true,
    description: '[beta.8 H9] broker.ready wrong-type bindingNonce is rejected before activation',
  },
  {
    id: 'T-G-9',
    rawFrame: readyRequestFrame('a', {
      bindingNonce: RAW_UTF8_BOUNDARY_CODE_POINTS.ascii.repeat(BINDING_NONCE_MAX_LENGTH + 1),
    }),
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [] },
    expectedClass: 'T-G',
    expectedOutcome: 'respond',
    expectedErrorArm: 'InvalidParamsEnvelope',
    expectedErrorCode: INVALID_PARAMS_CODE,
    expectedResponseFrame: JSON.stringify(RESPONSE_INVALID_PARAMS_A),
    zeroSideEffects: true,
    description: '[beta.8 H9 code-point N+1] oversize broker.ready bindingNonce is rejected before activation',
  },
  {
    id: 'T-M-6',
    rawFrame: readyRequestFrame('a', {
      bindingNonce: RAW_UTF8_BOUNDARY_CODE_POINTS.ascii.repeat(BINDING_NONCE_MAX_LENGTH),
    }),
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [] },
    expectedClass: 'T-M',
    expectedOutcome: 'accept',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    zeroSideEffects: true,
    description: '[beta.8 H9 ASCII N] maximum broker.ready bindingNonce is legal before activation',
  },
  {
    id: 'T-M-7',
    rawFrame: readyRequestFrame('a', {
      bindingNonce: RAW_UTF8_BOUNDARY_CODE_POINTS.multibyte.repeat(BINDING_NONCE_MAX_LENGTH),
    }),
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [] },
    expectedClass: 'T-M',
    expectedOutcome: 'accept',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    zeroSideEffects: true,
    description: '[beta.8 H9 multibyte N] maximum broker.ready bindingNonce is legal before activation',
  },
  {
    id: 'T-G-13',
    rawFrame: readyRequestFrame('a', {
      bindingNonce: RAW_UTF8_BOUNDARY_CODE_POINTS.multibyte.repeat(BINDING_NONCE_MAX_LENGTH + 1),
    }),
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [] },
    expectedClass: 'T-G',
    expectedOutcome: 'respond',
    expectedErrorArm: 'InvalidParamsEnvelope',
    expectedErrorCode: INVALID_PARAMS_CODE,
    expectedResponseFrame: JSON.stringify(RESPONSE_INVALID_PARAMS_A),
    zeroSideEffects: true,
    description: '[beta.8 H9 multibyte N+1] oversize broker.ready bindingNonce is rejected before activation',
  },
  {
    id: 'T-M-8',
    rawFrame: readyRequestFrame('a', {
      bindingNonce: RAW_UTF8_BOUNDARY_CODE_POINTS.escaping.repeat(BINDING_NONCE_MAX_LENGTH),
    }),
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [] },
    expectedClass: 'T-M',
    expectedOutcome: 'accept',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    zeroSideEffects: true,
    description: '[beta.8 H9 JSON-escaping N] maximum broker.ready bindingNonce is legal before activation',
  },
  {
    id: 'T-G-14',
    rawFrame: readyRequestFrame('a', {
      bindingNonce: RAW_UTF8_BOUNDARY_CODE_POINTS.escaping.repeat(BINDING_NONCE_MAX_LENGTH + 1),
    }),
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [] },
    expectedClass: 'T-G',
    expectedOutcome: 'respond',
    expectedErrorArm: 'InvalidParamsEnvelope',
    expectedErrorCode: INVALID_PARAMS_CODE,
    expectedResponseFrame: JSON.stringify(RESPONSE_INVALID_PARAMS_A),
    zeroSideEffects: true,
    description: '[beta.8 H9 JSON-escaping N+1] oversize broker.ready bindingNonce is rejected before activation',
  },
  {
    id: 'T-G-10',
    rawFrame: readyRequestFrame('a', {
      bindingNonce: 'nonce-1',
      pluginInstanceId: 'caller-injected',
    }),
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [] },
    expectedClass: 'T-G',
    expectedOutcome: 'respond',
    expectedErrorArm: 'HandshakeRejectedEnvelope',
    expectedErrorCode: HANDSHAKE_REJECTED_CODE,
    expectedResponseFrame: JSON.stringify(RESPONSE_HANDSHAKE_REJECTED_AUTHORITY_A),
    zeroSideEffects: true,
    description: '[beta.8 authority] broker.ready Host instance injection is rejected before activation',
  },
  {
    id: 'T-H-10',
    rawFrame: helloResultFrame('hello-h5-n-plus-1', {
      ...BETA8_BINDING,
      pluginInstanceId: 'a'.repeat(513),
    }),
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [{ id: 'hello-h5-n-plus-1', method: 'broker.hello', requestSnapshot: { candidateHello: BETA8_HELLO } }] },
    expectedClass: 'T-H',
    expectedOutcome: 'close',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    zeroSideEffects: true,
    description: '[beta.8 H5 raw-byte N+1] oversize Host instance id is rejected with a correlated hello snapshot',
  },
  {
    id: 'T-H-11',
    rawFrame: helloResultFrame('hello-h6-n-plus-1', {
      ...BETA8_BINDING,
      brokerSessionId: 'a'.repeat(513),
    }),
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [{ id: 'hello-h6-n-plus-1', method: 'broker.hello', requestSnapshot: { candidateHello: BETA8_HELLO } }] },
    expectedClass: 'T-H',
    expectedOutcome: 'close',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    zeroSideEffects: true,
    description: '[beta.8 H6 raw-byte N+1] oversize Host session id is rejected with a correlated hello snapshot',
  },
  {
    id: 'T-L-5',
    rawFrame: helloResultFrame('hello-binding', BETA8_BINDING),
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [{ id: 'hello-binding', method: 'broker.hello', requestSnapshot: { candidateHello: BETA8_HELLO } }] },
    expectedClass: 'T-L',
    expectedOutcome: 'accept',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    zeroSideEffects: true,
    description: '[beta.8 result] SessionBinding settles only with the correlated CandidateHello echo',
  },
  {
    id: 'T-L-6',
    rawFrame: JSON.stringify(RESPONSE_HANDSHAKE_REJECTED_HELLO),
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [{ id: 'hello-error', method: 'broker.hello', requestSnapshot: { candidateHello: BETA8_HELLO } }] },
    expectedClass: 'T-L',
    expectedOutcome: 'accept',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    zeroSideEffects: true,
    description: '[beta.8 error] closed HANDSHAKE_REJECTED error settles the correlated hello',
  },
  {
    id: 'T-M-9',
    rawFrame: '{"jsonrpc":"2.0","id":"publish-1","method":"events.publish","params":{"meta":{"deadlineUnixMs":1},"input":{"signalType":"feishu.meeting_artifact.generated.v1","eventId":"feishu-minute-om_abc123-v7","idempotencyKey":"feishu:minute:om_abc123:7","occurredAt":"2026-08-09T04:12:31Z","payload":{"artifactId":"om_abc123","revision":"7"},"source":{"handle":"feishu://meeting-artifacts/minute/om_abc123?revision=7"}}}}',
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [] },
    expectedClass: 'T-M',
    expectedOutcome: 'accept',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    zeroSideEffects: true,
    description: '[beta.9 C-2] declared-shape events.publish request reaches Host dispatch without a destination',
  },
  {
    id: 'T-G-15',
    rawFrame: '{"jsonrpc":"2.0","id":"a","method":"events.publish","params":{"meta":{"deadlineUnixMs":1},"input":{"signalType":"feishu.meeting_artifact.generated.v1","eventId":"event-1","idempotencyKey":"event-1","occurredAt":"2026-08-09T04:12:31Z","payload":{},"destination":{"threadId":"thread-1"}}}}',
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [] },
    expectedClass: 'T-G',
    expectedOutcome: 'respond',
    expectedErrorArm: 'InvalidParamsEnvelope',
    expectedErrorCode: INVALID_PARAMS_CODE,
    expectedResponseFrame: JSON.stringify(RESPONSE_INVALID_PARAMS_A),
    zeroSideEffects: true,
    description: '[beta.9 C-2] plugin-supplied destination is rejected before Host routing',
  },
  {
    id: 'T-H-12',
    rawFrame: '{"jsonrpc":"2.0","id":"publish-result","result":{"publicationId":"publication-1","disposition":"accepted","destination":"thread-1"}}',
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [{ id: 'publish-result', method: 'events.publish' }] },
    expectedClass: 'T-H',
    expectedOutcome: 'close',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    zeroSideEffects: true,
    description: '[beta.9 C-2] open Host receipt is rejected as a protocol violation',
  },
  {
    id: 'T-L-7',
    rawFrame: '{"jsonrpc":"2.0","id":"publish-result","result":{"publicationId":"publication-1","disposition":"duplicate"}}',
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [{ id: 'publish-result', method: 'events.publish' }] },
    expectedClass: 'T-L',
    expectedOutcome: 'accept',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    zeroSideEffects: true,
    description: '[beta.9 C-2] duplicate receipt legally settles a correlated publication',
  },
  {
    id: 'T-J-3',
    rawFrame: grantsChangedNotificationFrame(ALL_CAPABILITY_VALUES),
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [] },
    expectedClass: 'T-J',
    expectedOutcome: 'accept',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    description: '[beta.10 lifecycle] maximum legal grant snapshot notification reaches dispatch without a response',
  },
  {
    id: 'T-K-8',
    rawFrame: grantsChangedNotificationFrame([
      ...ALL_CAPABILITY_VALUES,
      ALL_CAPABILITY_VALUES[0]!,
    ]),
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [] },
    expectedClass: 'T-K',
    expectedOutcome: 'close',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    zeroSideEffects: true,
    description: '[beta.10 lifecycle] N+1 grant snapshot notification closes before dispatch',
  },
  {
    id: 'T-K-9',
    rawFrame: grantsChangedNotificationFrame([
      ALL_CAPABILITY_VALUES[0]!,
      ALL_CAPABILITY_VALUES[0]!,
    ]),
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [] },
    expectedClass: 'T-K',
    expectedOutcome: 'close',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    zeroSideEffects: true,
    description: '[beta.10 lifecycle] duplicate grants within the cardinality bound close before dispatch',
  },
  {
    id: 'T-K-10',
    rawFrame: grantsChangedNotificationFrame(['unknown.capability']),
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [] },
    expectedClass: 'T-K',
    expectedOutcome: 'close',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    zeroSideEffects: true,
    description: '[beta.10 lifecycle] unknown grant closes before dispatch',
  },
  {
    id: 'T-M-10',
    rawFrame: lifecycleRequestFrame('a', 'host.lifecycle.ping', {
      nonce: RAW_UTF8_BOUNDARY_CODE_POINTS.ascii.repeat(PING_NONCE_MAX_LENGTH),
    }),
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [] },
    expectedClass: 'T-M',
    expectedOutcome: 'accept',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    description: '[beta.10 lifecycle] maximum ASCII ping nonce reaches dispatch',
  },
  {
    id: 'T-G-16',
    rawFrame: lifecycleRequestFrame('a', 'host.lifecycle.ping', {
      nonce: RAW_UTF8_BOUNDARY_CODE_POINTS.ascii.repeat(PING_NONCE_MAX_LENGTH + 1),
    }),
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [] },
    expectedClass: 'T-G',
    expectedOutcome: 'respond',
    expectedErrorArm: 'InvalidParamsEnvelope',
    expectedErrorCode: INVALID_PARAMS_CODE,
    expectedResponseFrame: JSON.stringify(RESPONSE_INVALID_PARAMS_A),
    zeroSideEffects: true,
    description: '[beta.10 lifecycle] ASCII ping nonce N+1 rejects before dispatch',
  },
  {
    id: 'T-M-11',
    rawFrame: lifecycleRequestFrame('a', 'host.lifecycle.ping', {
      nonce: RAW_UTF8_BOUNDARY_CODE_POINTS.multibyte.repeat(PING_NONCE_MAX_LENGTH),
    }),
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [] },
    expectedClass: 'T-M',
    expectedOutcome: 'accept',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    description: '[beta.10 lifecycle] maximum multibyte ping nonce reaches dispatch',
  },
  {
    id: 'T-G-17',
    rawFrame: lifecycleRequestFrame('a', 'host.lifecycle.ping', {
      nonce: RAW_UTF8_BOUNDARY_CODE_POINTS.multibyte.repeat(PING_NONCE_MAX_LENGTH + 1),
    }),
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [] },
    expectedClass: 'T-G',
    expectedOutcome: 'respond',
    expectedErrorArm: 'InvalidParamsEnvelope',
    expectedErrorCode: INVALID_PARAMS_CODE,
    expectedResponseFrame: JSON.stringify(RESPONSE_INVALID_PARAMS_A),
    zeroSideEffects: true,
    description: '[beta.10 lifecycle] multibyte ping nonce N+1 rejects before dispatch',
  },
  {
    id: 'T-M-12',
    rawFrame: lifecycleRequestFrame('a', 'host.lifecycle.ping', {
      nonce: RAW_UTF8_BOUNDARY_CODE_POINTS.escaping.repeat(PING_NONCE_MAX_LENGTH),
    }),
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [] },
    expectedClass: 'T-M',
    expectedOutcome: 'accept',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    description: '[beta.10 lifecycle] maximum JSON-escaping ping nonce reaches dispatch',
  },
  {
    id: 'T-G-18',
    rawFrame: lifecycleRequestFrame('a', 'host.lifecycle.ping', {
      nonce: RAW_UTF8_BOUNDARY_CODE_POINTS.escaping.repeat(PING_NONCE_MAX_LENGTH + 1),
    }),
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [] },
    expectedClass: 'T-G',
    expectedOutcome: 'respond',
    expectedErrorArm: 'InvalidParamsEnvelope',
    expectedErrorCode: INVALID_PARAMS_CODE,
    expectedResponseFrame: JSON.stringify(RESPONSE_INVALID_PARAMS_A),
    zeroSideEffects: true,
    description: '[beta.10 lifecycle] JSON-escaping ping nonce N+1 rejects before dispatch',
  },
  {
    id: 'T-L-8',
    rawFrame: JSON.stringify({
      jsonrpc: '2.0',
      id: 'ping-max',
      result: { nonce: RAW_UTF8_BOUNDARY_CODE_POINTS.multibyte.repeat(PING_NONCE_MAX_LENGTH) },
    }),
    rawFrameEncoding: 'utf8',
    preState: {
      inFlightRequests: [{
        id: 'ping-max',
        method: 'host.lifecycle.ping',
        requestSnapshot: {
          nonce: RAW_UTF8_BOUNDARY_CODE_POINTS.multibyte.repeat(PING_NONCE_MAX_LENGTH),
        },
      }],
    },
    expectedClass: 'T-L',
    expectedOutcome: 'accept',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    description: '[beta.10 lifecycle] maximum ping nonce settles only when echoed byte-equal',
  },
  {
    id: 'T-H-13',
    rawFrame: JSON.stringify({
      jsonrpc: '2.0',
      id: 'ping-mismatch',
      result: { nonce: 'different' },
    }),
    rawFrameEncoding: 'utf8',
    preState: {
      inFlightRequests: [{
        id: 'ping-mismatch',
        method: 'host.lifecycle.ping',
        requestSnapshot: { nonce: 'expected' },
      }],
    },
    expectedClass: 'T-H',
    expectedOutcome: 'close',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    zeroSideEffects: true,
    description: '[beta.10 lifecycle] ping result with a non-equal nonce closes without settlement',
  },
  {
    id: 'T-M-13',
    rawFrame: lifecycleRequestFrame('drain-max', 'host.lifecycle.drain', {
      deadlineUnixMs: WIRE_UINT53_MAX,
    }),
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [] },
    expectedClass: 'T-M',
    expectedOutcome: 'accept',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    description: '[beta.10 lifecycle] maximum legal drain deadline reaches dispatch',
  },
  {
    id: 'T-G-19',
    rawFrame: lifecycleRequestFrame('a', 'host.lifecycle.drain', {
      deadlineUnixMs: WIRE_UINT53_MAX + 1,
    }),
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [] },
    expectedClass: 'T-G',
    expectedOutcome: 'respond',
    expectedErrorArm: 'InvalidParamsEnvelope',
    expectedErrorCode: INVALID_PARAMS_CODE,
    expectedResponseFrame: JSON.stringify(RESPONSE_INVALID_PARAMS_A),
    zeroSideEffects: true,
    description: '[beta.10 lifecycle] drain WireUInt53 N+1 rejects before dispatch',
  },
  {
    id: 'T-G-20',
    rawFrame: lifecycleRequestFrame('a', 'host.lifecycle.drain', {
      deadlineUnixMs: 0,
    }),
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [] },
    expectedClass: 'T-G',
    expectedOutcome: 'respond',
    expectedErrorArm: 'InvalidParamsEnvelope',
    expectedErrorCode: INVALID_PARAMS_CODE,
    expectedResponseFrame: JSON.stringify(RESPONSE_INVALID_PARAMS_A),
    zeroSideEffects: true,
    description: '[beta.10 lifecycle] zero drain deadline rejects before dispatch',
  },
  {
    id: 'T-L-9',
    rawFrame: '{"jsonrpc":"2.0","id":"drain-null","result":null}',
    rawFrameEncoding: 'utf8',
    preState: {
      inFlightRequests: [{ id: 'drain-null', method: 'host.lifecycle.drain' }],
    },
    expectedClass: 'T-L',
    expectedOutcome: 'accept',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    description: '[beta.10 lifecycle] exact null drain result settles its request',
  },
  {
    id: 'T-L-10',
    rawFrame: JSON.stringify(RESPONSE_DEADLINE_EXPIRED_DRAIN),
    rawFrameEncoding: 'utf8',
    preState: {
      inFlightRequests: [{ id: 'drain-deadline', method: 'host.lifecycle.drain' }],
    },
    expectedClass: 'T-L',
    expectedOutcome: 'accept',
    expectedErrorArm: null,
    expectedErrorCode: null,
    expectedResponseFrame: null,
    description: '[beta.10 lifecycle] DEADLINE_EXPIRED legally settles a drain request',
  },
  {
    id: 'T-M-14',
    rawFrame: messagingRequestFrame('send-1', 'messaging.send', M0C_DRAFT),
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [] },
    expectedClass: 'T-M', expectedOutcome: 'accept', expectedErrorArm: null,
    expectedErrorCode: null, expectedResponseFrame: null,
    description: '[beta.11 messaging] legal send reaches Host dispatch',
  },
  {
    id: 'T-G-21',
    rawFrame: messagingRequestFrame('a', 'messaging.send', { ...M0C_DRAFT, authority: 'host' }),
    rawFrameEncoding: 'utf8',
    preState: { inFlightRequests: [] },
    expectedClass: 'T-G', expectedOutcome: 'respond', expectedErrorArm: 'InvalidParamsEnvelope',
    expectedErrorCode: INVALID_PARAMS_CODE, expectedResponseFrame: JSON.stringify(RESPONSE_INVALID_PARAMS_A),
    zeroSideEffects: true,
    description: '[beta.11 messaging] authority-bearing send rejects before dispatch',
  },
  {
    id: 'T-M-15',
    rawFrame: messagingRequestFrame('append-1', 'messaging.appendElements', {
      handle: { kind: 'message', token: 'message-handle-1' },
      operationId: 'append-1',
      baseRevision: 1,
      elements: [{ elementId: 'element-2', kind: 'text', payload: { text: 'more' } }],
    }),
    rawFrameEncoding: 'utf8', preState: { inFlightRequests: [] },
    expectedClass: 'T-M', expectedOutcome: 'accept', expectedErrorArm: null,
    expectedErrorCode: null, expectedResponseFrame: null,
    description: '[beta.11 messaging] legal append reaches Host dispatch',
  },
  {
    id: 'T-G-22',
    rawFrame: messagingRequestFrame('a', 'messaging.appendElements', {
      handle: 'raw-handle', operationId: 'append-1', elements: [],
    }),
    rawFrameEncoding: 'utf8', preState: { inFlightRequests: [] },
    expectedClass: 'T-G', expectedOutcome: 'respond', expectedErrorArm: 'InvalidParamsEnvelope',
    expectedErrorCode: INVALID_PARAMS_CODE, expectedResponseFrame: JSON.stringify(RESPONSE_INVALID_PARAMS_A),
    zeroSideEffects: true,
    description: '[beta.11 messaging] malformed append rejects before dispatch',
  },
  {
    id: 'T-M-16',
    rawFrame: messagingRequestFrame('subscribe-1', 'messaging.subscribe', { handle: 'thread-handle-1' }),
    rawFrameEncoding: 'utf8', preState: { inFlightRequests: [] },
    expectedClass: 'T-M', expectedOutcome: 'accept', expectedErrorArm: null,
    expectedErrorCode: null, expectedResponseFrame: null,
    description: '[beta.11 messaging] legal subscribe reaches Host dispatch',
  },
  {
    id: 'T-G-23',
    rawFrame: messagingRequestFrame('a', 'messaging.subscribe', { handle: '' }),
    rawFrameEncoding: 'utf8', preState: { inFlightRequests: [] },
    expectedClass: 'T-G', expectedOutcome: 'respond', expectedErrorArm: 'InvalidParamsEnvelope',
    expectedErrorCode: INVALID_PARAMS_CODE, expectedResponseFrame: JSON.stringify(RESPONSE_INVALID_PARAMS_A),
    zeroSideEffects: true,
    description: '[beta.11 messaging] empty subscribe handle rejects before dispatch',
  },
  {
    id: 'T-M-17',
    rawFrame: messagingRequestFrame('read-1', 'messaging.read', { subscriptionId: 'subscription-1', limit: 2 }),
    rawFrameEncoding: 'utf8', preState: { inFlightRequests: [] },
    expectedClass: 'T-M', expectedOutcome: 'accept', expectedErrorArm: null,
    expectedErrorCode: null, expectedResponseFrame: null,
    description: '[beta.11 messaging] legal read reaches Host dispatch',
  },
  {
    id: 'T-G-24',
    rawFrame: messagingRequestFrame('a', 'messaging.read', { subscriptionId: 'subscription-1', limit: 33 }),
    rawFrameEncoding: 'utf8', preState: { inFlightRequests: [] },
    expectedClass: 'T-G', expectedOutcome: 'respond', expectedErrorArm: 'InvalidParamsEnvelope',
    expectedErrorCode: INVALID_PARAMS_CODE, expectedResponseFrame: JSON.stringify(RESPONSE_INVALID_PARAMS_A),
    zeroSideEffects: true,
    description: '[beta.11 messaging] read limit N+1 rejects before dispatch',
  },
  {
    id: 'T-M-18',
    rawFrame: messagingRequestFrame('ack-1', 'messaging.ack', { subscriptionId: 'subscription-1', ackToken: 'ack-1' }),
    rawFrameEncoding: 'utf8', preState: { inFlightRequests: [] },
    expectedClass: 'T-M', expectedOutcome: 'accept', expectedErrorArm: null,
    expectedErrorCode: null, expectedResponseFrame: null,
    description: '[beta.11 messaging] legal acknowledgement reaches Host dispatch',
  },
  {
    id: 'T-G-25',
    rawFrame: messagingRequestFrame('a', 'messaging.ack', { subscriptionId: 'subscription-1', ackToken: '' }),
    rawFrameEncoding: 'utf8', preState: { inFlightRequests: [] },
    expectedClass: 'T-G', expectedOutcome: 'respond', expectedErrorArm: 'InvalidParamsEnvelope',
    expectedErrorCode: INVALID_PARAMS_CODE, expectedResponseFrame: JSON.stringify(RESPONSE_INVALID_PARAMS_A),
    zeroSideEffects: true,
    description: '[beta.11 messaging] empty acknowledgement token rejects before dispatch',
  },
  {
    id: 'T-M-19',
    rawFrame: messagingRequestFrame('snapshot-1', 'messaging.snapshot', { subscriptionId: 'subscription-1', maxItems: 2 }),
    rawFrameEncoding: 'utf8', preState: { inFlightRequests: [] },
    expectedClass: 'T-M', expectedOutcome: 'accept', expectedErrorArm: null,
    expectedErrorCode: null, expectedResponseFrame: null,
    description: '[beta.11 messaging] legal snapshot page reaches Host dispatch',
  },
  {
    id: 'T-G-26',
    rawFrame: messagingRequestFrame('a', 'messaging.snapshot', { subscriptionId: 'subscription-1', maxItems: 0 }),
    rawFrameEncoding: 'utf8', preState: { inFlightRequests: [] },
    expectedClass: 'T-G', expectedOutcome: 'respond', expectedErrorArm: 'InvalidParamsEnvelope',
    expectedErrorCode: INVALID_PARAMS_CODE, expectedResponseFrame: JSON.stringify(RESPONSE_INVALID_PARAMS_A),
    zeroSideEffects: true,
    description: '[beta.11 messaging] zero snapshot maxItems rejects before dispatch',
  },
  {
    id: 'T-M-20',
    rawFrame: messagingRequestFrame('deliver-1', 'host.messaging.deliver', {
      deliveryId: 'delivery-1',
      threadHandle: { kind: 'thread_handle', handle: 'thread-handle-1' },
      envelope: M0C_ENVELOPE,
    }),
    rawFrameEncoding: 'utf8', preState: { inFlightRequests: [] },
    expectedClass: 'T-M', expectedOutcome: 'accept', expectedErrorArm: null,
    expectedErrorCode: null, expectedResponseFrame: null,
    description: '[beta.11 messaging] legal Host delivery reaches plugin dispatch',
  },
  {
    id: 'T-G-27',
    rawFrame: messagingRequestFrame('a', 'host.messaging.deliver', {
      deliveryId: 'delivery-1',
      threadHandle: { kind: 'thread_handle', handle: 'thread-handle-1' },
      envelope: { ...M0C_ENVELOPE, occurredAt: '2026-08-18T03:00:00Z' },
    }),
    rawFrameEncoding: 'utf8', preState: { inFlightRequests: [] },
    expectedClass: 'T-G', expectedOutcome: 'respond', expectedErrorArm: 'InvalidParamsEnvelope',
    expectedErrorCode: INVALID_PARAMS_CODE, expectedResponseFrame: JSON.stringify(RESPONSE_INVALID_PARAMS_A),
    zeroSideEffects: true,
    description: '[beta.11 messaging] non-canonical stored timestamp rejects before callback dispatch',
  },
  {
    id: 'T-L-11',
    rawFrame: JSON.stringify({ jsonrpc: '2.0', id: 'send-result', result: {
      messageId: 'message-1', threadId: 'thread-1', revision: 1,
      messageHandle: { kind: 'message', token: 'message-handle-1' },
    } }),
    rawFrameEncoding: 'utf8', preState: { inFlightRequests: [{ id: 'send-result', method: 'messaging.send' }] },
    expectedClass: 'T-L', expectedOutcome: 'accept', expectedErrorArm: null,
    expectedErrorCode: null, expectedResponseFrame: null,
    description: '[beta.11 messaging] closed send receipt settles the request',
  },
  {
    id: 'T-H-14',
    rawFrame: JSON.stringify({ jsonrpc: '2.0', id: 'send-legacy', result: {
      messageId: 'message-1', threadId: 'thread-1', revision: 1,
      handle: { kind: 'message', token: 'message-handle-1' },
    } }),
    rawFrameEncoding: 'utf8', preState: { inFlightRequests: [{ id: 'send-legacy', method: 'messaging.send' }] },
    expectedClass: 'T-H', expectedOutcome: 'close', expectedErrorArm: null,
    expectedErrorCode: null, expectedResponseFrame: null, zeroSideEffects: true,
    description: '[beta.11 messaging] legacy send receipt closes without settlement',
  },
  {
    id: 'T-L-12',
    rawFrame: JSON.stringify({ jsonrpc: '2.0', id: 'append-result', result: {
      messageId: 'message-1', revision: 2, appliedElementIds: ['element-2'],
    } }),
    rawFrameEncoding: 'utf8', preState: { inFlightRequests: [{ id: 'append-result', method: 'messaging.appendElements' }] },
    expectedClass: 'T-L', expectedOutcome: 'accept', expectedErrorArm: null,
    expectedErrorCode: null, expectedResponseFrame: null,
    description: '[beta.11 messaging] closed append receipt settles the request',
  },
  {
    id: 'T-H-15',
    rawFrame: JSON.stringify({ jsonrpc: '2.0', id: 'append-empty', result: {
      messageId: 'message-1', revision: 2, appliedElementIds: [],
    } }),
    rawFrameEncoding: 'utf8', preState: { inFlightRequests: [{ id: 'append-empty', method: 'messaging.appendElements' }] },
    expectedClass: 'T-H', expectedOutcome: 'close', expectedErrorArm: null,
    expectedErrorCode: null, expectedResponseFrame: null, zeroSideEffects: true,
    description: '[beta.11 messaging] empty append receipt closes without settlement',
  },
  {
    id: 'T-L-13',
    rawFrame: '{"jsonrpc":"2.0","id":"subscribe-result","result":{"subscriptionId":"subscription-1"}}',
    rawFrameEncoding: 'utf8', preState: { inFlightRequests: [{ id: 'subscribe-result', method: 'messaging.subscribe' }] },
    expectedClass: 'T-L', expectedOutcome: 'accept', expectedErrorArm: null,
    expectedErrorCode: null, expectedResponseFrame: null,
    description: '[beta.11 messaging] closed subscription receipt settles the request',
  },
  {
    id: 'T-H-16',
    rawFrame: '{"jsonrpc":"2.0","id":"subscribe-open","result":{"subscriptionId":"subscription-1","extra":true}}',
    rawFrameEncoding: 'utf8', preState: { inFlightRequests: [{ id: 'subscribe-open', method: 'messaging.subscribe' }] },
    expectedClass: 'T-H', expectedOutcome: 'close', expectedErrorArm: null,
    expectedErrorCode: null, expectedResponseFrame: null, zeroSideEffects: true,
    description: '[beta.11 messaging] open subscription receipt closes without settlement',
  },
  {
    id: 'T-L-14',
    rawFrame: '{"jsonrpc":"2.0","id":"read-result","result":{"events":[],"ackToken":null,"stale":false}}',
    rawFrameEncoding: 'utf8', preState: { inFlightRequests: [{ id: 'read-result', method: 'messaging.read', requestSnapshot: { readLimit: 2 } }] },
    expectedClass: 'T-L', expectedOutcome: 'accept', expectedErrorArm: null,
    expectedErrorCode: null, expectedResponseFrame: null,
    description: '[beta.11 messaging] empty read page settles the request',
  },
  {
    id: 'T-H-17',
    rawFrame: JSON.stringify({ jsonrpc: '2.0', id: 'read-over-limit', result: {
      events: [M0C_PUBLISH_EVENT, { ...M0C_PUBLISH_EVENT, eventId: 'event-2', sequence: 2 }],
      ackToken: 'ack-2', stale: false,
    } }),
    rawFrameEncoding: 'utf8', preState: { inFlightRequests: [{ id: 'read-over-limit', method: 'messaging.read', requestSnapshot: { readLimit: 1 } }] },
    expectedClass: 'T-H', expectedOutcome: 'close', expectedErrorArm: null,
    expectedErrorCode: null, expectedResponseFrame: null, zeroSideEffects: true,
    description: '[beta.11 messaging] read page beyond the request limit closes without cursor progress',
  },
  {
    id: 'T-L-15', rawFrame: '{"jsonrpc":"2.0","id":"ack-result","result":null}',
    rawFrameEncoding: 'utf8', preState: { inFlightRequests: [{ id: 'ack-result', method: 'messaging.ack' }] },
    expectedClass: 'T-L', expectedOutcome: 'accept', expectedErrorArm: null,
    expectedErrorCode: null, expectedResponseFrame: null,
    description: '[beta.11 messaging] null acknowledgement settles the request',
  },
  {
    id: 'T-H-18', rawFrame: '{"jsonrpc":"2.0","id":"ack-open","result":{}}',
    rawFrameEncoding: 'utf8', preState: { inFlightRequests: [{ id: 'ack-open', method: 'messaging.ack' }] },
    expectedClass: 'T-H', expectedOutcome: 'close', expectedErrorArm: null,
    expectedErrorCode: null, expectedResponseFrame: null, zeroSideEffects: true,
    description: '[beta.11 messaging] non-null acknowledgement closes without cursor progress',
  },
  {
    id: 'T-L-16',
    rawFrame: JSON.stringify({ jsonrpc: '2.0', id: 'snapshot-result', result: {
      items: [], nextPageToken: null, snapshotAckToken: 'snapshot-ack-1',
    } }),
    rawFrameEncoding: 'utf8', preState: { inFlightRequests: [{ id: 'snapshot-result', method: 'messaging.snapshot', requestSnapshot: { snapshotMaxItems: 2 } }] },
    expectedClass: 'T-L', expectedOutcome: 'accept', expectedErrorArm: null,
    expectedErrorCode: null, expectedResponseFrame: null,
    description: '[beta.11 messaging] final snapshot page settles the traversal request',
  },
  {
    id: 'T-H-19',
    rawFrame: JSON.stringify({ jsonrpc: '2.0', id: 'snapshot-over-limit', result: {
      items: [M0C_ENVELOPE, { ...M0C_ENVELOPE, messageId: 'message-2' }],
      nextPageToken: null, snapshotAckToken: 'snapshot-ack-2',
    } }),
    rawFrameEncoding: 'utf8', preState: { inFlightRequests: [{ id: 'snapshot-over-limit', method: 'messaging.snapshot', requestSnapshot: { snapshotMaxItems: 1 } }] },
    expectedClass: 'T-H', expectedOutcome: 'close', expectedErrorArm: null,
    expectedErrorCode: null, expectedResponseFrame: null, zeroSideEffects: true,
    description: '[beta.11 messaging] snapshot page beyond request maxItems closes without progress',
  },
  {
    id: 'T-L-17',
    rawFrame: '{"jsonrpc":"2.0","id":"deliver-result","result":{"deliveryId":"delivery-1"}}',
    rawFrameEncoding: 'utf8', preState: { inFlightRequests: [{ id: 'deliver-result', method: 'host.messaging.deliver', requestSnapshot: { deliveryId: 'delivery-1' } }] },
    expectedClass: 'T-L', expectedOutcome: 'accept', expectedErrorArm: null,
    expectedErrorCode: null, expectedResponseFrame: null,
    description: '[beta.11 messaging] byte-equal delivery acknowledgement settles the callback',
  },
  {
    id: 'T-H-20',
    rawFrame: '{"jsonrpc":"2.0","id":"deliver-mismatch","result":{"deliveryId":"wrong-delivery"}}',
    rawFrameEncoding: 'utf8', preState: { inFlightRequests: [{ id: 'deliver-mismatch', method: 'host.messaging.deliver', requestSnapshot: { deliveryId: 'delivery-1' } }] },
    expectedClass: 'T-H', expectedOutcome: 'close', expectedErrorArm: null,
    expectedErrorCode: null, expectedResponseFrame: null, zeroSideEffects: true,
    description: '[beta.11 messaging] mismatched delivery acknowledgement closes without settlement',
  },
];

/** Complete beta.8 handshake safety surface exported for downstream runners. */
export const BETA8_HANDSHAKE_VECTOR_IDS = [
  'T-C-2',
  'T-M-1', 'T-M-2', 'T-M-3', 'T-M-4', 'T-M-5', 'T-M-6', 'T-M-7', 'T-M-8',
  'T-G-2', 'T-G-3', 'T-G-4', 'T-G-5', 'T-G-6', 'T-G-7', 'T-G-8', 'T-G-9', 'T-G-10',
  'T-G-11', 'T-G-12', 'T-G-13', 'T-G-14',
  'T-H-10', 'T-H-11',
  'T-L-5', 'T-L-6',
] as const;

/** Complete beta.9 C-2 publish safety surface exported for downstream runners. */
export const BETA9_EVENTS_PUBLISH_VECTOR_IDS = [
  'T-M-9',
  'T-G-15',
  'T-H-12',
  'T-L-7',
] as const;

/** Complete beta.10 M0-B lifecycle safety surface for rows 10 through 12. */
export const BETA10_LIFECYCLE_VECTOR_IDS = [
  'T-G-1',
  'T-J-1',
  'T-J-2',
  'T-K-1',
  'T-K-4',
  'T-K-5',
  'T-K-6',
  'T-K-7',
  'T-H-3',
  'T-L-1',
  'T-L-2',
  'T-L-3',
  'T-J-3',
  'T-K-8',
  'T-K-9',
  'T-K-10',
  'T-M-10',
  'T-G-16',
  'T-M-11',
  'T-G-17',
  'T-M-12',
  'T-G-18',
  'T-L-8',
  'T-H-13',
  'T-M-13',
  'T-G-19',
  'T-G-20',
  'T-L-9',
  'T-L-10',
] as const;

/** Complete beta.11 M0-C messaging safety surface for rows 3 through 9. */
export const BETA11_MESSAGING_VECTOR_IDS = [
  'T-H-2', 'T-H-5', 'T-H-9', 'T-L-4',
  'T-M-14', 'T-G-21', 'T-M-15', 'T-G-22', 'T-M-16', 'T-G-23',
  'T-M-17', 'T-G-24', 'T-M-18', 'T-G-25', 'T-M-19', 'T-G-26',
  'T-M-20', 'T-G-27',
  'T-L-11', 'T-H-14', 'T-L-12', 'T-H-15', 'T-L-13', 'T-H-16',
  'T-L-14', 'T-H-17', 'T-L-15', 'T-H-18', 'T-L-16', 'T-H-19',
  'T-L-17', 'T-H-20',
] as const;
