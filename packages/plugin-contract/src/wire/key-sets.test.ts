/**
 * Drift-prevention tests for the co-located closed-shape key sets.
 *
 * Every key set in envelope.ts / row-shapes.ts / errors.ts / handshake.ts
 * is a runtime companion of the contract interface it mirrors. These tests
 * anchor each key set to its type source and fail if they drift apart.
 *
 * TWO-LAYER DRIFT DETECTION (ported from the SDK's contract-mirror.test.ts,
 * F202 C1 — the mirror layer moved into the contract):
 *
 * 1. **Compile-time**: ExactKeys<ContractType, LiteralUnion> type assertions
 *    fail at `tsc --noEmit` time when the contract interface adds or removes
 *    a field. No runtime cost.
 *
 * 2. **Runtime**: each test verifies the key set has the expected
 *    cardinality and members. Catches literal drift.
 *
 * Schema-generated key sets (M0C_*_KEYS from contract.generated.ts) are
 * generated from the same schema that types them, so no drift test is
 * needed — but a sanity test guards against generator regressions.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  REQUEST_ALLOWED_KEYS,
  NOTIFICATION_ALLOWED_KEYS,
  RESPONSE_SUCCESS_KEYS,
  RESPONSE_ERROR_KEYS,
  PARAMS_ALLOWED_KEYS,
  META_ALLOWED_KEYS,
} from './envelope.js';
import {
  PING_INPUT_KEYS,
  PING_RESULT_KEYS,
  DRAIN_INPUT_KEYS,
  GRANTS_CHANGED_INPUT_KEYS,
} from './row-shapes.js';
import {
  ERROR_BODY_STANDARD_KEYS,
  ERROR_BODY_APPLICATION_KEYS,
  REASON_DATA_KEYS,
  CODE_DATA_KEYS,
} from './errors.js';
import {
  CANDIDATE_HELLO_KEYS,
  SESSION_BINDING_KEYS,
  BROKER_READY_PARAMS_KEYS,
} from './handshake.js';

// ---------------------------------------------------------------------------
// Contract type imports — compile-time drift anchors (co-located modules)
// ---------------------------------------------------------------------------

import type {
  WireRequest,
  WireNotification,
  WireSuccessResponse,
  CallMeta,
  ParseErrorEnvelope,
  HandshakeRejectedEnvelope,
  DeliveryRejectedEnvelope,
  DomainErrorEnvelope,
  DeadlineExpiredEnvelope,
  SnapshotUnavailableEnvelope,
  InvalidRequestNullIdEnvelope,
  InvalidRequestValidIdEnvelope,
  MethodNotFoundEnvelope,
  InvalidParamsEnvelope,
  InternalErrorEnvelope,
} from './envelope.js';
import type {
  PingInput,
  PingResult,
  DrainInput,
  GrantsChangedInput,
} from './row-shapes.js';
import type {
  ParseError,
  InvalidRequestError,
  MethodNotFoundError,
  InvalidParamsError,
  InternalError,
  HandshakeRejectedError,
  DeliveryRejectedError,
  DomainError,
  DeadlineExpiredError,
  SnapshotUnavailableError,
} from './errors.js';
import type {
  CandidateHello,
  SessionBinding,
  BrokerReadyParams,
} from './handshake.js';

// ---------------------------------------------------------------------------
// Compile-time drift detection: ExactKeys type utility
// ---------------------------------------------------------------------------

/**
 * Evaluates to `true` iff `keyof T` is exactly the string literal union K.
 * Bidirectional: catches both additions and removals.
 *
 * If the contract interface changes, the const assignment fails at tsc time
 * with "Type 'false' is not assignable to type 'true'".
 *
 * Tuple wrapping [A] extends [B] prevents union distribution.
 */
type ExactKeys<T, K extends string> =
  [keyof T & string] extends [K] ? [K] extends [keyof T & string] ? true : false : false;

// ── RESPONSE_SUCCESS_KEYS ── (1 type: WireSuccessResponse)
const _d01: ExactKeys<WireSuccessResponse<unknown>, 'jsonrpc' | 'id' | 'result'> = true;

// ── RESPONSE_ERROR_KEYS ── (11 concrete error envelopes, all must match)
const _d02: ExactKeys<ParseErrorEnvelope, 'jsonrpc' | 'id' | 'error'> = true;
const _d03: ExactKeys<HandshakeRejectedEnvelope, 'jsonrpc' | 'id' | 'error'> = true;
const _d04: ExactKeys<DeliveryRejectedEnvelope, 'jsonrpc' | 'id' | 'error'> = true;
const _d05: ExactKeys<DomainErrorEnvelope, 'jsonrpc' | 'id' | 'error'> = true;
const _d06: ExactKeys<DeadlineExpiredEnvelope, 'jsonrpc' | 'id' | 'error'> = true;
const _d07: ExactKeys<SnapshotUnavailableEnvelope, 'jsonrpc' | 'id' | 'error'> = true;
const _d08: ExactKeys<InvalidRequestNullIdEnvelope, 'jsonrpc' | 'id' | 'error'> = true;
const _d09: ExactKeys<InvalidRequestValidIdEnvelope, 'jsonrpc' | 'id' | 'error'> = true;
const _d10: ExactKeys<MethodNotFoundEnvelope, 'jsonrpc' | 'id' | 'error'> = true;
const _d11: ExactKeys<InvalidParamsEnvelope, 'jsonrpc' | 'id' | 'error'> = true;
const _d12: ExactKeys<InternalErrorEnvelope, 'jsonrpc' | 'id' | 'error'> = true;

// ── REQUEST_ALLOWED_KEYS / NOTIFICATION_ALLOWED_KEYS ──
const _d13: ExactKeys<WireRequest, 'jsonrpc' | 'id' | 'method' | 'params'> = true;
const _d14: ExactKeys<WireNotification, 'jsonrpc' | 'method' | 'params'> = true;

// ── PARAMS_ALLOWED_KEYS ── (both Request and Notification params)
const _d15: ExactKeys<WireRequest['params'], 'meta' | 'input'> = true;
const _d16: ExactKeys<WireNotification['params'], 'meta' | 'input'> = true;

// ── META_ALLOWED_KEYS ──
const _d17: ExactKeys<CallMeta, 'deadlineUnixMs'> = true;

// ── Per-method CLOSED-row input shapes (1:1, no shared mirrors) ──
const _d18: ExactKeys<PingInput, 'nonce'> = true;
const _d19: ExactKeys<DrainInput, 'deadlineUnixMs'> = true;
const _d22: ExactKeys<GrantsChangedInput, 'grantRevision' | 'effectiveGrants'> = true;

// ── Handshake structural shapes ──
const _d22a: ExactKeys<CandidateHello, 'pluginId' | 'packageDigest' | 'contractVersion' | 'wireVersion'> = true;
const _d22b: ExactKeys<SessionBinding, 'pluginId' | 'packageDigest' | 'contractVersion' | 'wireVersion' | 'pluginInstanceId' | 'brokerSessionId' | 'grantRevision' | 'effectiveGrants' | 'bindingNonce'> = true;
const _d22c: ExactKeys<BrokerReadyParams, 'bindingNonce'> = true;

// ── Per-method CLOSED-row result shapes (1:1, no shared mirrors) ──
const _d23: ExactKeys<PingResult, 'nonce'> = true;

// ── ERROR_BODY_STANDARD_KEYS ── (all 5 standard error arms)
const _d25: ExactKeys<ParseError, 'code' | 'message'> = true;
const _d26: ExactKeys<InvalidRequestError, 'code' | 'message'> = true;
const _d27: ExactKeys<MethodNotFoundError, 'code' | 'message'> = true;
const _d28: ExactKeys<InvalidParamsError, 'code' | 'message'> = true;
const _d29: ExactKeys<InternalError, 'code' | 'message'> = true;

// ── ERROR_BODY_APPLICATION_KEYS ── (all 5 application error arms)
const _d30: ExactKeys<HandshakeRejectedError, 'code' | 'message' | 'data'> = true;
const _d31: ExactKeys<DeliveryRejectedError, 'code' | 'message' | 'data'> = true;
const _d32: ExactKeys<DomainError, 'code' | 'message' | 'data'> = true;
const _d33: ExactKeys<DeadlineExpiredError, 'code' | 'message' | 'data'> = true;
const _d34: ExactKeys<SnapshotUnavailableError, 'code' | 'message' | 'data'> = true;

// ── REASON_DATA_KEYS ── (all 3 reason-bearing error data arms)
const _d35: ExactKeys<HandshakeRejectedError['data'], 'reason'> = true;
const _d36: ExactKeys<DeliveryRejectedError['data'], 'reason'> = true;
const _d37: ExactKeys<SnapshotUnavailableError['data'], 'reason'> = true;

// ── CODE_DATA_KEYS ── (1 type: DomainError.data)
const _d38: ExactKeys<DomainError['data'], 'code'> = true;

// Suppress "unused" — these are compile-time-only sentinels.
void _d01; void _d02; void _d03; void _d04; void _d05; void _d06;
void _d07; void _d08; void _d09; void _d10; void _d11; void _d12;
void _d13; void _d14; void _d15; void _d16; void _d17; void _d18;
void _d19; void _d22; void _d23;
void _d22a; void _d22b; void _d22c;
void _d25; void _d26; void _d27; void _d28; void _d29; void _d30;
void _d31; void _d32; void _d33; void _d34; void _d35; void _d36;
void _d37; void _d38;

// ---------------------------------------------------------------------------
// Runtime drift tests: envelope key sets
//
// These verify the co-located Set has the expected cardinality and members.
// Compile-time ExactKeys assertions (above) anchor each key set to the
// contract interface — if the contract adds/removes a field, tsc fails
// before these runtime tests even run. These runtime tests catch literal
// drift (someone changes the Set without updating the interface).
// ---------------------------------------------------------------------------

test('RESPONSE_SUCCESS_KEYS matches WireSuccessResponse interface', () => {
  assert.equal(RESPONSE_SUCCESS_KEYS.size, 3);
  assert.ok(RESPONSE_SUCCESS_KEYS.has('jsonrpc'));
  assert.ok(RESPONSE_SUCCESS_KEYS.has('id'));
  assert.ok(RESPONSE_SUCCESS_KEYS.has('result'));
});

test('RESPONSE_ERROR_KEYS matches the error envelope variants', () => {
  // WireApplicationErrorResponse / WireStandardErrorResponse: { jsonrpc, id, error }
  assert.equal(RESPONSE_ERROR_KEYS.size, 3);
  assert.ok(RESPONSE_ERROR_KEYS.has('jsonrpc'));
  assert.ok(RESPONSE_ERROR_KEYS.has('id'));
  assert.ok(RESPONSE_ERROR_KEYS.has('error'));
});

test('NOTIFICATION_ALLOWED_KEYS matches WireNotification interface', () => {
  assert.equal(NOTIFICATION_ALLOWED_KEYS.size, 3);
  assert.ok(NOTIFICATION_ALLOWED_KEYS.has('jsonrpc'));
  assert.ok(NOTIFICATION_ALLOWED_KEYS.has('method'));
  assert.ok(NOTIFICATION_ALLOWED_KEYS.has('params'));
});

test('REQUEST_ALLOWED_KEYS matches WireRequest interface', () => {
  assert.equal(REQUEST_ALLOWED_KEYS.size, 4);
  assert.ok(REQUEST_ALLOWED_KEYS.has('jsonrpc'));
  assert.ok(REQUEST_ALLOWED_KEYS.has('id'));
  assert.ok(REQUEST_ALLOWED_KEYS.has('method'));
  assert.ok(REQUEST_ALLOWED_KEYS.has('params'));
});

test('PARAMS_ALLOWED_KEYS matches WireRequest.params / WireNotification.params', () => {
  assert.equal(PARAMS_ALLOWED_KEYS.size, 2);
  assert.ok(PARAMS_ALLOWED_KEYS.has('meta'));
  assert.ok(PARAMS_ALLOWED_KEYS.has('input'));
});

test('META_ALLOWED_KEYS matches CallMeta interface', () => {
  assert.equal(META_ALLOWED_KEYS.size, 1);
  assert.ok(META_ALLOWED_KEYS.has('deadlineUnixMs'));
});

// ---------------------------------------------------------------------------
// Structural drift tests: per-method input key sets
// ---------------------------------------------------------------------------

test('PING_INPUT_KEYS matches PingInput interface', () => {
  assert.equal(PING_INPUT_KEYS.size, 1);
  assert.ok(PING_INPUT_KEYS.has('nonce'));
});

test('DRAIN_INPUT_KEYS matches DrainInput interface', () => {
  assert.equal(DRAIN_INPUT_KEYS.size, 1);
  assert.ok(DRAIN_INPUT_KEYS.has('deadlineUnixMs'));
});

test('GRANTS_CHANGED_INPUT_KEYS matches GrantSnapshot interface', () => {
  assert.equal(GRANTS_CHANGED_INPUT_KEYS.size, 2);
  assert.ok(GRANTS_CHANGED_INPUT_KEYS.has('grantRevision'));
  assert.ok(GRANTS_CHANGED_INPUT_KEYS.has('effectiveGrants'));
});

test('handshake key sets match their structural contract interfaces', () => {
  assert.deepEqual([...CANDIDATE_HELLO_KEYS], [
    'pluginId',
    'packageDigest',
    'contractVersion',
    'wireVersion',
  ]);
  assert.deepEqual([...SESSION_BINDING_KEYS], [
    'pluginId',
    'packageDigest',
    'contractVersion',
    'wireVersion',
    'pluginInstanceId',
    'brokerSessionId',
    'grantRevision',
    'effectiveGrants',
    'bindingNonce',
  ]);
  assert.deepEqual([...BROKER_READY_PARAMS_KEYS], ['bindingNonce']);
});

// ---------------------------------------------------------------------------
// Structural drift tests: per-method result key sets
// ---------------------------------------------------------------------------

test('PING_RESULT_KEYS matches PingResult interface', () => {
  assert.equal(PING_RESULT_KEYS.size, 1);
  assert.ok(PING_RESULT_KEYS.has('nonce'));
});

// ---------------------------------------------------------------------------
// Structural drift tests: error body key sets
// ---------------------------------------------------------------------------

test('ERROR_BODY_STANDARD_KEYS matches StandardWireError body', () => {
  // Standard: { code, message } — no data
  assert.equal(ERROR_BODY_STANDARD_KEYS.size, 2);
  assert.ok(ERROR_BODY_STANDARD_KEYS.has('code'));
  assert.ok(ERROR_BODY_STANDARD_KEYS.has('message'));
});

test('ERROR_BODY_APPLICATION_KEYS matches ApplicationWireError body', () => {
  // Application: { code, message, data }
  assert.equal(ERROR_BODY_APPLICATION_KEYS.size, 3);
  assert.ok(ERROR_BODY_APPLICATION_KEYS.has('code'));
  assert.ok(ERROR_BODY_APPLICATION_KEYS.has('message'));
  assert.ok(ERROR_BODY_APPLICATION_KEYS.has('data'));
});

test('REASON_DATA_KEYS matches per-arm data: {reason}', () => {
  assert.equal(REASON_DATA_KEYS.size, 1);
  assert.ok(REASON_DATA_KEYS.has('reason'));
});

test('CODE_DATA_KEYS matches DomainError data: {code}', () => {
  assert.equal(CODE_DATA_KEYS.size, 1);
  assert.ok(CODE_DATA_KEYS.has('code'));
});

// ---------------------------------------------------------------------------
// Generated key sets sanity (no drift test needed — same schema truth source)
// ---------------------------------------------------------------------------

import {
  M0CSUBSCRIBE_INPUT_KEYS,
  M0CSUBSCRIBE_RESULT_KEYS,
  M0CACK_INPUT_KEYS,
  M0CDELIVER_INPUT_KEYS,
  M0CDELIVER_RESULT_KEYS,
  M0CREAD_INPUT_KEYS,
  MESSAGING_ERROR_CODE_VALUES,
} from '../generated/contract.generated.js';
import type {
  M0CAckInput,
  M0CDeliverResult,
  M0CSubscribeInput,
  MessagingErrorCode,
} from '../generated/contract.generated.js';

// Compile-time: generated key sets name exactly the generated type's fields.
const _g01: ExactKeys<M0CSubscribeInput, (typeof M0CSUBSCRIBE_INPUT_KEYS)[number]> = true;
const _g02: ExactKeys<M0CAckInput, (typeof M0CACK_INPUT_KEYS)[number]> = true;
const _g03: ExactKeys<M0CDeliverResult, (typeof M0CDELIVER_RESULT_KEYS)[number]> = true;
void _g01; void _g02; void _g03;

test('generated M0C key sets match their schema-declared members and order', () => {
  assert.deepEqual([...M0CSUBSCRIBE_INPUT_KEYS], ['handle']);
  assert.deepEqual([...M0CSUBSCRIBE_RESULT_KEYS], ['subscriptionId']);
  assert.deepEqual([...M0CACK_INPUT_KEYS], ['subscriptionId', 'ackToken']);
  assert.deepEqual([...M0CREAD_INPUT_KEYS], ['subscriptionId', 'limit']);
  assert.deepEqual([...M0CDELIVER_RESULT_KEYS], ['deliveryId']);
  assert.deepEqual([...M0CDELIVER_INPUT_KEYS], ['deliveryId', 'threadHandle', 'envelope']);
});

test('generated MESSAGING_ERROR_CODE_VALUES matches the MessagingErrorCode union', () => {
  assert.deepEqual([...MESSAGING_ERROR_CODE_VALUES], [
    'VALIDATION',
    'PERMISSION',
    'NOT_FOUND',
    'CONFLICT',
    'RETRYABLE_INFLIGHT',
    'STALE_CURSOR',
  ]);
  const asType: readonly MessagingErrorCode[] = MESSAGING_ERROR_CODE_VALUES;
  assert.equal(asType.length, 6);
});
