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
  PLUGIN_ID_MIN_LENGTH,
  PLUGIN_ID_MAX_LENGTH,
  PLUGIN_ID_MAX_ENCODED_BYTES,
  HANDSHAKE_VERSION_MAX_LENGTH,
  HANDSHAKE_VERSION_MAX_ENCODED_BYTES,
  HOST_IDENTIFIER_MIN_LENGTH,
  HOST_IDENTIFIER_MAX_LENGTH,
  HOST_IDENTIFIER_MAX_ENCODED_BYTES,
  BINDING_NONCE_MIN_LENGTH,
  BINDING_NONCE_MAX_LENGTH,
  BINDING_NONCE_MAX_ENCODED_BYTES,
  validatePackageDigest,
  validatePluginId,
  validateContractVersion,
  validateWireVersion,
  validatePluginInstanceId,
  validateBrokerSessionId,
  hasHandshakeAuthorityInjection,
  validateCandidateHello,
  validateSessionBinding,
  validateBrokerReadyParams,
  validateBindingNonce,
  BROKER_HELLO_REQUEST_BYTE_PROOF,
  BROKER_HELLO_RESULT_BYTE_PROOF,
  BROKER_READY_REQUEST_BYTE_PROOF,
  HANDSHAKE_REJECTED_ERROR_BYTE_PROOF,
  HANDSHAKE_ROW_ENCODED_BYTE_BOUNDS,
  // Grants
  MAX_GRANT_ITEMS,
  VALID_CAPABILITIES,
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
  READY_ROWS,
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

test('disposition table has exactly 13 classes T-A through T-M', () => {
  assert.equal(DISPOSITION_CLASSES.length, 13);
  assert.equal(DISPOSITION_CLASSES[0], 'T-A');
  assert.equal(DISPOSITION_CLASSES[12], 'T-M');
  assert.equal(Object.keys(DISPOSITION_TABLE).length, 13);
});

test('disposition subsets partition correctly', () => {
  assert.equal(CLOSE_CLASSES.length, 6, '6 close classes');
  assert.equal(RESPOND_CLASSES.length, 4, '4 respond classes');
  assert.equal(ACCEPT_CLASSES.length, 3, '3 accept classes');
  assert.equal(
    CLOSE_CLASSES.length + RESPOND_CLASSES.length + ACCEPT_CLASSES.length,
    13,
    'subsets cover all 13',
  );
});

test('every disposition class appears in exactly one subset', () => {
  const allInSubsets = [...CLOSE_CLASSES, ...RESPOND_CLASSES, ...ACCEPT_CLASSES];
  const unique = new Set(allInSubsets);
  assert.equal(unique.size, 13, 'no duplicates');
  for (const cls of DISPOSITION_CLASSES) {
    assert.ok(unique.has(cls), `${cls} must appear in exactly one subset`);
  }
});

test('every disposition class has a non-empty predicate and canonicalExample', () => {
  for (const cls of DISPOSITION_CLASSES) {
    const entry = DISPOSITION_TABLE[cls];
    assert.ok(
      entry.predicate.length > 0,
      `${cls} must have a non-empty predicate`,
    );
    assert.ok(
      entry.canonicalExample.length > 0,
      `${cls} must have a non-empty canonicalExample`,
    );
  }
});

test('canonical examples for T-C through T-M are valid JSON', () => {
  // T-A is not valid UTF-8, T-B is not valid JSON -- both intentionally.
  // All others (T-C through T-M) must parse as valid JSON.
  const jsonClasses: (typeof DISPOSITION_CLASSES)[number][] = [
    'T-C', 'T-D', 'T-E', 'T-F', 'T-G', 'T-H', 'T-I', 'T-J', 'T-K', 'T-L', 'T-M',
  ];
  for (const cls of jsonClasses) {
    const entry = DISPOSITION_TABLE[cls];
    assert.doesNotThrow(
      () => JSON.parse(entry.canonicalExample),
      `${cls} canonicalExample must be valid JSON: ${entry.canonicalExample}`,
    );
  }
});

test('T-A and T-B canonical examples are intentionally not valid JSON', () => {
  assert.throws(
    () => JSON.parse(DISPOSITION_TABLE['T-A'].canonicalExample),
    'T-A canonicalExample must not be valid JSON',
  );
  assert.throws(
    () => JSON.parse(DISPOSITION_TABLE['T-B'].canonicalExample),
    'T-B canonicalExample must not be valid JSON',
  );
});

test('close/accept classes have empty errorCodes arrays', () => {
  const nonRespondClasses = [...CLOSE_CLASSES, ...ACCEPT_CLASSES];
  for (const cls of nonRespondClasses) {
    const entry = DISPOSITION_TABLE[cls];
    assert.equal(
      entry.errorCodes.length,
      0,
      `${cls} (outcome=${entry.outcome}) must have empty errorCodes`,
    );
  }
});

test('respond classes have non-empty errorCodes arrays', () => {
  for (const cls of RESPOND_CLASSES) {
    const entry = DISPOSITION_TABLE[cls];
    assert.ok(
      entry.errorCodes.length > 0,
      `${cls} must have at least one errorCode`,
    );
  }
});

test('no two respond classes share the same errorCodes set', () => {
  const seen = new Map<string, string>();
  for (const cls of RESPOND_CLASSES) {
    const entry = DISPOSITION_TABLE[cls];
    const key = [...entry.errorCodes].sort((a, b) => a - b).join(',');
    assert.ok(
      !seen.has(key),
      `${cls} errorCodes set [${key}] collides with ${seen.get(key)}`,
    );
    seen.set(key, cls);
  }
});

test('errorCodes in respond classes are subsets of ALL_ERROR_CODES', () => {
  const allCodes = new Set<number>(ALL_ERROR_CODES);
  for (const cls of RESPOND_CLASSES) {
    const entry = DISPOSITION_TABLE[cls];
    for (const code of entry.errorCodes) {
      assert.ok(
        allCodes.has(code),
        `${cls} errorCode ${code} must be in ALL_ERROR_CODES`,
      );
    }
  }
});

test('frozen errorCodes values per respond class', () => {
  assert.deepEqual(
    [...DISPOSITION_TABLE['T-B'].errorCodes],
    [-32700],
    'T-B: Parse error',
  );
  assert.deepEqual(
    [...DISPOSITION_TABLE['T-D'].errorCodes],
    [-32600],
    'T-D: Invalid Request',
  );
  assert.deepEqual(
    [...DISPOSITION_TABLE['T-F'].errorCodes],
    [-32600, -32601, -32602, -32603],
    'T-F: envelope violations',
  );
  assert.deepEqual(
    [...DISPOSITION_TABLE['T-G'].errorCodes],
    [-32090, -32091, -32092, -32093, -32094, -32602],
    'T-G: value violations',
  );
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

test('beta.8 closes H1/H3/H4/H5/H6 bounded grammars', () => {
  const digest = 'sha512-' + 'A'.repeat(86) + '==';
  assert.equal(PLUGIN_ID_MIN_LENGTH, 1);
  assert.equal(PLUGIN_ID_MAX_LENGTH, 256);
  assert.equal(PLUGIN_ID_MAX_ENCODED_BYTES, 1538);
  assert.equal(HANDSHAKE_VERSION_MAX_LENGTH, 256);
  assert.equal(HANDSHAKE_VERSION_MAX_ENCODED_BYTES, 258);
  assert.equal(HOST_IDENTIFIER_MIN_LENGTH, 1);
  assert.equal(HOST_IDENTIFIER_MAX_LENGTH, 512);
  assert.equal(HOST_IDENTIFIER_MAX_ENCODED_BYTES, 3074);

  assert.ok(validatePluginId('😀'.repeat(256)));
  assert.equal(validatePluginId(''), false);
  assert.equal(validatePluginId('x'.repeat(257)), false);
  assert.ok(validateContractVersion('0.1.0-beta.8'));
  assert.equal(validateContractVersion('^0.1.0'), false);
  assert.ok(validateWireVersion('0.1.0'));
  assert.equal(validateWireVersion('1.0'), false);
  assert.ok(validatePluginInstanceId('instance-1'));
  assert.ok(validateBrokerSessionId('session-1'));
  assert.equal(validatePluginInstanceId('x'.repeat(513)), false);
  assert.equal(validateBrokerSessionId(''), false);

  const hello = {
    pluginId: 'example.loopback',
    packageDigest: digest,
    contractVersion: '0.1.0-beta.8',
    wireVersion: '0.1.0',
  };
  assert.ok(validateCandidateHello(hello));
  assert.equal(validateCandidateHello({ ...hello, pluginInstanceId: 'injected' }), false);
  for (const field of ['pluginInstanceId', 'brokerSessionId', 'grantRevision', 'effectiveGrants']) {
    assert.ok(hasHandshakeAuthorityInjection({ ...hello, [field]: 'injected' }));
    assert.ok(hasHandshakeAuthorityInjection({ bindingNonce: 'nonce-1', [field]: 'injected' }));
  }
  assert.equal(hasHandshakeAuthorityInjection(hello), false);
  assert.equal(hasHandshakeAuthorityInjection({ bindingNonce: 'nonce-1' }), false);
  assert.ok(validateBrokerReadyParams({ bindingNonce: 'nonce-1' }));
  assert.equal(validateBrokerReadyParams({ bindingNonce: 'nonce-1', grantRevision: 1 }), false);
  assert.ok(validateSessionBinding({
    ...hello,
    pluginInstanceId: 'instance-1',
    brokerSessionId: 'session-1',
    grantRevision: 0,
    effectiveGrants: [],
    bindingNonce: 'nonce-1',
  }));
});

test('beta.8 exact-validation evidence covers every H field boundary and type', () => {
  const digest = `sha512-${'A'.repeat(86)}==`;
  const maxVersion = `0.0.0-${'a'.repeat(HANDSHAKE_VERSION_MAX_LENGTH - 6)}`;
  const maxGrants = [...VALID_CAPABILITIES];
  const binding = {
    pluginId: 'a',
    packageDigest: digest,
    contractVersion: '0.0.0',
    wireVersion: '0.0.0',
    pluginInstanceId: 'a',
    brokerSessionId: 'a',
    grantRevision: 0,
    effectiveGrants: [],
    bindingNonce: 'a',
  };

  // H1: Unicode code points, not UTF-16 code units.
  assert.ok(validatePluginId('a'));
  assert.ok(validatePluginId('😀'.repeat(PLUGIN_ID_MAX_LENGTH)));
  assert.equal(validatePluginId(''), false);
  assert.equal(validatePluginId('😀'.repeat(PLUGIN_ID_MAX_LENGTH + 1)), false);
  assert.equal(validatePluginId(1), false);

  // H2: exactly one sha512 SRI grammar and length.
  assert.ok(validatePackageDigest(digest));
  assert.equal(validatePackageDigest(''), false);
  assert.equal(validatePackageDigest(`${digest}A`), false);
  assert.equal(validatePackageDigest(1), false);

  // H3/H4 are the only SemVer-constrained handshake fields.
  for (const validateVersion of [validateContractVersion, validateWireVersion]) {
    assert.ok(validateVersion('0.0.0'));
    assert.ok(validateVersion(maxVersion));
    assert.equal(validateVersion(''), false);
    assert.equal(validateVersion(`${maxVersion}a`), false);
    assert.equal(validateVersion(1), false);
  }

  // H5/H6 preserve the shared opaque-string code-point grammar.
  for (const validateIdentifier of [validatePluginInstanceId, validateBrokerSessionId]) {
    assert.ok(validateIdentifier('a'));
    assert.ok(validateIdentifier('😀'.repeat(HOST_IDENTIFIER_MAX_LENGTH)));
    assert.equal(validateIdentifier(''), false);
    assert.equal(validateIdentifier('😀'.repeat(HOST_IDENTIFIER_MAX_LENGTH + 1)), false);
    assert.equal(validateIdentifier(1), false);
  }

  // H7/H8 are closed SessionBinding values, including their numeric and set bounds.
  assert.ok(validateSessionBinding({ ...binding, grantRevision: 0 }));
  assert.ok(validateSessionBinding({ ...binding, grantRevision: WIRE_UINT53_MAX }));
  assert.equal(validateSessionBinding({ ...binding, grantRevision: -1 }), false);
  assert.equal(validateSessionBinding({ ...binding, grantRevision: WIRE_UINT53_MAX + 1 }), false);
  assert.equal(validateSessionBinding({ ...binding, grantRevision: '0' }), false);
  assert.ok(validateSessionBinding({ ...binding, effectiveGrants: [] }));
  assert.equal(maxGrants.length, MAX_GRANT_ITEMS);
  assert.ok(validateSessionBinding({ ...binding, effectiveGrants: maxGrants }));
  assert.equal(
    validateSessionBinding({
      ...binding,
      effectiveGrants: Array.from({ length: MAX_GRANT_ITEMS + 1 }, () => 'messaging.send'),
    }),
    false,
  );
  assert.equal(validateSessionBinding({ ...binding, effectiveGrants: 'messaging.send' }), false);

  // H9 is the activation nonce and follows the same code-point rule as H5/H6.
  assert.ok(validateBindingNonce('a'));
  assert.ok(validateBindingNonce('😀'.repeat(BINDING_NONCE_MAX_LENGTH)));
  assert.equal(validateBindingNonce(''), false);
  assert.equal(validateBindingNonce('😀'.repeat(BINDING_NONCE_MAX_LENGTH + 1)), false);
  assert.equal(validateBindingNonce(1), false);
});

test('beta.8 raw UTF-8 proofs bind maximum and rejected N+1 handshake values', () => {
  const digest = 'sha512-' + 'A'.repeat(86) + '==';
  const maxSemVer = `0.0.0-${'a'.repeat(HANDSHAKE_VERSION_MAX_LENGTH - 6)}`;
  const hello = {
    pluginId: 'example.loopback',
    packageDigest: digest,
    contractVersion: maxSemVer,
    wireVersion: maxSemVer,
  };
  const binding = {
    ...hello,
    pluginInstanceId: 'instance-1',
    brokerSessionId: 'session-1',
    grantRevision: 0,
    effectiveGrants: [],
    bindingNonce: 'nonce-1',
  };

  for (const proof of [
    BROKER_HELLO_REQUEST_BYTE_PROOF,
    BROKER_HELLO_RESULT_BYTE_PROOF,
    BROKER_READY_REQUEST_BYTE_PROOF,
    HANDSHAKE_REJECTED_ERROR_BYTE_PROOF,
  ]) {
    for (const entry of proof.cases) {
      assert.ok(entry.fitsFrame, `${entry.family} maximum must fit the frame budget`);
      assert.ok(entry.nPlusOne.every(candidate => candidate.fitsFrame),
        `${entry.family} N+1 is rejected by grammar, not by the frame ceiling`);
    }
  }

  for (const codePoint of ['a', '😀', '\u0000']) {
    assert.equal(
      validateCandidateHello({ ...hello, pluginId: codePoint.repeat(PLUGIN_ID_MAX_LENGTH + 1) }),
      false,
      `H1 ${JSON.stringify(codePoint)} N+1 must be rejected`,
    );
  }
  assert.equal(validateCandidateHello({ ...hello, contractVersion: `${maxSemVer}a` }), false);
  assert.equal(validateCandidateHello({ ...hello, wireVersion: `${maxSemVer}a` }), false);
  for (const codePoint of ['a', '😀', '\u0000']) {
    assert.equal(
      validateSessionBinding({
        ...binding,
        pluginInstanceId: codePoint.repeat(HOST_IDENTIFIER_MAX_LENGTH + 1),
      }),
      false,
      `H5 ${JSON.stringify(codePoint)} N+1 must be rejected`,
    );
    assert.equal(
      validateSessionBinding({
        ...binding,
        brokerSessionId: codePoint.repeat(HOST_IDENTIFIER_MAX_LENGTH + 1),
      }),
      false,
      `H6 ${JSON.stringify(codePoint)} N+1 must be rejected`,
    );
  }

  assert.equal(validateCandidateHello(hello), true);
  assert.equal(validateSessionBinding(binding), true);
  assert.equal(validateBrokerReadyParams({ bindingNonce: '😀'.repeat(BINDING_NONCE_MAX_LENGTH + 1) }), false);
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
  const tooMany = Array.from({ length: 18 }, (_, i) => `cap-${i}`);
  assert.equal(validateEffectiveGrants(tooMany), false, 'too many');
});

test('validateEffectiveGrants rejects unknown capabilities (FC-52-4: fail-closed)', () => {
  // Non-existent capability — must be rejected, not silently accepted
  assert.equal(
    validateEffectiveGrants(['not.a.capability']),
    false,
    'unknown capability must fail closed',
  );
  assert.equal(
    validateEffectiveGrants(['messaging.send', 'not.a.capability']),
    false,
    'valid + unknown must fail closed',
  );
  assert.equal(
    validateEffectiveGrants(['MESSAGING.SEND']),
    false,
    'case-sensitive: wrong case must fail closed',
  );
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

test('only beta.8 handshake rows are ready', () => {
  for (const method of WIRE_METHOD_NAMES) {
    const row = WIRE_METHOD_REGISTRY[method];
    assert.equal(
      row.ready,
      method === 'broker.hello' || method === 'broker.ready',
      `${method} readiness must match beta.8 scope`,
    );
  }
  assert.deepEqual([...READY_ROWS], ['broker.hello', 'broker.ready']);
  assert.deepEqual(
    {
      maxEncodedRequestBytes: WIRE_METHOD_REGISTRY['broker.hello'].maxEncodedRequestBytes,
      maxEncodedResultBytes: WIRE_METHOD_REGISTRY['broker.hello'].maxEncodedResultBytes,
      maxEncodedErrorBytes: WIRE_METHOD_REGISTRY['broker.hello'].maxEncodedErrorBytes,
    },
    HANDSHAKE_ROW_ENCODED_BYTE_BOUNDS['broker.hello'],
  );
  assert.deepEqual(
    {
      maxEncodedRequestBytes: WIRE_METHOD_REGISTRY['broker.ready'].maxEncodedRequestBytes,
      maxEncodedResultBytes: WIRE_METHOD_REGISTRY['broker.ready'].maxEncodedResultBytes,
      maxEncodedErrorBytes: WIRE_METHOD_REGISTRY['broker.ready'].maxEncodedErrorBytes,
    },
    HANDSHAKE_ROW_ENCODED_BYTE_BOUNDS['broker.ready'],
  );
  for (const method of WIRE_METHOD_NAMES.slice(2)) {
    const row = getRegistryRow(method);
    assert.equal(row?.maxEncodedRequestBytes, undefined);
    assert.equal(row?.maxEncodedResultBytes, undefined);
    assert.equal(row?.maxEncodedErrorBytes, undefined);
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
  const closed = ['broker.hello', 'broker.ready', 'messaging.subscribe', 'messaging.ack', 'host.grants.changed', 'host.lifecycle.ping', 'host.lifecycle.drain'];
  const reserved = ['messaging.send', 'messaging.appendElements', 'messaging.read', 'messaging.snapshot', 'host.messaging.deliver'];

  assert.equal(CLOSED_LEAF_ROWS.length, 7, '7 closed rows');
  assert.equal(RESERVED_LEAF_ROWS.length, 5, '5 reserved rows');

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
