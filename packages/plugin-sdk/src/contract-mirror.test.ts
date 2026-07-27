/**
 * Drift-prevention tests for contract-mirror.ts.
 *
 * Every constant in contract-mirror.ts mirrors a contract type-level
 * constraint that lacks a runtime export. These tests anchor each
 * mirror to its contract source and fail if they drift apart.
 *
 * TWO-LAYER DRIFT DETECTION:
 *
 * 1. **Compile-time**: ExactKeys<ContractType, LiteralUnion> type assertions
 *    fail at `tsc -p tsconfig.test.json` time when the contract interface
 *    adds or removes a field. No runtime cost.
 *
 * 2. **Runtime**: each test verifies the mirror Set has the expected
 *    cardinality and members. Catches mirror literal drift.
 *
 * Together they triangulate: any single-party change (contract OR mirror)
 * is caught. Only coordinated updates to both pass green — which is the
 * intended outcome (mirror updated to match the contract).
 *
 * Automated drift tests use test-only relative imports to read contract
 * source data (schema JSON, TypeScript types). These imports are excluded
 * from the SDK dist artifact (test files not in tsconfig.build).
 *
 * Fable ruling (S1 R3 contract seam): systematic drift prevention for
 * all contract mirrors. Pattern precedent: #10 MAX_FRAME_BYTES.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MESSAGING_ERROR_CODES,
  MESSAGING_ERROR_CODE_SET,
  RESPONSE_SUCCESS_KEYS,
  RESPONSE_ERROR_KEYS,
  NOTIFICATION_ALLOWED_KEYS,
  REQUEST_ALLOWED_KEYS,
  PARAMS_ALLOWED_KEYS,
  META_ALLOWED_KEYS,
  PING_INPUT_KEYS,
  DRAIN_INPUT_KEYS,
  SUBSCRIBE_INPUT_KEYS,
  ACK_INPUT_KEYS,
  GRANTS_CHANGED_INPUT_KEYS,
  PING_RESULT_KEYS,
  SUBSCRIBE_RESULT_KEYS,
  ERROR_BODY_STANDARD_KEYS,
  ERROR_BODY_APPLICATION_KEYS,
  REASON_DATA_KEYS,
  CODE_DATA_KEYS,
} from './contract-mirror.js';

// ---------------------------------------------------------------------------
// Contract type imports — compile-time drift anchors
// ---------------------------------------------------------------------------

// Public barrel: types available in published @clowder-ai/plugin-contract.
// Every contract type that a shared mirror constant serves is imported
// here — not just one representative per group (Sol R5 matrix closure).
import type {
  CallMeta,
  WireSuccessResponse,
  // Concrete error envelopes — all 11 variants for RESPONSE_ERROR_KEYS
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
  // Per-method CLOSED-row input/result shapes
  PingInput,
  PingResult,
  DrainInput,
  SubscribeInput,
  SubscribeResult,
  MessagingAckRequest,
  GrantsChangedInput,
  // Standard error body types — all 5 for ERROR_BODY_STANDARD_KEYS
  ParseError,
  InvalidRequestError,
  MethodNotFoundError,
  InvalidParamsError,
  InternalError,
  // Application error body types — all 5 for ERROR_BODY_APPLICATION_KEYS
  HandshakeRejectedError,
  DeliveryRejectedError,
  DomainError,
  DeadlineExpiredError,
  SnapshotUnavailableError,
} from '@clowder-ai/plugin-contract';

// Test-only relative import: generic envelopes NOT in public barrel (Q1 ruling).
// These types are the sole source for REQUEST_ALLOWED_KEYS, NOTIFICATION_ALLOWED_KEYS,
// and PARAMS_ALLOWED_KEYS. Safe: test files excluded from SDK dist artifact.
import type {
  WireRequest,
  WireNotification,
} from '../../plugin-contract/src/wire/envelope.js';

// ---------------------------------------------------------------------------
// Compile-time drift detection: ExactKeys type utility
// ---------------------------------------------------------------------------

/**
 * Evaluates to `true` iff `keyof T` is exactly the string literal union K.
 * Bidirectional: catches both additions and removals.
 *
 * If the contract interface changes, the const assignment `const _: ExactKeys<...> = true`
 * fails at tsc time with "Type 'false' is not assignable to type 'true'".
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
const _d20: ExactKeys<SubscribeInput, 'handle'> = true;
const _d21: ExactKeys<MessagingAckRequest, 'subscriptionId' | 'ackToken'> = true;
const _d22: ExactKeys<GrantsChangedInput, 'grantRevision' | 'effectiveGrants'> = true;

// ── Per-method CLOSED-row result shapes (1:1, no shared mirrors) ──
const _d23: ExactKeys<PingResult, 'nonce'> = true;
const _d24: ExactKeys<SubscribeResult, 'subscriptionId'> = true;

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
void _d19; void _d20; void _d21; void _d22; void _d23; void _d24;
void _d25; void _d26; void _d27; void _d28; void _d29; void _d30;
void _d31; void _d32; void _d33; void _d34; void _d35; void _d36;
void _d37; void _d38;

// ---------------------------------------------------------------------------
// Schema JSON source path (test-only)
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const MESSAGING_SCHEMA_PATH = resolve(
  __dirname,
  '../../plugin-contract/src/schemas/messaging.schema.json',
);

// ---------------------------------------------------------------------------
// Automated drift test: MessagingErrorCode enum
// ---------------------------------------------------------------------------

test('MESSAGING_ERROR_CODES matches messaging.schema.json enum exactly', () => {
  const schemaRaw = readFileSync(MESSAGING_SCHEMA_PATH, 'utf8');
  const schema = JSON.parse(schemaRaw) as {
    $defs: {
      MessagingErrorCode: { type: string; enum: string[] };
    };
  };

  const schemaEnum = schema.$defs.MessagingErrorCode.enum;

  assert.ok(
    Array.isArray(schemaEnum),
    'schema must define MessagingErrorCode.enum as array',
  );

  // Exact member match (same values, same order)
  assert.deepEqual(
    [...MESSAGING_ERROR_CODES],
    schemaEnum,
    'MESSAGING_ERROR_CODES must match schema enum exactly (values + order). ' +
      'If this fails, update contract-mirror.ts to match the schema.',
  );
});

test('MESSAGING_ERROR_CODE_SET has same cardinality as array', () => {
  assert.equal(
    MESSAGING_ERROR_CODE_SET.size,
    MESSAGING_ERROR_CODES.length,
    'Set and array must have same size (no duplicates in array)',
  );
});

// ---------------------------------------------------------------------------
// Runtime drift tests: envelope key sets
//
// These verify the mirror Set has the expected cardinality and members.
// Compile-time ExactKeys assertions (above) anchor each key set to the
// contract interface — if the contract adds/removes a field, tsc fails
// before these runtime tests even run. These runtime tests catch mirror
// literal drift (someone changes the Set without updating ExactKeys).
// ---------------------------------------------------------------------------

test('RESPONSE_SUCCESS_KEYS matches WireSuccessResponse interface', () => {
  // WireSuccessResponse: { jsonrpc, id, result }
  assert.equal(RESPONSE_SUCCESS_KEYS.size, 3);
  assert.ok(RESPONSE_SUCCESS_KEYS.has('jsonrpc'));
  assert.ok(RESPONSE_SUCCESS_KEYS.has('id'));
  assert.ok(RESPONSE_SUCCESS_KEYS.has('result'));
});

test('RESPONSE_ERROR_KEYS matches WireErrorResponse interface', () => {
  // WireApplicationErrorResponse / WireStandardErrorResponse: { jsonrpc, id, error }
  assert.equal(RESPONSE_ERROR_KEYS.size, 3);
  assert.ok(RESPONSE_ERROR_KEYS.has('jsonrpc'));
  assert.ok(RESPONSE_ERROR_KEYS.has('id'));
  assert.ok(RESPONSE_ERROR_KEYS.has('error'));
});

test('NOTIFICATION_ALLOWED_KEYS matches WireNotification interface', () => {
  // WireNotification: { jsonrpc, method, params }
  assert.equal(NOTIFICATION_ALLOWED_KEYS.size, 3);
  assert.ok(NOTIFICATION_ALLOWED_KEYS.has('jsonrpc'));
  assert.ok(NOTIFICATION_ALLOWED_KEYS.has('method'));
  assert.ok(NOTIFICATION_ALLOWED_KEYS.has('params'));
});

test('REQUEST_ALLOWED_KEYS matches WireRequest interface', () => {
  // WireRequest: { jsonrpc, id, method, params }
  assert.equal(REQUEST_ALLOWED_KEYS.size, 4);
  assert.ok(REQUEST_ALLOWED_KEYS.has('jsonrpc'));
  assert.ok(REQUEST_ALLOWED_KEYS.has('id'));
  assert.ok(REQUEST_ALLOWED_KEYS.has('method'));
  assert.ok(REQUEST_ALLOWED_KEYS.has('params'));
});

test('PARAMS_ALLOWED_KEYS matches WireRequest.params / WireNotification.params', () => {
  // params: { meta, input }
  assert.equal(PARAMS_ALLOWED_KEYS.size, 2);
  assert.ok(PARAMS_ALLOWED_KEYS.has('meta'));
  assert.ok(PARAMS_ALLOWED_KEYS.has('input'));
});

test('META_ALLOWED_KEYS matches CallMeta interface', () => {
  // CallMeta: { deadlineUnixMs }
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

test('SUBSCRIBE_INPUT_KEYS matches SubscribeInput interface', () => {
  assert.equal(SUBSCRIBE_INPUT_KEYS.size, 1);
  assert.ok(SUBSCRIBE_INPUT_KEYS.has('handle'));
});

test('ACK_INPUT_KEYS matches MessagingAckRequest interface', () => {
  assert.equal(ACK_INPUT_KEYS.size, 2);
  assert.ok(ACK_INPUT_KEYS.has('subscriptionId'));
  assert.ok(ACK_INPUT_KEYS.has('ackToken'));
});

test('GRANTS_CHANGED_INPUT_KEYS matches GrantSnapshot interface', () => {
  assert.equal(GRANTS_CHANGED_INPUT_KEYS.size, 2);
  assert.ok(GRANTS_CHANGED_INPUT_KEYS.has('grantRevision'));
  assert.ok(GRANTS_CHANGED_INPUT_KEYS.has('effectiveGrants'));
});

// ---------------------------------------------------------------------------
// Structural drift tests: per-method result key sets
// ---------------------------------------------------------------------------

test('PING_RESULT_KEYS matches PingResult interface', () => {
  assert.equal(PING_RESULT_KEYS.size, 1);
  assert.ok(PING_RESULT_KEYS.has('nonce'));
});

test('SUBSCRIBE_RESULT_KEYS matches SubscribeResult interface', () => {
  assert.equal(SUBSCRIBE_RESULT_KEYS.size, 1);
  assert.ok(SUBSCRIBE_RESULT_KEYS.has('subscriptionId'));
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
