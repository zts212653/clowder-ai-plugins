/**
 * Wire module regression locks and value-level tests.
 *
 * These tests freeze the mechanized values from #1165 rev11.
 * Any change to a locked value must trace to a contract revision.
 * This module defines nothing new — it only asserts existing values.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  // Constants
  MAX_FRAME_BYTES,
  WIRE_VERSION,
  CONTRACT_VERSION,
  JSONRPC_VERSION,
  MAX_ELEMENT_PAYLOAD_BYTES,
  MAX_TOTAL_PAYLOAD_BYTES,
  MAX_ELEMENTS_PER_OPERATION,
  MAX_ELEMENTS_PER_MESSAGE,
  MAX_WHISPER_TARGETS,
  // RequestId
  REQUEST_ID_MIN_LENGTH,
  REQUEST_ID_MAX_LENGTH,
  REQUEST_ID_MIN_ENCODED_BYTES,
  REQUEST_ID_MAX_ENCODED_BYTES,
  validateRequestId,
  isRequestIdShaped,
  // WireUInt53
  WIRE_UINT53_MAX,
  isWireUInt53,
  isCanonicalUInt53Token,
  // Error codes
  HANDSHAKE_REJECTED_CODE,
  DELIVERY_REJECTED_CODE,
  DOMAIN_ERROR_CODE,
  DEADLINE_EXPIRED_CODE,
  SNAPSHOT_UNAVAILABLE_CODE,
  PARSE_ERROR_CODE,
  INVALID_REQUEST_CODE,
  METHOD_NOT_FOUND_CODE,
  INVALID_PARAMS_CODE,
  INTERNAL_ERROR_CODE,
  ERROR_CODE_TO_MESSAGE,
  ALL_ERROR_CODES,
  APPLICATION_ERROR_CODES,
  STANDARD_ERROR_CODES,
  HANDSHAKE_REJECT_REASONS,
  DELIVERY_REJECT_REASONS,
  SNAPSHOT_UNAVAILABLE_REASONS,
  // Disposition
  DISPOSITION_CLASSES,
  DISPOSITION_TABLE,
  CLOSE_CLASSES,
  RESPOND_CLASSES,
  ACCEPT_CLASSES,
  // Handshake
  PACKAGE_DIGEST_LENGTH,
  PACKAGE_DIGEST_ENCODED_BYTES,
  BINDING_NONCE_MIN_LENGTH,
  BINDING_NONCE_MAX_LENGTH,
  BINDING_NONCE_MAX_ENCODED_BYTES,
  validatePackageDigest,
  validateBindingNonce,
  // Grants
  MAX_GRANT_ITEMS,
  validateEffectiveGrants,
  // Registry
  WIRE_METHOD_NAMES,
  WIRE_METHOD_REGISTRY,
  WIRE_METHOD_COUNT,
  PLUGIN_TO_HOST_METHODS,
  HOST_TO_PLUGIN_METHODS,
  NOTIFICATION_METHODS,
  CLOSED_LEAF_ROWS,
  RESERVED_LEAF_ROWS,
  getRegistryRow,
  isWireMethod,
  // Row shape bounds
  SUBSCRIBE_HANDLE_MIN_LENGTH,
  SUBSCRIBE_HANDLE_MAX_LENGTH,
  ACK_SUBSCRIPTION_ID_MAX_LENGTH,
  ACK_TOKEN_MAX_LENGTH,
  PING_NONCE_MIN_LENGTH,
  PING_NONCE_MAX_LENGTH,
} from './index.js';

// ═══════════════════════════════════════════════════════════════════════════
// §1 Constants regression locks
// ═══════════════════════════════════════════════════════════════════════════

test('framing constants are frozen at rev11 values', () => {
  assert.equal(MAX_FRAME_BYTES, 1_048_576, '1 MiB');
  assert.equal(WIRE_VERSION, '0.1.0');
  assert.equal(CONTRACT_VERSION, '0.1.0');
  assert.equal(JSONRPC_VERSION, '2.0');
  assert.equal(MAX_ELEMENT_PAYLOAD_BYTES, 65_536, '64 KiB');
  assert.equal(MAX_TOTAL_PAYLOAD_BYTES, 262_144, '256 KiB');
  assert.equal(MAX_ELEMENTS_PER_OPERATION, 32);
  assert.equal(MAX_ELEMENTS_PER_MESSAGE, 128);
  assert.equal(MAX_WHISPER_TARGETS, 16);
});

// ═══════════════════════════════════════════════════════════════════════════
// §2 RequestId regression locks
// ═══════════════════════════════════════════════════════════════════════════

test('RequestId bounds are frozen', () => {
  assert.equal(REQUEST_ID_MIN_LENGTH, 1);
  assert.equal(REQUEST_ID_MAX_LENGTH, 128);
  assert.equal(REQUEST_ID_MIN_ENCODED_BYTES, 3, '1 char + 2 quotes');
  assert.equal(REQUEST_ID_MAX_ENCODED_BYTES, 130, '128 chars + 2 quotes');
});

test('validateRequestId accepts valid ids', () => {
  assert.ok(validateRequestId('a') !== null, 'single char');
  assert.ok(validateRequestId('abc123') !== null, 'alphanumeric');
  assert.ok(validateRequestId('req.sub:v2-tag_key') !== null, 'with separators');
  assert.ok(validateRequestId('A'.repeat(128)) !== null, 'max length');
});

test('validateRequestId rejects invalid ids', () => {
  assert.equal(validateRequestId(''), null, 'empty');
  assert.equal(validateRequestId(42), null, 'non-string');
  assert.equal(validateRequestId(null), null, 'null');
  assert.equal(validateRequestId('.abc'), null, 'leading dot');
  assert.equal(validateRequestId('-abc'), null, 'leading dash');
  assert.equal(validateRequestId('a'.repeat(129)), null, 'too long');
  assert.equal(validateRequestId('abc def'), null, 'space');
  assert.equal(validateRequestId('abc/def'), null, 'slash');
});

test('isRequestIdShaped is a string type guard', () => {
  assert.equal(isRequestIdShaped('anything'), true);
  assert.equal(isRequestIdShaped(42), false);
  assert.equal(isRequestIdShaped(null), false);
});

// ═══════════════════════════════════════════════════════════════════════════
// §3 WireUInt53 regression locks
// ═══════════════════════════════════════════════════════════════════════════

test('WIRE_UINT53_MAX is 2^53 - 1', () => {
  assert.equal(WIRE_UINT53_MAX, Number.MAX_SAFE_INTEGER);
  assert.equal(WIRE_UINT53_MAX, 9_007_199_254_740_991);
});

test('isWireUInt53 accepts valid values', () => {
  assert.ok(isWireUInt53(0));
  assert.ok(isWireUInt53(1));
  assert.ok(isWireUInt53(WIRE_UINT53_MAX));
});

test('isWireUInt53 rejects invalid values', () => {
  assert.equal(isWireUInt53(-1), false, 'negative');
  assert.equal(isWireUInt53(0.5), false, 'fractional');
  assert.equal(isWireUInt53(WIRE_UINT53_MAX + 1), false, 'overflow');
  assert.equal(isWireUInt53(NaN), false, 'NaN');
  assert.equal(isWireUInt53(Infinity), false, 'Infinity');
});

test('isWireUInt53 respects min/max bounds', () => {
  assert.ok(isWireUInt53(1, 1, 10));
  assert.ok(isWireUInt53(10, 1, 10));
  assert.equal(isWireUInt53(0, 1, 10), false, 'below min');
  assert.equal(isWireUInt53(11, 1, 10), false, 'above max');
});

test('isCanonicalUInt53Token accepts canonical decimals', () => {
  assert.ok(isCanonicalUInt53Token('0'));
  assert.ok(isCanonicalUInt53Token('1'));
  assert.ok(isCanonicalUInt53Token('9007199254740991'));
});

test('isCanonicalUInt53Token rejects non-canonical forms', () => {
  assert.equal(isCanonicalUInt53Token(''), false, 'empty');
  assert.equal(isCanonicalUInt53Token('01'), false, 'leading zero');
  assert.equal(isCanonicalUInt53Token('-1'), false, 'negative');
  assert.equal(isCanonicalUInt53Token('1.0'), false, 'decimal');
  assert.equal(isCanonicalUInt53Token('1e2'), false, 'exponent');
  assert.equal(isCanonicalUInt53Token('12345678901234567'), false, '17 digits — exceeds max raw length');
});

// ═══════════════════════════════════════════════════════════════════════════
// §4 Error code/message regression locks
// ═══════════════════════════════════════════════════════════════════════════

test('application error codes are frozen', () => {
  assert.equal(HANDSHAKE_REJECTED_CODE, -32090);
  assert.equal(DELIVERY_REJECTED_CODE, -32091);
  assert.equal(DOMAIN_ERROR_CODE, -32092);
  assert.equal(DEADLINE_EXPIRED_CODE, -32093);
  assert.equal(SNAPSHOT_UNAVAILABLE_CODE, -32094);
});

test('standard error codes are frozen', () => {
  assert.equal(PARSE_ERROR_CODE, -32700);
  assert.equal(INVALID_REQUEST_CODE, -32600);
  assert.equal(METHOD_NOT_FOUND_CODE, -32601);
  assert.equal(INVALID_PARAMS_CODE, -32602);
  assert.equal(INTERNAL_ERROR_CODE, -32603);
});

test('ERROR_CODE_TO_MESSAGE covers all 10 distinct codes', () => {
  assert.equal(Object.keys(ERROR_CODE_TO_MESSAGE).length, 10);
  for (const code of ALL_ERROR_CODES) {
    assert.ok(
      code in ERROR_CODE_TO_MESSAGE,
      `code ${code} must have a canonical message`,
    );
  }
});

test('error code arrays are exhaustive', () => {
  assert.equal(APPLICATION_ERROR_CODES.length, 5);
  assert.equal(STANDARD_ERROR_CODES.length, 5);
  assert.equal(ALL_ERROR_CODES.length, 10);
});

test('reject-reason taxonomies are frozen', () => {
  assert.equal(HANDSHAKE_REJECT_REASONS.length, 7);
  assert.ok(HANDSHAKE_REJECT_REASONS.includes('MALFORMED_HELLO'));
  assert.ok(HANDSHAKE_REJECT_REASONS.includes('BINDING_REPLAY'));

  assert.equal(DELIVERY_REJECT_REASONS.length, 4);
  assert.ok(DELIVERY_REJECT_REASONS.includes('NO_HANDLER'));

  assert.equal(SNAPSHOT_UNAVAILABLE_REASONS.length, 3);
  assert.ok(SNAPSHOT_UNAVAILABLE_REASONS.includes('VIEW_EXPIRED'));
});

// ═══════════════════════════════════════════════════════════════════════════
// §5 Disposition table regression locks
// ═══════════════════════════════════════════════════════════════════════════

test('disposition table has exactly 12 classes T-A through T-L', () => {
  assert.equal(DISPOSITION_CLASSES.length, 12);
  assert.equal(DISPOSITION_CLASSES[0], 'T-A');
  assert.equal(DISPOSITION_CLASSES[11], 'T-L');
  assert.equal(Object.keys(DISPOSITION_TABLE).length, 12);
});

test('disposition subsets partition correctly', () => {
  assert.equal(CLOSE_CLASSES.length, 6, '6 close classes');
  assert.equal(RESPOND_CLASSES.length, 4, '4 respond classes');
  assert.equal(ACCEPT_CLASSES.length, 2, '2 accept classes');
  assert.equal(
    CLOSE_CLASSES.length + RESPOND_CLASSES.length + ACCEPT_CLASSES.length,
    12,
    'subsets cover all 12',
  );
});

test('every disposition class appears in exactly one subset', () => {
  const allInSubsets = [...CLOSE_CLASSES, ...RESPOND_CLASSES, ...ACCEPT_CLASSES];
  const unique = new Set(allInSubsets);
  assert.equal(unique.size, 12, 'no duplicates');
  for (const cls of DISPOSITION_CLASSES) {
    assert.ok(unique.has(cls), `${cls} must appear in exactly one subset`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// §6 Handshake regression locks
// ═══════════════════════════════════════════════════════════════════════════

test('package digest bounds are frozen', () => {
  assert.equal(PACKAGE_DIGEST_LENGTH, 95);
  assert.equal(PACKAGE_DIGEST_ENCODED_BYTES, 97, '95 chars + 2 quotes');
});

test('validatePackageDigest accepts valid sha512 SRI digests', () => {
  // A valid sha512 SRI digest: sha512- + 86 base64 chars (85 + [AQgw]) + ==
  const validDigest = 'sha512-' + 'A'.repeat(85) + 'A' + '==';
  assert.equal(validDigest.length, 95);
  assert.ok(validatePackageDigest(validDigest));
});

test('validatePackageDigest rejects invalid digests', () => {
  assert.equal(validatePackageDigest('sha256-' + 'A'.repeat(85) + 'A=='), false, 'wrong algo');
  assert.equal(validatePackageDigest('sha512-' + 'A'.repeat(84) + 'A=='), false, 'too short');
  assert.equal(validatePackageDigest('sha512-' + 'A'.repeat(86) + 'A=='), false, 'too long');
  assert.equal(validatePackageDigest(''), false, 'empty');
});

test('binding nonce bounds are frozen', () => {
  assert.equal(BINDING_NONCE_MIN_LENGTH, 1);
  assert.equal(BINDING_NONCE_MAX_LENGTH, 512);
  assert.equal(BINDING_NONCE_MAX_ENCODED_BYTES, 3074, '6 * 512 + 2');
});

test('validateBindingNonce boundary cases', () => {
  assert.ok(validateBindingNonce('x'), 'min length');
  assert.ok(validateBindingNonce('x'.repeat(512)), 'max length');
  assert.equal(validateBindingNonce(''), false, 'empty');
  assert.equal(validateBindingNonce('x'.repeat(513)), false, 'too long (ASCII)');
});

// ═══════════════════════════════════════════════════════════════════════════
// §7 Grant snapshot regression locks
// ═══════════════════════════════════════════════════════════════════════════

test('MAX_GRANT_ITEMS is frozen at 17', () => {
  assert.equal(MAX_GRANT_ITEMS, 17);
});

test('validateEffectiveGrants accepts valid arrays', () => {
  assert.ok(validateEffectiveGrants([]), 'empty');
  assert.ok(validateEffectiveGrants(['messaging.send']), 'single');
  assert.ok(validateEffectiveGrants(['messaging.send', 'onMessage']), 'two distinct');
});

test('validateEffectiveGrants rejects invalid arrays', () => {
  assert.equal(
    validateEffectiveGrants(['messaging.send', 'messaging.send']),
    false,
    'duplicates',
  );
  // 18 items exceeds MAX_GRANT_ITEMS
  const tooMany = Array.from({ length: 18 }, (_, i) => `cap-${i}`) as any;
  assert.equal(validateEffectiveGrants(tooMany), false, 'too many');
});

// ═══════════════════════════════════════════════════════════════════════════
// §8 Registry regression locks
// ═══════════════════════════════════════════════════════════════════════════

test('registry has exactly 12 production methods', () => {
  assert.equal(WIRE_METHOD_NAMES.length, 12);
  assert.equal(WIRE_METHOD_COUNT, 12);
});

test('method names are frozen in order', () => {
  const expected = [
    'broker.hello',
    'broker.ready',
    'messaging.send',
    'messaging.appendElements',
    'messaging.subscribe',
    'messaging.read',
    'messaging.ack',
    'messaging.snapshot',
    'host.messaging.deliver',
    'host.grants.changed',
    'host.lifecycle.ping',
    'host.lifecycle.drain',
  ];
  assert.deepEqual([...WIRE_METHOD_NAMES], expected);
});

test('all 12 rows have ready=false (reservation-only lifecycle)', () => {
  for (const method of WIRE_METHOD_NAMES) {
    const row = WIRE_METHOD_REGISTRY[method];
    assert.equal(row.ready, false, `${method} must be ready=false`);
  }
});

test('row numbers are sequential 1-12', () => {
  WIRE_METHOD_NAMES.forEach((method, i) => {
    assert.equal(
      WIRE_METHOD_REGISTRY[method].rowNumber,
      i + 1,
      `${method} should be row ${i + 1}`,
    );
  });
});

test('leaf closure partition is frozen', () => {
  const closed = ['messaging.subscribe', 'messaging.ack', 'host.grants.changed', 'host.lifecycle.ping', 'host.lifecycle.drain'];
  const reserved = ['broker.hello', 'broker.ready', 'messaging.send', 'messaging.appendElements', 'messaging.read', 'messaging.snapshot', 'host.messaging.deliver'];

  assert.equal(CLOSED_LEAF_ROWS.length, 5, '5 closed rows');
  assert.equal(RESERVED_LEAF_ROWS.length, 7, '7 reserved rows');

  for (const m of closed) {
    assert.equal(WIRE_METHOD_REGISTRY[m as keyof typeof WIRE_METHOD_REGISTRY].leafClosure, 'CLOSED', `${m} CLOSED`);
  }
  for (const m of reserved) {
    assert.equal(WIRE_METHOD_REGISTRY[m as keyof typeof WIRE_METHOD_REGISTRY].leafClosure, 'RESERVED', `${m} RESERVED`);
  }
});

test('direction partition is frozen', () => {
  const p2h = ['broker.hello', 'broker.ready', 'messaging.send', 'messaging.appendElements', 'messaging.subscribe', 'messaging.read', 'messaging.ack', 'messaging.snapshot'];
  const h2p = ['host.messaging.deliver', 'host.grants.changed', 'host.lifecycle.ping', 'host.lifecycle.drain'];

  assert.equal(PLUGIN_TO_HOST_METHODS.length, 8, '8 plugin-to-host');
  assert.equal(HOST_TO_PLUGIN_METHODS.length, 4, '4 host-to-plugin');

  for (const m of p2h) {
    assert.equal(WIRE_METHOD_REGISTRY[m as keyof typeof WIRE_METHOD_REGISTRY].direction, 'plugin-to-host', `${m}`);
  }
  for (const m of h2p) {
    assert.equal(WIRE_METHOD_REGISTRY[m as keyof typeof WIRE_METHOD_REGISTRY].direction, 'host-to-plugin', `${m}`);
  }
});

test('only row 10 is a notification', () => {
  assert.equal(NOTIFICATION_METHODS.length, 1);
  assert.equal(NOTIFICATION_METHODS[0], 'host.grants.changed');
  assert.equal(WIRE_METHOD_REGISTRY['host.grants.changed'].isNotification, true);

  for (const method of WIRE_METHOD_NAMES) {
    if (method !== 'host.grants.changed') {
      assert.equal(
        WIRE_METHOD_REGISTRY[method].isNotification,
        false,
        `${method} should not be a notification`,
      );
    }
  }
});

test('isWireMethod accepts valid methods and rejects invalid ones', () => {
  assert.ok(isWireMethod('broker.hello'));
  assert.ok(isWireMethod('host.lifecycle.drain'));
  assert.equal(isWireMethod('nonexistent.method'), false);
  assert.equal(isWireMethod(''), false);
});

test('getRegistryRow returns row or undefined', () => {
  const row = getRegistryRow('broker.hello');
  assert.ok(row);
  assert.equal(row.rowNumber, 1);
  assert.equal(getRegistryRow('nonexistent'), undefined);
});

// ═══════════════════════════════════════════════════════════════════════════
// §9 Row shape bounds regression locks
// ═══════════════════════════════════════════════════════════════════════════

test('row 5 subscribe bounds are frozen', () => {
  assert.equal(SUBSCRIBE_HANDLE_MIN_LENGTH, 1);
  assert.equal(SUBSCRIBE_HANDLE_MAX_LENGTH, 256);
});

test('row 7 ack bounds are frozen', () => {
  assert.equal(ACK_SUBSCRIPTION_ID_MAX_LENGTH, 128);
  assert.equal(ACK_TOKEN_MAX_LENGTH, 512);
});

test('row 11 ping nonce bounds are frozen', () => {
  assert.equal(PING_NONCE_MIN_LENGTH, 1);
  assert.equal(PING_NONCE_MAX_LENGTH, 512);
});
