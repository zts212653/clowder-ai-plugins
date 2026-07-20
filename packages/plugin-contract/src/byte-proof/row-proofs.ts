/**
 * Per-row byte-proof templates for all 5 closed rows.
 *
 * Each template defines the worst-case wire frame for one closed row's
 * request/notification + response. The byte-proof engine
 * (calculateByteProof) measures these to verify frame budget compliance
 * and generate N+1 rejection proofs.
 *
 * Only CLOSED rows get byte proofs: 5, 7, 10, 11, 12.
 * RESERVED rows cannot be measured — their shapes are not yet frozen.
 *
 * Templates use placeholder strings ('') for closed string leaves.
 * The engine replaces them with worst-case code points per encoding family.
 */

import type { ByteProofInput, ClosedStringLeafProfile, JsonValue } from './encoded-byte-proof.js';
import { WIRE_UINT53_MAX } from '../wire/wire-uint53.js';
import { MAX_FRAME_BYTES } from '../wire/constants.js';
import {
  REQUEST_ID_MAX_LENGTH,
  SUBSCRIBE_HANDLE_MAX_LENGTH,
  SUBSCRIBE_SUBSCRIPTION_ID_MAX_LENGTH,
  ACK_SUBSCRIPTION_ID_MAX_LENGTH,
  ACK_TOKEN_MAX_LENGTH,
  PING_NONCE_MAX_LENGTH,
  // Standard error codes and messages
  PARSE_ERROR_CODE,
  PARSE_ERROR_MESSAGE,
  INVALID_REQUEST_CODE,
  INVALID_REQUEST_MESSAGE,
  METHOD_NOT_FOUND_CODE,
  METHOD_NOT_FOUND_MESSAGE,
  // Application error codes, messages, and reason taxonomies
  HANDSHAKE_REJECTED_CODE,
  HANDSHAKE_REJECTED_MESSAGE,
  HANDSHAKE_REJECT_REASONS,
  DELIVERY_REJECTED_CODE,
  DELIVERY_REJECTED_MESSAGE,
  DELIVERY_REJECT_REASONS,
  DOMAIN_ERROR_CODE,
  DOMAIN_ERROR_MESSAGE,
  DEADLINE_EXPIRED_CODE,
  DEADLINE_EXPIRED_MESSAGE,
  SNAPSHOT_UNAVAILABLE_CODE,
  SNAPSHOT_UNAVAILABLE_MESSAGE,
  SNAPSHOT_UNAVAILABLE_REASONS,
} from '../wire/index.js';

// ---------------------------------------------------------------------------
// Shared leaf profiles
// ---------------------------------------------------------------------------

const REQUEST_ID_LEAF: ClosedStringLeafProfile = {
  id: 'requestId',
  path: ['id'],
  maxCodePoints: REQUEST_ID_MAX_LENGTH,
  asciiOnly: true,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return the longest string from a non-empty readonly array. */
function longestValue(values: readonly string[]): string {
  return values.reduce((a, b) => (a.length >= b.length ? a : b));
}

/**
 * All MessagingErrorCode values (closed enum from generated contract).
 * Must stay in sync with MessagingErrorCode in contract.generated.ts.
 */
const ALL_MESSAGING_ERROR_CODES = [
  'VALIDATION',
  'PERMISSION',
  'NOT_FOUND',
  'CONFLICT',
  'RETRYABLE_INFLIGHT',
  'STALE_CURSOR',
] as const;

// ---------------------------------------------------------------------------
// Row 5 — messaging.subscribe (CLOSED)
// ---------------------------------------------------------------------------

/** Row 5 request template: messaging.subscribe */
export function subscribeRequestTemplate(): ByteProofInput {
  const template: JsonValue = {
    jsonrpc: '2.0',
    id: '',
    method: 'messaging.subscribe',
    params: {
      meta: { deadlineUnixMs: WIRE_UINT53_MAX },
      input: { handle: '' },
    },
  };

  return {
    template,
    leaves: [
      REQUEST_ID_LEAF,
      {
        id: 'handle',
        path: ['params', 'input', 'handle'],
        maxCodePoints: SUBSCRIBE_HANDLE_MAX_LENGTH,
      },
    ],
    frameLimitBytes: MAX_FRAME_BYTES,
  };
}

/** Row 5 response template: messaging.subscribe result */
export function subscribeResponseTemplate(): ByteProofInput {
  const template: JsonValue = {
    jsonrpc: '2.0',
    id: '',
    result: { subscriptionId: '' },
  };

  return {
    template,
    leaves: [
      REQUEST_ID_LEAF,
      {
        id: 'subscriptionId',
        path: ['result', 'subscriptionId'],
        maxCodePoints: SUBSCRIBE_SUBSCRIPTION_ID_MAX_LENGTH,
      },
    ],
    frameLimitBytes: MAX_FRAME_BYTES,
  };
}

// ---------------------------------------------------------------------------
// Row 7 — messaging.ack (CLOSED)
// ---------------------------------------------------------------------------

/** Row 7 request template: messaging.ack */
export function ackRequestTemplate(): ByteProofInput {
  const template: JsonValue = {
    jsonrpc: '2.0',
    id: '',
    method: 'messaging.ack',
    params: {
      meta: { deadlineUnixMs: WIRE_UINT53_MAX },
      input: {
        subscriptionId: '',
        ackToken: '',
      },
    },
  };

  return {
    template,
    leaves: [
      REQUEST_ID_LEAF,
      {
        id: 'subscriptionId',
        path: ['params', 'input', 'subscriptionId'],
        maxCodePoints: ACK_SUBSCRIPTION_ID_MAX_LENGTH,
      },
      {
        id: 'ackToken',
        path: ['params', 'input', 'ackToken'],
        maxCodePoints: ACK_TOKEN_MAX_LENGTH,
      },
    ],
    frameLimitBytes: MAX_FRAME_BYTES,
  };
}

/** Row 7 response template: messaging.ack result (null) */
export function ackResponseTemplate(): ByteProofInput {
  const template: JsonValue = {
    jsonrpc: '2.0',
    id: '',
    result: null,
  };

  return {
    template,
    leaves: [REQUEST_ID_LEAF],
    frameLimitBytes: MAX_FRAME_BYTES,
  };
}

// ---------------------------------------------------------------------------
// Row 10 — host.grants.changed (CLOSED, notification)
//
// No variable-length string leaves — all strings are fixed Capability
// enum values. We compute the static maximum directly rather than using
// the byte-proof engine (which requires at least one string leaf).
// ---------------------------------------------------------------------------

/**
 * All 17 capability enum values from the generated contract.
 * Listed in alphabetical order for deterministic worst-case computation.
 * Must stay in sync with the Capability type in contract.generated.ts.
 */
const ALL_CAPABILITY_VALUES = [
  'events.publish',
  'memory.append',
  'memory.query',
  'memory.retrieve',
  'message.event.subscribe',
  'messaging.appendElements',
  'messaging.send',
  'onMessage',
  'plugin.config.read',
  'plugin.state.get',
  'plugin.state.set',
  'schedule.register',
  'secret.read',
  'thread.listMetadata',
  'thread.readContent',
  'whisper.extend',
  'windows.create',
] as const;

/**
 * Compute the maximum encoded bytes for a host.grants.changed notification.
 *
 * Static computation because there are no variable-length string leaves.
 * The worst case has all capabilities in effectiveGrants and the maximum
 * grantRevision value.
 */
export function grantsChangedMaxBytes(): number {
  const template = {
    jsonrpc: '2.0',
    method: 'host.grants.changed',
    params: {
      meta: { deadlineUnixMs: WIRE_UINT53_MAX },
      input: {
        grantRevision: WIRE_UINT53_MAX,
        effectiveGrants: ALL_CAPABILITY_VALUES,
      },
    },
  };

  return Buffer.byteLength(JSON.stringify(template), 'utf8');
}

/**
 * N+1 cardinality proof for host.grants.changed.
 *
 * Computes the byte count with MAX_GRANT_ITEMS + 1 (18) capabilities.
 * This exceeds the structural validity bound (MAX_GRANT_ITEMS = 17),
 * demonstrating the cardinality limit. The 18th element uses the longest
 * capability value for worst-case measurement.
 */
export function grantsChangedNPlusOneBytes(): number {
  // Find the longest capability for worst-case N+1 element
  const longestCap = longestValue(ALL_CAPABILITY_VALUES);

  const template = {
    jsonrpc: '2.0',
    method: 'host.grants.changed',
    params: {
      meta: { deadlineUnixMs: WIRE_UINT53_MAX },
      input: {
        grantRevision: WIRE_UINT53_MAX,
        effectiveGrants: [...ALL_CAPABILITY_VALUES, longestCap],
      },
    },
  };

  return Buffer.byteLength(JSON.stringify(template), 'utf8');
}

// ---------------------------------------------------------------------------
// Row 11 — host.lifecycle.ping (CLOSED)
// ---------------------------------------------------------------------------

/** Row 11 request template: host.lifecycle.ping */
export function pingRequestTemplate(): ByteProofInput {
  const template: JsonValue = {
    jsonrpc: '2.0',
    id: '',
    method: 'host.lifecycle.ping',
    params: {
      meta: { deadlineUnixMs: WIRE_UINT53_MAX },
      input: { nonce: '' },
    },
  };

  return {
    template,
    leaves: [
      REQUEST_ID_LEAF,
      {
        id: 'nonce',
        path: ['params', 'input', 'nonce'],
        maxCodePoints: PING_NONCE_MAX_LENGTH,
      },
    ],
    frameLimitBytes: MAX_FRAME_BYTES,
  };
}

/** Row 11 response template: host.lifecycle.ping result */
export function pingResponseTemplate(): ByteProofInput {
  const template: JsonValue = {
    jsonrpc: '2.0',
    id: '',
    result: { nonce: '' },
  };

  return {
    template,
    leaves: [
      REQUEST_ID_LEAF,
      {
        id: 'nonce',
        path: ['result', 'nonce'],
        maxCodePoints: PING_NONCE_MAX_LENGTH,
      },
    ],
    frameLimitBytes: MAX_FRAME_BYTES,
  };
}

// ---------------------------------------------------------------------------
// Row 12 — host.lifecycle.drain (CLOSED)
// ---------------------------------------------------------------------------

/** Row 12 request template: host.lifecycle.drain */
export function drainRequestTemplate(): ByteProofInput {
  const template: JsonValue = {
    jsonrpc: '2.0',
    id: '',
    method: 'host.lifecycle.drain',
    params: {
      meta: { deadlineUnixMs: WIRE_UINT53_MAX },
      input: { deadlineUnixMs: WIRE_UINT53_MAX },
    },
  };

  return {
    template,
    leaves: [REQUEST_ID_LEAF],
    frameLimitBytes: MAX_FRAME_BYTES,
  };
}

/** Row 12 response template: host.lifecycle.drain result (null) */
export function drainResponseTemplate(): ByteProofInput {
  const template: JsonValue = {
    jsonrpc: '2.0',
    id: '',
    result: null,
  };

  return {
    template,
    leaves: [REQUEST_ID_LEAF],
    frameLimitBytes: MAX_FRAME_BYTES,
  };
}

// ---------------------------------------------------------------------------
// Error frame templates — T-B, T-D (fixed), T-F, T-G (variable)
//
// Error envelopes are cross-cutting: they can occur in response to any
// request. The byte-proof engine proves they fit within frame budget.
//
// T-B: Parse error (id: null, no data) — fixed frame, static bytes.
// T-D: Invalid Request null-id (id: null, no data) — fixed frame, static bytes.
// T-F: Standard error with id echo — variable: RequestId.
// T-G: Application error with id echo — variable: RequestId; data uses
//       worst-case enum value (longest from closed taxonomy).
// ---------------------------------------------------------------------------

/**
 * T-B: Parse error static byte count.
 * Fixed frame — no variable leaves; id is always null.
 */
export function parseErrorStaticBytes(): number {
  const frame = {
    jsonrpc: '2.0',
    id: null,
    error: { code: PARSE_ERROR_CODE, message: PARSE_ERROR_MESSAGE },
  };
  return Buffer.byteLength(JSON.stringify(frame), 'utf8');
}

/**
 * T-D: Invalid Request (null-id arm) static byte count.
 * Fixed frame — no variable leaves; id is null because no valid id
 * could be extracted from the malformed request.
 */
export function invalidRequestNullIdStaticBytes(): number {
  const frame = {
    jsonrpc: '2.0',
    id: null,
    error: { code: INVALID_REQUEST_CODE, message: INVALID_REQUEST_MESSAGE },
  };
  return Buffer.byteLength(JSON.stringify(frame), 'utf8');
}

/**
 * T-F: Standard error with id echo — worst-case template.
 *
 * Uses Method not found (-32601), which has the longest canonical message
 * among standard errors with id echo ("Method not found" = 16 chars).
 * Only variable leaf: RequestId.
 */
export function standardErrorWithIdTemplate(): ByteProofInput {
  const template: JsonValue = {
    jsonrpc: '2.0',
    id: '',
    error: { code: METHOD_NOT_FOUND_CODE, message: METHOD_NOT_FOUND_MESSAGE },
  };

  return {
    template,
    leaves: [REQUEST_ID_LEAF],
    frameLimitBytes: MAX_FRAME_BYTES,
  };
}

/**
 * T-G: HANDSHAKE_REJECTED (-32090) error template.
 * Worst-case reason: longest value from HANDSHAKE_REJECT_REASONS.
 */
export function handshakeRejectedErrorTemplate(): ByteProofInput {
  const template: JsonValue = {
    jsonrpc: '2.0',
    id: '',
    error: {
      code: HANDSHAKE_REJECTED_CODE,
      message: HANDSHAKE_REJECTED_MESSAGE,
      data: { reason: longestValue(HANDSHAKE_REJECT_REASONS) },
    },
  };

  return {
    template,
    leaves: [REQUEST_ID_LEAF],
    frameLimitBytes: MAX_FRAME_BYTES,
  };
}

/**
 * T-G: DELIVERY_REJECTED (-32091) error template.
 * Worst-case reason: longest value from DELIVERY_REJECT_REASONS.
 */
export function deliveryRejectedErrorTemplate(): ByteProofInput {
  const template: JsonValue = {
    jsonrpc: '2.0',
    id: '',
    error: {
      code: DELIVERY_REJECTED_CODE,
      message: DELIVERY_REJECTED_MESSAGE,
      data: { reason: longestValue(DELIVERY_REJECT_REASONS) },
    },
  };

  return {
    template,
    leaves: [REQUEST_ID_LEAF],
    frameLimitBytes: MAX_FRAME_BYTES,
  };
}

/**
 * T-G: DOMAIN_ERROR (-32092) error template.
 * Worst-case code: longest value from MessagingErrorCode enum.
 */
export function domainErrorTemplate(): ByteProofInput {
  const template: JsonValue = {
    jsonrpc: '2.0',
    id: '',
    error: {
      code: DOMAIN_ERROR_CODE,
      message: DOMAIN_ERROR_MESSAGE,
      data: { code: longestValue(ALL_MESSAGING_ERROR_CODES) },
    },
  };

  return {
    template,
    leaves: [REQUEST_ID_LEAF],
    frameLimitBytes: MAX_FRAME_BYTES,
  };
}

/**
 * T-G: DEADLINE_EXPIRED (-32093) error template.
 * Data is an empty object (no variable fields).
 */
export function deadlineExpiredErrorTemplate(): ByteProofInput {
  const template: JsonValue = {
    jsonrpc: '2.0',
    id: '',
    error: {
      code: DEADLINE_EXPIRED_CODE,
      message: DEADLINE_EXPIRED_MESSAGE,
      data: {},
    },
  };

  return {
    template,
    leaves: [REQUEST_ID_LEAF],
    frameLimitBytes: MAX_FRAME_BYTES,
  };
}

/**
 * T-G: SNAPSHOT_UNAVAILABLE (-32094) error template.
 * Worst-case reason: longest value from SNAPSHOT_UNAVAILABLE_REASONS.
 */
export function snapshotUnavailableErrorTemplate(): ByteProofInput {
  const template: JsonValue = {
    jsonrpc: '2.0',
    id: '',
    error: {
      code: SNAPSHOT_UNAVAILABLE_CODE,
      message: SNAPSHOT_UNAVAILABLE_MESSAGE,
      data: { reason: longestValue(SNAPSHOT_UNAVAILABLE_REASONS) },
    },
  };

  return {
    template,
    leaves: [REQUEST_ID_LEAF],
    frameLimitBytes: MAX_FRAME_BYTES,
  };
}

// ---------------------------------------------------------------------------
// All closed row templates (convenience)
// ---------------------------------------------------------------------------

export interface ClosedRowProofTemplates {
  readonly request: ByteProofInput;
  readonly response: ByteProofInput;
}

export interface ClosedRowNotificationTemplate {
  readonly notification: {
    readonly maxBytes: number;
    /** Byte count at MAX_GRANT_ITEMS + 1 (N+1 cardinality proof). */
    readonly nPlusOneBytes: number;
  };
}

/**
 * All closed row templates indexed by row number.
 * Row 10 is special — it's a notification with no variable-length leaves.
 */
export function getClosedRowTemplates(): Record<5 | 7 | 11 | 12, ClosedRowProofTemplates> & Record<10, ClosedRowNotificationTemplate> {
  return {
    5: { request: subscribeRequestTemplate(), response: subscribeResponseTemplate() },
    7: { request: ackRequestTemplate(), response: ackResponseTemplate() },
    10: { notification: { maxBytes: grantsChangedMaxBytes(), nPlusOneBytes: grantsChangedNPlusOneBytes() } },
    11: { request: pingRequestTemplate(), response: pingResponseTemplate() },
    12: { request: drainRequestTemplate(), response: drainResponseTemplate() },
  };
}
