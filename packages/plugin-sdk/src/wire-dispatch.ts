/**
 * Wire dispatch classifier — pre-dispatch frame classification per the
 * frozen disposition table (T-A through T-L, §3.8-1 of #1165).
 *
 * This module classifies decoded NDJSON frames into one of the 12
 * disposition classes. T-A (transport failure) and T-B (JSON parse error)
 * are handled by the NDJSON frame decoder layer — this classifier covers
 * T-C through T-L.
 *
 * A frame that passes all rejection checks returns disposition=null with
 * outcome='accept', indicating a valid request that should be dispatched
 * to a method handler.
 *
 * This module defines nothing new — every classification rule traces to
 * the frozen disposition table in @clowder-ai/plugin-contract.
 */

import type { DecodedNdjsonFrame, JsonObject } from '@clowder-ai/plugin-contract/conformance';

import {
  type DispositionClass,
  type WireMethodName,
  validateRequestId,
  validateEffectiveGrants,
  isWireMethod,
  isWireUInt53,
  NOTIFICATION_METHODS,
  WIRE_METHOD_REGISTRY,
  INVALID_REQUEST_CODE,
  INVALID_REQUEST_MESSAGE,
  METHOD_NOT_FOUND_CODE,
  METHOD_NOT_FOUND_MESSAGE,
  INVALID_PARAMS_CODE,
  INVALID_PARAMS_MESSAGE,
  PING_NONCE_MIN_LENGTH,
  PING_NONCE_MAX_LENGTH,
  SUBSCRIBE_HANDLE_MIN_LENGTH,
  SUBSCRIBE_HANDLE_MAX_LENGTH,
  SUBSCRIBE_SUBSCRIPTION_ID_MIN_LENGTH,
  SUBSCRIBE_SUBSCRIPTION_ID_MAX_LENGTH,
  ACK_SUBSCRIPTION_ID_MIN_LENGTH,
  ACK_SUBSCRIPTION_ID_MAX_LENGTH,
  ACK_TOKEN_MIN_LENGTH,
  ACK_TOKEN_MAX_LENGTH,
  ALL_ERROR_CODES,
  APPLICATION_ERROR_CODES,
  ERROR_CODE_TO_MESSAGE,
  // Per-arm application error codes (for data schema dispatch)
  HANDSHAKE_REJECTED_CODE,
  DELIVERY_REJECTED_CODE,
  DOMAIN_ERROR_CODE,
  DEADLINE_EXPIRED_CODE,
  SNAPSHOT_UNAVAILABLE_CODE,
  // Standard error code (ParseError null-id arm validation)
  PARSE_ERROR_CODE,
  // Reject-reason closed enums (application error data validation)
  HANDSHAKE_REJECT_REASONS,
  DELIVERY_REJECT_REASONS,
  SNAPSHOT_UNAVAILABLE_REASONS,
} from '@clowder-ai/plugin-contract';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Cross-frame oracle snapshot — original request fields needed to
 * verify byte-equality invariants on correlated responses.
 *
 * Structurally identical to contract's internal RequestSnapshot;
 * defined locally because that type is not part of the published
 * beta.4 public surface (Fable ruling on F1/immutability).
 */
export interface RequestSnapshot {
  /** Row 11 ping: nonce that must be echoed byte-equal in the result. */
  readonly nonce?: string;
  /** Row 9 deliver: deliveryId that must match byte-equal in the ack. */
  readonly deliveryId?: string;
}

export interface InFlightEntry {
  readonly method: WireMethodName;
  readonly requestSnapshot?: RequestSnapshot;
}

export interface DispatchResult {
  /** T-class from the disposition table, or null for valid requests. */
  readonly disposition: DispositionClass | null;
  /** Required transport action: close, respond (with error), or accept. */
  readonly outcome: 'close' | 'respond' | 'accept';
  /** For 'respond': the error envelope to write back as NDJSON. */
  readonly response?: JsonObject;
}

// ---------------------------------------------------------------------------
// Error response builders
// ---------------------------------------------------------------------------

function respondInvalidRequestNull(): DispatchResult {
  return {
    disposition: 'T-D',
    outcome: 'respond',
    response: {
      jsonrpc: '2.0',
      id: null,
      error: { code: INVALID_REQUEST_CODE, message: INVALID_REQUEST_MESSAGE },
    },
  };
}

function respondInvalidRequestId(id: string): DispatchResult {
  return {
    disposition: 'T-F',
    outcome: 'respond',
    response: {
      jsonrpc: '2.0',
      id,
      error: { code: INVALID_REQUEST_CODE, message: INVALID_REQUEST_MESSAGE },
    },
  };
}

function respondMethodNotFound(id: string): DispatchResult {
  return {
    disposition: 'T-F',
    outcome: 'respond',
    response: {
      jsonrpc: '2.0',
      id,
      error: { code: METHOD_NOT_FOUND_CODE, message: METHOD_NOT_FOUND_MESSAGE },
    },
  };
}

function respondInvalidParams(id: string): DispatchResult {
  return {
    disposition: 'T-F',
    outcome: 'respond',
    response: {
      jsonrpc: '2.0',
      id,
      error: { code: INVALID_PARAMS_CODE, message: INVALID_PARAMS_MESSAGE },
    },
  };
}

function respondInvalidParamsValue(id: string): DispatchResult {
  return {
    disposition: 'T-G',
    outcome: 'respond',
    response: {
      jsonrpc: '2.0',
      id,
      error: { code: INVALID_PARAMS_CODE, message: INVALID_PARAMS_MESSAGE },
    },
  };
}

function close(disposition: DispositionClass): DispatchResult {
  return { disposition, outcome: 'close' };
}

function accept(disposition: DispositionClass): DispatchResult {
  return { disposition, outcome: 'accept' };
}

// ---------------------------------------------------------------------------
// Contract-mirror imports (key sets from contract-mirror.ts)
//
// These mirror contract type-level constraints (additionalProperties: false)
// that lack runtime exports. Each is drift-tested in contract-mirror.test.ts.
// See contract-mirror.ts for deletion schedule and anchoring.
// ---------------------------------------------------------------------------

import {
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
// Derived constants (built from contract runtime imports, NOT mirrors)
// ---------------------------------------------------------------------------

// Error code validation sets (built from contract arrays).
const KNOWN_ERROR_CODES = new Set<number>(ALL_ERROR_CODES);
const APPLICATION_CODES = new Set<number>(APPLICATION_ERROR_CODES);

// Reason enum sets (built from contract arrays).
const HANDSHAKE_REASONS = new Set<string>(HANDSHAKE_REJECT_REASONS);
const DELIVERY_REASONS = new Set<string>(DELIVERY_REJECT_REASONS);
const SNAPSHOT_REASONS = new Set<string>(SNAPSHOT_UNAVAILABLE_REASONS);

// Standard error codes that mandate null id (not string RequestId).
// ParseError (-32700) ALWAYS has id: null per the contract envelope.
// If we reach the error validation path, id is already a valid string
// (verified upstream), so ParseError with string id is invalid.
const NULL_ID_ERROR_CODES = new Set<number>([PARSE_ERROR_CODE]);

// ---------------------------------------------------------------------------
// Response candidate sub-classifier (T-H / T-L)
// ---------------------------------------------------------------------------

function classifyResponseCandidate(
  value: JsonObject,
  inFlight: ReadonlyMap<string, InFlightEntry>,
): DispatchResult {
  const hasResult = 'result' in value;
  const hasError = 'error' in value;

  // ── Closed envelope structure ──────────────────────────────────────
  if (value.jsonrpc !== '2.0') return close('T-H');

  // Mutual exclusivity: exactly one of result/error
  if (hasResult && hasError) return close('T-H');

  // Closed outer keys: no additional members
  const allowedKeys = hasResult ? RESPONSE_SUCCESS_KEYS : RESPONSE_ERROR_KEYS;
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) return close('T-H');
  }

  // ── id validation ──────────────────────────────────────────────────
  if (!('id' in value)) return close('T-H');
  const id = value.id;
  if (typeof id !== 'string') return close('T-H');
  if (validateRequestId(id) === null) return close('T-H');

  // ── In-flight correlation ──────────────────────────────────────────
  const inFlightEntry = inFlight.get(id);
  if (inFlightEntry === undefined) return close('T-H');

  // ── Error body: closed union validation ────────────────────────────
  if (hasError) {
    const error = value.error;
    if (error === null || typeof error !== 'object' || Array.isArray(error)) {
      return close('T-H');
    }
    const errObj = error as Record<string, unknown>;

    // code: number, message: string (structural)
    if (typeof errObj.code !== 'number') return close('T-H');
    if (typeof errObj.message !== 'string') return close('T-H');

    // Error code must be from the closed set
    if (!KNOWN_ERROR_CODES.has(errObj.code)) return close('T-H');

    // Code → message canonical mapping
    const expectedMessage = ERROR_CODE_TO_MESSAGE[errObj.code as keyof typeof ERROR_CODE_TO_MESSAGE];
    if (errObj.message !== expectedMessage) return close('T-H');

    // Standard vs application error body structure
    if (APPLICATION_CODES.has(errObj.code)) {
      // Application errors (-32090..-32094) MUST have `data` (object)
      if (!('data' in errObj)) return close('T-H');
      if (errObj.data === null || typeof errObj.data !== 'object' || Array.isArray(errObj.data)) {
        return close('T-H');
      }
      // Closed keys: {code, message, data} only
      for (const key of Object.keys(errObj)) {
        if (!ERROR_BODY_APPLICATION_KEYS.has(key)) return close('T-H');
      }
      // Per-arm data schema validation
      const dataCheck = validateApplicationErrorData(
        errObj.code,
        errObj.data as Record<string, unknown>,
      );
      if (dataCheck !== null) return dataCheck;
    } else {
      // Standard errors: ParseError (-32700) mandates id: null.
      // We already validated id is a string (not null) upstream.
      // Therefore ParseError with string id is a protocol violation.
      if (NULL_ID_ERROR_CODES.has(errObj.code)) return close('T-H');

      // Standard errors (-32700..-32603) MUST NOT have `data`
      if ('data' in errObj) return close('T-H');
      // Closed keys: {code, message} only
      for (const key of Object.keys(errObj)) {
        if (!ERROR_BODY_STANDARD_KEYS.has(key)) return close('T-H');
      }
    }

    return accept('T-L');
  }

  // ── Success result: method-specific shape validation ───────────────
  const resultCheck = validateResponseResult(value.result, inFlightEntry);
  if (resultCheck !== null) return resultCheck;

  return accept('T-L');
}

// ---------------------------------------------------------------------------
// Application error data schema validation (per-arm)
// ---------------------------------------------------------------------------

/**
 * Validate the `data` field of an application error against the
 * per-arm closed schema (additionalProperties: false).
 *
 * 5 arms: HandshakeRejected, DeliveryRejected, DomainError,
 * DeadlineExpired, SnapshotUnavailable.
 *
 * Contract seam: DomainError.data.code (MessagingErrorCode) has no
 * runtime enum in the contract public surface — only the TypeScript
 * type union exists. We validate structure (key + string type) but
 * skip enum validation to avoid a second truth source (P15).
 * See Sol R3 F1 → Fable escalation.
 */
function validateApplicationErrorData(
  code: number,
  data: Record<string, unknown>,
): DispatchResult | null {
  switch (code) {
    case HANDSHAKE_REJECTED_CODE: {
      // data: { reason: HandshakeRejectReason } — closed
      for (const key of Object.keys(data)) {
        if (!REASON_DATA_KEYS.has(key)) return close('T-H');
      }
      if (typeof data.reason !== 'string') return close('T-H');
      if (!HANDSHAKE_REASONS.has(data.reason)) return close('T-H');
      return null;
    }

    case DELIVERY_REJECTED_CODE: {
      // data: { reason: DeliveryRejectReason } — closed
      for (const key of Object.keys(data)) {
        if (!REASON_DATA_KEYS.has(key)) return close('T-H');
      }
      if (typeof data.reason !== 'string') return close('T-H');
      if (!DELIVERY_REASONS.has(data.reason)) return close('T-H');
      return null;
    }

    case DOMAIN_ERROR_CODE: {
      // data: { code: MessagingErrorCode } — closed keys + enum
      // MESSAGING_ERROR_CODE_SET from contract-mirror.ts (drift-tested
      // against messaging.schema.json enum, Fable ruling on R3 seam).
      for (const key of Object.keys(data)) {
        if (!CODE_DATA_KEYS.has(key)) return close('T-H');
      }
      if (typeof data.code !== 'string') return close('T-H');
      if (!MESSAGING_ERROR_CODE_SET.has(data.code)) return close('T-H');
      return null;
    }

    case DEADLINE_EXPIRED_CODE: {
      // data: Record<string, never> — must be empty object
      if (Object.keys(data).length !== 0) return close('T-H');
      return null;
    }

    case SNAPSHOT_UNAVAILABLE_CODE: {
      // data: { reason: SnapshotUnavailableReason } — closed
      for (const key of Object.keys(data)) {
        if (!REASON_DATA_KEYS.has(key)) return close('T-H');
      }
      if (typeof data.reason !== 'string') return close('T-H');
      if (!SNAPSHOT_REASONS.has(data.reason)) return close('T-H');
      return null;
    }

    default:
      // Unknown application code — should be unreachable since
      // APPLICATION_CODES was already checked. Defense-in-depth.
      return close('T-H');
  }
}

// ---------------------------------------------------------------------------
// Response result shape validation (per-method, CLOSED rows only)
// ---------------------------------------------------------------------------

/**
 * Validate the `result` value of a success response against the
 * correlated in-flight method's expected result shape.
 *
 * CLOSED rows: full per-method result shape validation (additionalProperties: false).
 * RESERVED rows: no shape contract to validate — only cross-frame oracle applies.
 *
 * Returns null if valid; DispatchResult (T-H) if invalid.
 */
function validateResponseResult(
  result: unknown,
  entry: InFlightEntry,
): DispatchResult | null {
  const method = entry.method;
  const row = WIRE_METHOD_REGISTRY[method];

  // RESERVED rows: no shape contract to validate against.
  // Only cross-frame oracle checks apply (nonce/deliveryId byte-equality).
  if (row.leafClosure !== 'CLOSED') {
    return validateReservedRowOracle(result, entry);
  }

  switch (method) {
    case 'host.lifecycle.ping': {
      // PingResult: {nonce: string} — additionalProperties: false
      if (result === null || typeof result !== 'object' || Array.isArray(result)) {
        return close('T-H');
      }
      const obj = result as Record<string, unknown>;
      // Closed keys: {nonce} only
      for (const key of Object.keys(obj)) {
        if (!PING_RESULT_KEYS.has(key)) return close('T-H');
      }
      if (typeof obj.nonce !== 'string') return close('T-H');
      // Nonce bounds
      const cpLen = [...(obj.nonce as string)].length;
      if (cpLen < PING_NONCE_MIN_LENGTH || cpLen > PING_NONCE_MAX_LENGTH) {
        return close('T-H');
      }
      // Cross-frame oracle: nonce byte-equality (REQUIRED for ping).
      // Ping's nonce echo is the fundamental liveness proof — accepting
      // a response without verifying the oracle defeats the purpose.
      // Missing snapshot is a caller bug; fail-closed, not fail-open.
      if (entry.requestSnapshot?.nonce === undefined) return close('T-H');
      if (obj.nonce !== entry.requestSnapshot.nonce) return close('T-H');
      return null;
    }

    case 'host.lifecycle.drain': {
      // DrainResult: null
      if (result !== null) return close('T-H');
      return null;
    }

    case 'messaging.subscribe': {
      // SubscribeResult: {subscriptionId: string} — additionalProperties: false
      if (result === null || typeof result !== 'object' || Array.isArray(result)) {
        return close('T-H');
      }
      const obj = result as Record<string, unknown>;
      // Closed keys: {subscriptionId} only
      for (const key of Object.keys(obj)) {
        if (!SUBSCRIBE_RESULT_KEYS.has(key)) return close('T-H');
      }
      if (typeof obj.subscriptionId !== 'string') return close('T-H');
      const cpLen = [...(obj.subscriptionId as string)].length;
      if (cpLen < SUBSCRIBE_SUBSCRIPTION_ID_MIN_LENGTH || cpLen > SUBSCRIBE_SUBSCRIPTION_ID_MAX_LENGTH) {
        return close('T-H');
      }
      return null;
    }

    case 'messaging.ack': {
      // MessagingAckResult: null
      if (result !== null) return close('T-H');
      return null;
    }

    case 'host.grants.changed': {
      // Notification-only — should never be in in-flight.
      // Direction gate prevents this; defense-in-depth.
      return close('T-H');
    }

    default: {
      // Unreachable for CLOSED rows (all covered above).
      // Defense-in-depth: unknown method in in-flight → T-H.
      return close('T-H');
    }
  }
}

// ---------------------------------------------------------------------------
// Cross-frame oracle for RESERVED row responses
// ---------------------------------------------------------------------------

/**
 * For RESERVED rows (no closed result shape), the only validation
 * available is the cross-frame oracle — byte-equality checks on
 * nonce/deliveryId from the original request snapshot.
 */
function validateReservedRowOracle(
  result: unknown,
  entry: InFlightEntry,
): DispatchResult | null {
  // Method-specific oracle requirements: row 9 (host.messaging.deliver)
  // requires deliveryId snapshot — fail-closed if absent.
  // Mirrors the ping oracle fail-closed pattern (R3 fix).
  if (entry.method === 'host.messaging.deliver') {
    if (entry.requestSnapshot?.deliveryId === undefined) return close('T-H');
    if (result === null || typeof result !== 'object' || Array.isArray(result)) {
      return close('T-H');
    }
    const resultObj = result as Record<string, unknown>;
    if (resultObj.deliveryId !== entry.requestSnapshot.deliveryId) return close('T-H');
    return null;
  }

  // Other RESERVED rows: oracle check only when snapshot has fields.
  if (entry.requestSnapshot === undefined) return null;

  const hasOracleField =
    entry.requestSnapshot.nonce !== undefined ||
    entry.requestSnapshot.deliveryId !== undefined;
  if (!hasOracleField) return null;

  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    return close('T-H');
  }
  const resultObj = result as Record<string, unknown>;

  // Nonce byte-equality
  if (entry.requestSnapshot.nonce !== undefined) {
    if (resultObj.nonce !== entry.requestSnapshot.nonce) return close('T-H');
  }

  // DeliveryId byte-equality
  if (entry.requestSnapshot.deliveryId !== undefined) {
    if (resultObj.deliveryId !== entry.requestSnapshot.deliveryId) return close('T-H');
  }

  return null;
}

// ---------------------------------------------------------------------------
// Notification sub-classifier (T-J / T-K)
// ---------------------------------------------------------------------------

function classifyNotification(value: JsonObject): DispatchResult {
  const method = value.method as string;

  // Closed outer keys: {jsonrpc, method, params} only
  for (const key of Object.keys(value)) {
    if (!NOTIFICATION_ALLOWED_KEYS.has(key)) return close('T-K');
  }

  // Missing params → T-K
  if (!('params' in value)) return close('T-K');

  // Only row 10 (host.grants.changed) is a legal notification in v0
  const isLegalNotification = (NOTIFICATION_METHODS as readonly string[]).includes(method);
  if (!isLegalNotification) return close('T-K');

  // Validate params structure
  const params = value.params;
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    return close('T-K');
  }
  const paramsObj = params as Record<string, unknown>;

  // Closed params keys: {meta, input} only
  for (const key of Object.keys(paramsObj)) {
    if (!PARAMS_ALLOWED_KEYS.has(key)) return close('T-K');
  }

  // meta.deadlineUnixMs
  if (!('meta' in paramsObj)) return close('T-K');
  const meta = paramsObj.meta;
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
    return close('T-K');
  }
  const metaObj = meta as Record<string, unknown>;

  // Closed meta keys: {deadlineUnixMs} only
  for (const key of Object.keys(metaObj)) {
    if (!META_ALLOWED_KEYS.has(key)) return close('T-K');
  }

  const notifDeadline = metaObj.deadlineUnixMs;
  if (typeof notifDeadline !== 'number' || !isWireUInt53(notifDeadline)) return close('T-K');
  if (notifDeadline === 0) return close('T-K');

  // input validation for row 10 (grants.changed)
  if (!('input' in paramsObj)) return close('T-K');
  const input = paramsObj.input;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return close('T-K');
  }
  const inputObj = input as Record<string, unknown>;

  // Closed input keys: {grantRevision, effectiveGrants} only
  for (const key of Object.keys(inputObj)) {
    if (!GRANTS_CHANGED_INPUT_KEYS.has(key)) return close('T-K');
  }

  // grantRevision must be WireUInt53 (≥0)
  const grantRev = inputObj.grantRevision;
  if (typeof grantRev !== 'number' || !isWireUInt53(grantRev)) return close('T-K');

  // effectiveGrants must pass authorization boundary validation
  if (!Array.isArray(inputObj.effectiveGrants)) return close('T-K');
  if (!validateEffectiveGrants(inputObj.effectiveGrants as string[])) return close('T-K');

  return accept('T-J');
}

// ---------------------------------------------------------------------------
// Request sub-classifier (T-E / T-F / T-G / T-I / accept)
// ---------------------------------------------------------------------------

function classifyRequest(
  value: JsonObject,
  id: string,
  method: string,
  inFlight: ReadonlyMap<string, InFlightEntry>,
): DispatchResult {
  // Closed outer keys: {jsonrpc, id, method, params} only
  for (const key of Object.keys(value)) {
    if (!REQUEST_ALLOWED_KEYS.has(key)) return respondInvalidRequestId(id);
  }

  // Missing params → T-F InvalidRequest
  if (!('params' in value)) return respondInvalidRequestId(id);

  // params must be an object
  const params = value.params;
  if (params === null || typeof params !== 'object') {
    return respondInvalidParams(id);
  }
  if (Array.isArray(params)) return respondInvalidParams(id);

  // Method gate: unknown method → T-F MethodNotFound
  if (!isWireMethod(method)) return respondMethodNotFound(id);

  // Direction gate: notification-only methods must not appear as requests
  const wireMethod = method as WireMethodName;
  const row = WIRE_METHOD_REGISTRY[wireMethod];
  if (row.isNotification) return respondInvalidRequestId(id);

  // In-flight collision → T-I
  if (inFlight.has(id)) return close('T-I');

  const paramsObj = params as Record<string, unknown>;

  // Closed params keys: {meta, input} only
  for (const key of Object.keys(paramsObj)) {
    if (!PARAMS_ALLOWED_KEYS.has(key)) return respondInvalidParams(id);
  }

  // Validate params.meta structure
  if (!('meta' in paramsObj)) return respondInvalidParams(id);
  const meta = paramsObj.meta;
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
    return respondInvalidParams(id);
  }
  const metaObj = meta as Record<string, unknown>;

  // Closed meta keys: {deadlineUnixMs} only
  for (const key of Object.keys(metaObj)) {
    if (!META_ALLOWED_KEYS.has(key)) return respondInvalidParamsValue(id);
  }

  // deadlineUnixMs must be positive WireUInt53
  const reqDeadline = metaObj.deadlineUnixMs;
  if (typeof reqDeadline !== 'number' || !isWireUInt53(reqDeadline)) return respondInvalidParamsValue(id);
  if (reqDeadline === 0) return respondInvalidParamsValue(id);

  // Validate params.input exists and is an object
  if (!('input' in paramsObj)) return respondInvalidParams(id);
  const input = paramsObj.input;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return respondInvalidParams(id);
  }

  // Row-specific value validation
  if (row.leafClosure === 'CLOSED') {
    const valueResult = validateClosedRowInput(wireMethod, input as Record<string, unknown>, id);
    if (valueResult !== null) return valueResult;
  } else {
    // RESERVED rows: input type is `never` → no legal params value exists
    // in v0 → any invocation is a value violation (T-G).
    // Fable ruling: disposition table has no accept class for Requests;
    // ACCEPT_CLASSES = {T-J (notification), T-L (response)} only.
    return respondInvalidParamsValue(id);
  }

  // All checks passed — valid CLOSED-row request for dispatch
  return { disposition: null, outcome: 'accept' };
}

// ---------------------------------------------------------------------------
// CLOSED row input validation (T-G detection)
// ---------------------------------------------------------------------------

function validateClosedRowInput(
  method: WireMethodName,
  input: Record<string, unknown>,
  id: string,
): DispatchResult | null {
  switch (method) {
    case 'host.lifecycle.ping': {
      // Closed input keys: {nonce} only
      for (const key of Object.keys(input)) {
        if (!PING_INPUT_KEYS.has(key)) return respondInvalidParamsValue(id);
      }
      // nonce must be string, 1..512 code points
      if (typeof input.nonce !== 'string') return respondInvalidParamsValue(id);
      const cpLen = [...input.nonce].length;
      if (cpLen < PING_NONCE_MIN_LENGTH || cpLen > PING_NONCE_MAX_LENGTH) {
        return respondInvalidParamsValue(id);
      }
      return null;
    }
    case 'host.lifecycle.drain': {
      // Closed input keys: {deadlineUnixMs} only
      for (const key of Object.keys(input)) {
        if (!DRAIN_INPUT_KEYS.has(key)) return respondInvalidParamsValue(id);
      }
      // input.deadlineUnixMs must be positive WireUInt53
      const drainDeadline = input.deadlineUnixMs;
      if (typeof drainDeadline !== 'number' || !isWireUInt53(drainDeadline)) return respondInvalidParamsValue(id);
      if (drainDeadline === 0) return respondInvalidParamsValue(id);
      return null;
    }
    case 'messaging.subscribe': {
      // Closed input keys: {handle} only
      for (const key of Object.keys(input)) {
        if (!SUBSCRIBE_INPUT_KEYS.has(key)) return respondInvalidParamsValue(id);
      }
      // handle must be string, bounds from contract
      if (typeof input.handle !== 'string') return respondInvalidParamsValue(id);
      const cpLen = [...input.handle].length;
      if (cpLen < SUBSCRIBE_HANDLE_MIN_LENGTH || cpLen > SUBSCRIBE_HANDLE_MAX_LENGTH) {
        return respondInvalidParamsValue(id);
      }
      return null;
    }
    case 'messaging.ack': {
      // Closed input keys: {subscriptionId, ackToken} only
      for (const key of Object.keys(input)) {
        if (!ACK_INPUT_KEYS.has(key)) return respondInvalidParamsValue(id);
      }
      // subscriptionId + ackToken: string, bounds from contract
      if (typeof input.subscriptionId !== 'string') return respondInvalidParamsValue(id);
      if (typeof input.ackToken !== 'string') return respondInvalidParamsValue(id);
      const subLen = [...input.subscriptionId].length;
      const tokenLen = [...input.ackToken].length;
      if (subLen < ACK_SUBSCRIPTION_ID_MIN_LENGTH || subLen > ACK_SUBSCRIPTION_ID_MAX_LENGTH) {
        return respondInvalidParamsValue(id);
      }
      if (tokenLen < ACK_TOKEN_MIN_LENGTH || tokenLen > ACK_TOKEN_MAX_LENGTH) {
        return respondInvalidParamsValue(id);
      }
      return null;
    }
    // host.grants.changed (row 10) is notification-only — direction gate
    // in classifyRequest rejects it before reaching this function.
    default:
      // RESERVED rows: skip input validation (shapes are `never`)
      return null;
  }
}

// ---------------------------------------------------------------------------
// Main classifier entry point
// ---------------------------------------------------------------------------

/**
 * Classify a decoded NDJSON frame into a disposition class.
 *
 * Covers T-C through T-L of the frozen disposition table. T-A and T-B
 * are handled by the NDJSON frame decoder layer.
 *
 * @param frame   Decoded frame with raw bytes and parsed value.
 * @param inFlight Map of in-flight request IDs to their entry metadata.
 * @returns The disposition result with class, outcome, and optional error response.
 */
export function classifyFrame(
  frame: DecodedNdjsonFrame,
  inFlight: ReadonlyMap<string, InFlightEntry>,
): DispatchResult {
  const { raw, value } = frame;

  // ── T-C: canonicality check ──────────────────────────────────────────
  const rawStr = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  const canonical = JSON.stringify(value);
  if (rawStr !== canonical) return close('T-C');

  // ── Response candidate detection ─────────────────────────────────────
  const hasMethod = 'method' in value;
  const hasResult = 'result' in value;
  const hasError = 'error' in value;

  if (!hasMethod && (hasResult || hasError)) {
    return classifyResponseCandidate(value, inFlight);
  }

  // ── Structural validity ──────────────────────────────────────────────
  if (value.jsonrpc !== '2.0' || typeof value.method !== 'string') {
    if ('id' in value) {
      const id = validateRequestId(value.id);
      if (id !== null) {
        return respondInvalidRequestId(id);
      }
    }
    return respondInvalidRequestNull();
  }

  const method = value.method as string;

  // ── Notification vs Request fork ─────────────────────────────────────
  if (!('id' in value)) {
    return classifyNotification(value);
  }

  // ── T-E: profile-invalid id ──────────────────────────────────────────
  const id = validateRequestId(value.id);
  if (id === null) return close('T-E');

  // ── Request path ─────────────────────────────────────────────────────
  return classifyRequest(value, id, method, inFlight);
}
