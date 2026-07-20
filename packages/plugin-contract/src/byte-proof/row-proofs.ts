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
} from '../wire/index.js';

// ---------------------------------------------------------------------------
// Shared leaf profiles
// ---------------------------------------------------------------------------

const REQUEST_ID_LEAF: ClosedStringLeafProfile = {
  id: 'requestId',
  path: ['id'],
  maxCodePoints: REQUEST_ID_MAX_LENGTH,
};

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
 * Capability enum values from the generated contract.
 * Listed in alphabetical order for determinism.
 */
const ALL_CAPABILITY_VALUES = [
  'messaging.appendElements',
  'messaging.send',
  'message.event.subscribe',
  'onMessage',
] as const;

/**
 * Compute the maximum encoded bytes for a host.grants.changed notification.
 *
 * Static computation because there are no variable-length string leaves.
 * The worst case has all capabilities in effectiveGrants and the maximum
 * grantRevision value.
 */
export function grantsChangedMaxBytes(): number {
  // Import all actual capabilities at runtime to build worst-case
  // For now, use a representative template with all known capabilities
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
// All closed row templates (convenience)
// ---------------------------------------------------------------------------

export interface ClosedRowProofTemplates {
  readonly request: ByteProofInput;
  readonly response: ByteProofInput;
}

export interface ClosedRowNotificationTemplate {
  readonly notification: { maxBytes: number };
}

/**
 * All closed row templates indexed by row number.
 * Row 10 is special — it's a notification with no variable-length leaves.
 */
export function getClosedRowTemplates(): Record<5 | 7 | 11 | 12, ClosedRowProofTemplates> & Record<10, ClosedRowNotificationTemplate> {
  return {
    5: { request: subscribeRequestTemplate(), response: subscribeResponseTemplate() },
    7: { request: ackRequestTemplate(), response: ackResponseTemplate() },
    10: { notification: { maxBytes: grantsChangedMaxBytes() } },
    11: { request: pingRequestTemplate(), response: pingResponseTemplate() },
    12: { request: drainRequestTemplate(), response: drainResponseTemplate() },
  };
}
