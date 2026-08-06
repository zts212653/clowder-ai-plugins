/**
 * Wire dispatch classifier — pre-dispatch frame classification per the
 * disposition table (T-A through T-M, §3.8-1 plus beta.8 closure).
 *
 * This module classifies decoded NDJSON frames into one of the 13
 * disposition classes. T-A (transport failure) and T-B (JSON parse error)
 * are handled by the NDJSON frame decoder layer — this classifier covers
 * T-C through T-M.
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
  type RequestSnapshot,
  type WireMethodName,
  validateRequestId,
  hasHandshakeAuthorityInjection,
  validateCandidateHello,
  validateBrokerReadyParams,
  validateSessionBinding,
  validateEffectiveGrants,
  isWireMethod,
  isWireUInt53,
  isCanonicalUInt53Token,
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
  HANDSHAKE_REJECTED_MESSAGE,
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

// Re-export the contract-owned snapshot so an in-flight response classifier
// cannot drift from the published conformance vectors.
export type { RequestSnapshot } from '@clowder-ai/plugin-contract';

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

function respondHandshakeAuthorityViolation(id: string): DispatchResult {
  return {
    disposition: 'T-G',
    outcome: 'respond',
    response: {
      jsonrpc: '2.0',
      id,
      error: {
        code: HANDSHAKE_REJECTED_CODE,
        message: HANDSHAKE_REJECTED_MESSAGE,
        data: { reason: 'AUTHORITY_VIOLATION' },
      },
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
// Non-scalar string detection (T-C canonicality, lone surrogate check)
// ---------------------------------------------------------------------------

/**
 * Returns true if any string value or object key in the parsed JSON tree
 * contains a lone surrogate (U+D800–U+DFFF). These are non-scalar strings
 * per the Unicode specification and fail the T-C canonicality predicate.
 *
 * Lone surrogates roundtrip through JSON.stringify (ES2019+ escapes them
 * as \uXXXX), so byte-equality alone cannot catch them.
 */
function containsNonScalarString(value: unknown): boolean {
  if (typeof value === 'string') {
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      if (c >= 0xD800 && c <= 0xDBFF) {
        // High surrogate — must be followed by a low surrogate (U+DC00–U+DFFF)
        const next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
        if (next < 0xDC00 || next > 0xDFFF) return true;
        i++; // Skip the valid low surrogate pair partner
      } else if (c >= 0xDC00 && c <= 0xDFFF) {
        // Lone low surrogate (not preceded by a high surrogate)
        return true;
      }
    }
    return false;
  }
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (containsNonScalarString(item)) return true;
    }
    return false;
  }
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (containsNonScalarString(key)) return true;
    if (containsNonScalarString((value as Record<string, unknown>)[key])) return true;
  }
  return false;
}

/**
 * Detect numbers whose JSON.stringify form uses exponent notation.
 *
 * V8 serialises numbers ≥ 10^21 (and very small fractions) in exponent
 * form (e.g. `1e+21`). When the raw frame also uses the same exponent
 * form, byte-equality passes — but exponent-form numeric tokens are
 * non-canonical per the WireUInt53 profile (which requires raw decimal
 * digits `0|[1-9][0-9]*`, no exponent). Deep traversal mirrors
 * containsNonScalarString.
 */
function containsExponentNumber(value: unknown): boolean {
  if (typeof value === 'number') {
    const s = String(value);
    return s.includes('e') || s.includes('E');
  }
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (containsExponentNumber(item)) return true;
    }
    return false;
  }
  for (const v of Object.values(value as Record<string, unknown>)) {
    if (containsExponentNumber(v)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// WireUInt53 raw-token validation (P1-1 maintainer requirement)
// ---------------------------------------------------------------------------

/**
 * Check whether any WireUInt53 position in the parsed frame value has a
 * numeric token whose V8-canonical form violates the WireUInt53 raw grammar
 * (0|[1-9][0-9]{0,15}, no sign, no decimal, no exponent).
 *
 * After byte-equality passes (rawStr === JSON.stringify(value)), the raw
 * token at any numeric position IS String(parsedValue). So we walk the
 * parsed structure to WireUInt53 positions and validate String(n) against
 * isCanonicalUInt53Token. This catches negative integers (-1), fractions
 * (1.5), and oversized values (>2^53-1) at the T-C layer, before any
 * method-specific validation runs.
 *
 * WireUInt53 positions in the frozen schema:
 *   - params.meta.deadlineUnixMs  (every request/notification)
 *   - params.input.deadlineUnixMs (host.lifecycle.drain input)
 *   - params.input.grantRevision  (host.grants.changed input)
 *   - result.grantRevision        (broker.hello SessionBinding)
 */
function hasNonCanonicalUInt53Token(value: JsonObject): boolean {
  const params = value.params;
  if (params !== null && typeof params === 'object' && !Array.isArray(params)) {
    const paramsObj = params as Record<string, unknown>;

    // ── params.meta.deadlineUnixMs ──
    const meta = paramsObj.meta;
    if (meta !== null && typeof meta === 'object' && !Array.isArray(meta)) {
      const metaObj = meta as Record<string, unknown>;
      if (typeof metaObj.deadlineUnixMs === 'number') {
        if (!isCanonicalUInt53Token(String(metaObj.deadlineUnixMs))) return true;
      }
    }

    // ── params.input.deadlineUnixMs (drain) + params.input.grantRevision (grants.changed) ──
    const input = paramsObj.input;
    if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
      const inputObj = input as Record<string, unknown>;
      if (typeof inputObj.deadlineUnixMs === 'number') {
        if (!isCanonicalUInt53Token(String(inputObj.deadlineUnixMs))) return true;
      }
      if (typeof inputObj.grantRevision === 'number') {
        if (!isCanonicalUInt53Token(String(inputObj.grantRevision))) return true;
      }
    }
  }

  // Response envelopes have no method. H7 is the only WireUInt53 leaf in a
  // result shape today, so it must receive the same raw-token gate before
  // response correlation and SessionBinding schema validation.
  const result = value.result;
  if (!('method' in value) && result !== null && typeof result === 'object' && !Array.isArray(result)) {
    const resultObj = result as Record<string, unknown>;
    if (typeof resultObj.grantRevision === 'number') {
      if (!isCanonicalUInt53Token(String(resultObj.grantRevision))) return true;
    }
  }

  return false;
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
  DELIVER_RESULT_KEYS,
  DELIVER_DELIVERY_ID_MIN_LENGTH,
  DELIVER_DELIVERY_ID_MAX_LENGTH,
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
// Per-method application error allowlists (frozen per-row registry)
// ---------------------------------------------------------------------------
//
// Every registry row's application-error set resolves through the closed
// application table in #1165. Eligibility is keyed off the row, NOT
// leafClosure — RESERVED rows have frozen error sets too.
//
//   Rows 1-2 (broker.hello/ready):           HANDSHAKE_REJECTED
//   Rows 3-7 (messaging send/append/sub/read/ack): DOMAIN_ERROR, DEADLINE_EXPIRED
//   Row 8  (messaging.snapshot):              DOMAIN_ERROR, DEADLINE_EXPIRED, SNAPSHOT_UNAVAILABLE
//   Row 9  (host.messaging.deliver):          DELIVERY_REJECTED
//   Row 10 (host.grants.changed):             notification-only (no response)
//   Row 11 (host.lifecycle.ping):             standard only (no application errors)
//   Row 12 (host.lifecycle.drain):            DEADLINE_EXPIRED
//
// Standard errors are always allowed on every row. Application error
// codes NOT in the per-row allowlist → T-H.

const EMPTY_ERROR_SET: ReadonlySet<number> = new Set();
const HANDSHAKE_ERROR_SET: ReadonlySet<number> = new Set([HANDSHAKE_REJECTED_CODE]);
const MESSAGING_ERROR_SET: ReadonlySet<number> = new Set([DOMAIN_ERROR_CODE, DEADLINE_EXPIRED_CODE]);
const SNAPSHOT_ERROR_SET: ReadonlySet<number> = new Set([DOMAIN_ERROR_CODE, DEADLINE_EXPIRED_CODE, SNAPSHOT_UNAVAILABLE_CODE]);
const DELIVERY_ERROR_SET: ReadonlySet<number> = new Set([DELIVERY_REJECTED_CODE]);
const DEADLINE_ONLY_SET: ReadonlySet<number> = new Set([DEADLINE_EXPIRED_CODE]);

const METHOD_APPLICATION_ERROR_ALLOW: Readonly<Record<WireMethodName, ReadonlySet<number>>> = {
  'broker.hello': HANDSHAKE_ERROR_SET,
  'broker.ready': HANDSHAKE_ERROR_SET,
  'messaging.send': MESSAGING_ERROR_SET,
  'messaging.appendElements': MESSAGING_ERROR_SET,
  'messaging.subscribe': MESSAGING_ERROR_SET,
  'messaging.read': MESSAGING_ERROR_SET,
  'messaging.ack': MESSAGING_ERROR_SET,
  'messaging.snapshot': SNAPSHOT_ERROR_SET,
  'host.messaging.deliver': DELIVERY_ERROR_SET,
  'host.grants.changed': EMPTY_ERROR_SET, // notification-only
  'host.lifecycle.ping': EMPTY_ERROR_SET,  // standard only
  'host.lifecycle.drain': DEADLINE_ONLY_SET,
};

// DELIVER_RESULT_KEYS imported from contract-mirror.ts (row 9 ack shape).

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

    // ── Per-method error code restriction ────────────────────────────
    // Application errors are only valid on methods whose frozen per-row
    // error set includes them. Standard errors are always allowed.
    // The complete map covers all 12 rows — no fallback needed.
    if (APPLICATION_CODES.has(errObj.code)) {
      if (!METHOD_APPLICATION_ERROR_ALLOW[inFlightEntry.method].has(errObj.code)) {
        return close('T-H');
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

  // RESERVED rows: fail closed — no executable result schema exists.
  // Row 9 (deliver) has a frozen ack shape; all others → T-H.
  if (row.leafClosure !== 'CLOSED') {
    return validateReservedRowResult(result, entry);
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

    case 'broker.hello': {
      if (!validateSessionBinding(result)) return close('T-H');
      // SessionBinding is Host-authoritative only for H5–H9. Its four
      // candidate fields are cross-frame echoes, so accepting a structurally
      // valid but different binding would settle the wrong in-flight hello.
      const candidateHello = entry.requestSnapshot?.candidateHello;
      if (candidateHello === undefined) return close('T-H');
      if (
        result.pluginId !== candidateHello.pluginId ||
        result.packageDigest !== candidateHello.packageDigest ||
        result.contractVersion !== candidateHello.contractVersion ||
        result.wireVersion !== candidateHello.wireVersion
      ) {
        return close('T-H');
      }
      return null;
    }

    case 'broker.ready': {
      if (result !== null) return close('T-H');
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
 * Validate results for RESERVED rows.
 *
 * P1-2 maintainer requirement: fail closed when no executable result
 * schema exists, rather than treating absence of an oracle as validity.
 *
 * Row 9 (host.messaging.deliver) is the ONE exception among RESERVED
 * rows — its acknowledgement result shape {deliveryId} is frozen as a
 * closed member set. Validated with deliveryId byte-equality oracle
 * AND strict closed-key enforcement.
 *
 * ALL other RESERVED rows: no executable result schema exists → T-H
 * for any result value (fail-closed).
 */
function validateReservedRowResult(
  result: unknown,
  entry: InFlightEntry,
): DispatchResult | null {
  // ── Row 9 deliver: frozen ack shape {deliveryId: string, 1..128 cp} ──
  if (entry.method === 'host.messaging.deliver') {
    // Fail-closed if snapshot absent or snapshot deliveryId is not a
    // legal oracle value (string within 1..128 code points).
    const snapId = entry.requestSnapshot?.deliveryId;
    if (snapId === undefined) return close('T-H');
    if (typeof snapId !== 'string') return close('T-H');
    const snapLen = [...snapId].length;
    if (snapLen < DELIVER_DELIVERY_ID_MIN_LENGTH || snapLen > DELIVER_DELIVERY_ID_MAX_LENGTH) {
      return close('T-H');
    }

    // Result must be a non-null object
    if (result === null || typeof result !== 'object' || Array.isArray(result)) {
      return close('T-H');
    }
    const resultObj = result as Record<string, unknown>;

    // Closed member set: {deliveryId} only — no extras
    for (const key of Object.keys(resultObj)) {
      if (!DELIVER_RESULT_KEYS.has(key)) return close('T-H');
    }

    // deliveryId must be a string within frozen bounds (1..128 code points)
    if (typeof resultObj.deliveryId !== 'string') return close('T-H');
    const resultIdLen = [...(resultObj.deliveryId as string)].length;
    if (resultIdLen < DELIVER_DELIVERY_ID_MIN_LENGTH || resultIdLen > DELIVER_DELIVERY_ID_MAX_LENGTH) {
      return close('T-H');
    }

    // Byte-equality oracle: result.deliveryId must match snapshot
    if (resultObj.deliveryId !== snapId) return close('T-H');
    return null;
  }

  // ── All other RESERVED rows: no executable result schema → T-H ────
  // The row's result shape is RESERVED (type = `never`). No legal result
  // value exists in v0 — accepting anything would be fail-open.
  return close('T-H');
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
    // in beta.8 → any invocation is a value violation (T-G). T-M is limited
    // to the two registry rows explicitly marked ready=true.
    return respondInvalidParamsValue(id);
  }

  // The two beta.8 handshake rows are now legal Requests. The standalone
  // shell will deliberately return MethodNotFound until its later codec slice;
  // classification itself must not relabel their valid input as T-G or T-F.
  if (row.ready && (wireMethod === 'broker.hello' || wireMethod === 'broker.ready')) {
    return accept('T-M');
  }

  // Direction gate: plugin SDK only accepts host-to-plugin methods as
  // inbound requests. Plugin-to-host methods (rows 1–8) received by
  // the plugin are protocol violations → T-F MethodNotFound.
  //
  // Positioned after all envelope/value checks so that:
  //   - In-flight collision (T-I) takes precedence (per contract fixtures)
  //   - RESERVED row rejection (T-G) takes precedence (input type `never`)
  //   - Only CLOSED plugin-to-host rows with valid params reach here
  if (row.direction === 'plugin-to-host') return respondMethodNotFound(id);

  // All checks passed — valid host-to-plugin CLOSED-row request for dispatch
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
    case 'broker.hello':
      if (hasHandshakeAuthorityInjection(input)) return respondHandshakeAuthorityViolation(id);
      return validateCandidateHello(input) ? null : respondInvalidParamsValue(id);
    case 'broker.ready':
      if (hasHandshakeAuthorityInjection(input)) return respondHandshakeAuthorityViolation(id);
      return validateBrokerReadyParams(input) ? null : respondInvalidParamsValue(id);
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
 * Covers T-C through T-M of the disposition table. T-A and T-B
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
  // The T-C predicate covers: whitespace, duplicate keys, non-scalar
  // strings, non-canonical numbers, and BOM-prefixed frames.
  // Byte-equality catches whitespace, duplicate keys, and most non-
  // canonical numbers. Three supplementary measures close the gaps:
  //   1. ignoreBOM:true — keeps BOM visible so it fails byte-equality.
  //   2. containsNonScalarString — lone surrogates roundtrip thru stringify.
  //   3. containsExponentNumber — V8-canonical exponent form (≥10^21)
  //      also roundtrips, but exponent tokens violate the WireUInt53
  //      raw decimal-digit-only profile.
  //
  // Guard: JSON.stringify and the deep-traversal helpers use recursive
  // descent. A canonical frame nested thousands of levels deep passes
  // V8's iterative JSON.parse but overflows the call stack on stringify.
  // The try-catch ensures classifyFrame never throws — stack overflow
  // is mapped to T-C (close, no response).
  try {
    const rawStr = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
    const canonical = JSON.stringify(value);
    if (rawStr !== canonical) return close('T-C');
    if (containsNonScalarString(value)) return close('T-C');
    if (containsExponentNumber(value)) return close('T-C');
    // P1-1: WireUInt53 raw-token grammar — after byte-equality, the raw
    // token at each WireUInt53 position is String(parsedValue). Tokens
    // like "-1" or "1.5" violate 0|[1-9][0-9]{0,15} → T-C.
    if (hasNonCanonicalUInt53Token(value)) return close('T-C');
  } catch {
    // Stack overflow from deep nesting, or other canonicality edge case.
    return close('T-C');
  }

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
