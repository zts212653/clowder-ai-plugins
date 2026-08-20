/**
 * Conformance fixture vector collection assertions.
 *
 * These tests verify the structural integrity of the disposition fixture
 * vectors, NOT the behavior of a classifier (which doesn't exist in D0).
 *
 * Assertion families:
 *   1.  Coverage: every T-class has ≥1 fixture vector (12/12).
 *   2.  Uniqueness: no two vectors share an id.
 *   3.  Outcome consistency: vector outcome matches DISPOSITION_TABLE.
 *   4.  Respond-class arm membership: expectedErrorArm ∈ 11 closed arms.
 *   5.  Respond-class id-arm correctness: null-id arms produce null in response.
 *   6.  Frame budget: all response frames fit within MAX_FRAME_BYTES.
 *   7.  Error code membership: expectedErrorCode ∈ class's errorCodes.
 *   8.  Close/accept invariants: null response markers for non-respond classes.
 *   9.  Response frames are valid compact JSON.
 *   10. CLOSED_ERROR_ARM_NAMES has exactly 11 members.
 *   11. Each fixture vector id starts with its expected T-class prefix.
 *   12. Response frames contain the expected error code.
 *   13. Per-arm byte-proof bound: response bytes ≤ byte-proof engine upper bound.
 *   14. PreState consistency: all vectors have preState with inFlightRequests;
 *       state-dependent vectors have correct correlation records.
 *   15. Partition semantics: RESPONSE_CANDIDATE_CASES (9 keys) and
 *       NOTIFICATION_PARTITION_CASES (7 keys) map to real fixture vectors
 *       AND each case's vector has the expected T-class (FC-70-4).
 *   16. Mutual-exclusivity proof pair: T-H-3 and T-L-2 share rawFrame,
 *       differ only in preState.
 *   17. Minimum vector count.
 *   18. Cross-frame oracle: T-L/T-H vectors with requestSnapshot carry
 *       correct nonce/deliveryId for byte-equality validation.
 *   19. InFlightRecord.method is a valid WireMethodName.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DISPOSITION_FIXTURE_VECTORS,
  BETA8_HANDSHAKE_VECTOR_IDS,
  BETA9_EVENTS_PUBLISH_VECTOR_IDS,
  BETA10_LIFECYCLE_VECTOR_IDS,
  BETA11_MESSAGING_VECTOR_IDS,
  CLOSED_ERROR_ARM_NAMES,
  RESPONSE_CANDIDATE_CASES,
  NOTIFICATION_PARTITION_CASES,
} from './disposition-fixtures.js';

import type {
  ClosedErrorArmName,
  DispositionFixtureVector,
} from './disposition-fixtures.js';

import {
  DISPOSITION_CLASSES,
  DISPOSITION_TABLE,
  RESPOND_CLASSES,
} from './disposition.js';

import { MAX_FRAME_BYTES } from './constants.js';
import {
  BINDING_NONCE_MAX_LENGTH,
  PLUGIN_ID_MAX_LENGTH,
} from './handshake.js';
import { WIRE_METHOD_NAMES } from './registry.js';

// Per-arm byte-proof bounds — test files CAN import from byte-proof since
// tests are excluded from tsconfig.build.json. This is the FC-F0-3 fix:
// instead of self-asserting "frame ≤ MAX_FRAME_BYTES" (too loose), we assert
// "frame ≤ byte-proof engine upper bound for that specific arm."
import {
  parseErrorStaticBytes,
  invalidRequestNullIdStaticBytes,
  standardErrorWithIdTemplate,
  handshakeRejectedErrorTemplate,
  deliveryRejectedErrorTemplate,
  domainErrorTemplate,
  deadlineExpiredErrorTemplate,
  snapshotUnavailableErrorTemplate,
} from '../byte-proof/row-proofs.js';

import { calculateByteProof } from '../byte-proof/encoded-byte-proof.js';

// ---------------------------------------------------------------------------
// Per-arm byte-proof bound mapping (FC-F0-3)
//
// Maps each of the 11 closed error arm names to a byte upper bound derived
// from the byte-proof engine. For static arms (null-id, no variable leaves),
// the bound is the exact byte count. For template arms (variable RequestId
// leaf), the bound is the worst-case byte-proof maxEncodedBytes.
//
// This breaks the self-certification loop: the bounds come from the
// byte-proof engine (row-proofs.ts), not from the fixture data.
// ---------------------------------------------------------------------------

const ARM_BYTE_BOUNDS: Record<ClosedErrorArmName, number> = {
  // Static arms — exact byte count (no variable leaves)
  ParseErrorEnvelope: parseErrorStaticBytes(),
  InvalidRequestNullIdEnvelope: invalidRequestNullIdStaticBytes(),

  // Standard errors with id echo — worst-case template uses longest message
  InvalidRequestValidIdEnvelope: calculateByteProof(standardErrorWithIdTemplate()).maxEncodedBytes,
  MethodNotFoundEnvelope: calculateByteProof(standardErrorWithIdTemplate()).maxEncodedBytes,
  InvalidParamsEnvelope: calculateByteProof(standardErrorWithIdTemplate()).maxEncodedBytes,
  InternalErrorEnvelope: calculateByteProof(standardErrorWithIdTemplate()).maxEncodedBytes,

  // Application errors — each has its own template with domain-specific data
  HandshakeRejectedEnvelope: calculateByteProof(handshakeRejectedErrorTemplate()).maxEncodedBytes,
  DeliveryRejectedEnvelope: calculateByteProof(deliveryRejectedErrorTemplate()).maxEncodedBytes,
  DomainErrorEnvelope: calculateByteProof(domainErrorTemplate()).maxEncodedBytes,
  DeadlineExpiredEnvelope: calculateByteProof(deadlineExpiredErrorTemplate()).maxEncodedBytes,
  SnapshotUnavailableEnvelope: calculateByteProof(snapshotUnavailableErrorTemplate()).maxEncodedBytes,
};

// ---------------------------------------------------------------------------
// Helper: find vector by id
// ---------------------------------------------------------------------------

function findVector(id: string): DispositionFixtureVector {
  const v = DISPOSITION_FIXTURE_VECTORS.find((vec) => vec.id === id);
  if (!v) throw new Error(`fixture vector ${id} not found`);
  return v;
}

// ---------------------------------------------------------------------------
// 1. Coverage: every T-class has at least one fixture vector
// ---------------------------------------------------------------------------

test('every disposition class T-A through T-M has at least one fixture vector', () => {
  const coveredClasses = new Set(
    DISPOSITION_FIXTURE_VECTORS.map((v) => v.expectedClass),
  );
  for (const cls of DISPOSITION_CLASSES) {
    assert.ok(
      coveredClasses.has(cls),
      `disposition class ${cls} has no fixture vector`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2. Uniqueness: no two vectors share an id
// ---------------------------------------------------------------------------

test('fixture vector ids are unique', () => {
  const seen = new Set<string>();
  for (const v of DISPOSITION_FIXTURE_VECTORS) {
    assert.ok(!seen.has(v.id), `duplicate fixture vector id: ${v.id}`);
    seen.add(v.id);
  }
});

// ---------------------------------------------------------------------------
// 3. Outcome consistency: vector outcome matches DISPOSITION_TABLE
// ---------------------------------------------------------------------------

test('each fixture vector outcome matches the disposition table', () => {
  for (const v of DISPOSITION_FIXTURE_VECTORS) {
    const tableRow = DISPOSITION_TABLE[v.expectedClass];
    assert.equal(
      v.expectedOutcome,
      tableRow.outcome,
      `${v.id}: expectedOutcome '${v.expectedOutcome}' does not match table outcome '${tableRow.outcome}'`,
    );
  }
});

// ---------------------------------------------------------------------------
// 4. Respond-class arm membership: expectedErrorArm ∈ 11 closed arms
// ---------------------------------------------------------------------------

test('respond-class vectors have expectedErrorArm in the 11 closed arms', () => {
  const armSet = new Set<string>(CLOSED_ERROR_ARM_NAMES);
  const respondSet = new Set<string>(RESPOND_CLASSES);

  for (const v of DISPOSITION_FIXTURE_VECTORS) {
    if (respondSet.has(v.expectedClass)) {
      assert.ok(
        v.expectedErrorArm !== null,
        `${v.id}: respond-class vector must have non-null expectedErrorArm`,
      );
      assert.ok(
        armSet.has(v.expectedErrorArm!),
        `${v.id}: expectedErrorArm '${v.expectedErrorArm}' not in 11 closed arms`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 5. Respond-class id-arm correctness
// ---------------------------------------------------------------------------

test('null-id error arms produce response frames with "id":null', () => {
  const nullIdArms = new Set([
    'ParseErrorEnvelope',
    'InvalidRequestNullIdEnvelope',
  ]);

  for (const v of DISPOSITION_FIXTURE_VECTORS) {
    if (v.expectedErrorArm !== null && nullIdArms.has(v.expectedErrorArm)) {
      assert.ok(
        v.expectedResponseFrame !== null,
        `${v.id}: respond vector must have non-null expectedResponseFrame`,
      );
      assert.ok(
        v.expectedResponseFrame!.includes('"id":null'),
        `${v.id}: null-id arm '${v.expectedErrorArm}' must produce response with "id":null`,
      );
    }
  }
});

test('valid-id error arms produce response frames with non-null id', () => {
  const nullIdArms = new Set([
    'ParseErrorEnvelope',
    'InvalidRequestNullIdEnvelope',
  ]);

  for (const v of DISPOSITION_FIXTURE_VECTORS) {
    if (v.expectedErrorArm !== null && !nullIdArms.has(v.expectedErrorArm)) {
      assert.ok(
        v.expectedResponseFrame !== null,
        `${v.id}: respond vector must have non-null expectedResponseFrame`,
      );
      assert.ok(
        !v.expectedResponseFrame!.includes('"id":null'),
        `${v.id}: valid-id arm '${v.expectedErrorArm}' must not produce "id":null`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 6. Frame budget: all response frames fit within MAX_FRAME_BYTES
// ---------------------------------------------------------------------------

test('all expected response frames fit within MAX_FRAME_BYTES', () => {
  for (const v of DISPOSITION_FIXTURE_VECTORS) {
    if (v.expectedResponseFrame !== null) {
      const bytes = Buffer.byteLength(v.expectedResponseFrame, 'utf8');
      assert.ok(
        bytes <= MAX_FRAME_BYTES,
        `${v.id}: response frame is ${bytes} bytes, exceeds MAX_FRAME_BYTES (${MAX_FRAME_BYTES})`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 7. Error code membership: expectedErrorCode ∈ class's errorCodes
// ---------------------------------------------------------------------------

test('respond-class expectedErrorCode is in the disposition table errorCodes', () => {
  const respondSet = new Set<string>(RESPOND_CLASSES);

  for (const v of DISPOSITION_FIXTURE_VECTORS) {
    if (respondSet.has(v.expectedClass)) {
      assert.ok(
        v.expectedErrorCode !== null,
        `${v.id}: respond-class vector must have non-null expectedErrorCode`,
      );
      const tableRow = DISPOSITION_TABLE[v.expectedClass];
      assert.ok(
        tableRow.errorCodes.includes(v.expectedErrorCode!),
        `${v.id}: expectedErrorCode ${v.expectedErrorCode} not in ${v.expectedClass} errorCodes [${tableRow.errorCodes}]`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 8. Close/accept invariants: null response markers
// ---------------------------------------------------------------------------

test('close/accept vectors have null response markers', () => {
  const respondSet = new Set<string>(RESPOND_CLASSES);

  for (const v of DISPOSITION_FIXTURE_VECTORS) {
    if (!respondSet.has(v.expectedClass)) {
      assert.equal(
        v.expectedErrorArm,
        null,
        `${v.id}: non-respond class must have null expectedErrorArm`,
      );
      assert.equal(
        v.expectedErrorCode,
        null,
        `${v.id}: non-respond class must have null expectedErrorCode`,
      );
      assert.equal(
        v.expectedResponseFrame,
        null,
        `${v.id}: non-respond class must have null expectedResponseFrame`,
      );
    }
  }
});

test('beta.8 handshake vectors declare zero-side-effect safety', () => {
  assert.equal(
    new Set(BETA8_HANDSHAKE_VECTOR_IDS).size,
    BETA8_HANDSHAKE_VECTOR_IDS.length,
    'beta.8 handshake vector ids must be unique',
  );
  const beta8HandshakeVectors = BETA8_HANDSHAKE_VECTOR_IDS.map((id) => findVector(id));
  assert.equal(beta8HandshakeVectors.length, 26, 'all beta.8 handshake vectors must be present');
  for (const vector of beta8HandshakeVectors) {
    assert.equal(vector.zeroSideEffects, true, `${vector.id} must be zero-side-effect pre-dispatch`);
  }
});

test('beta.8 exported safety vectors cover request, result, error, and raw-byte N/N+1 boundaries', () => {
  const covered = new Set(BETA8_HANDSHAKE_VECTOR_IDS);
  for (const id of ['T-C-2', 'T-M-1', 'T-M-2', 'T-G-2', 'T-G-3', 'T-G-4', 'T-G-5', 'T-G-6', 'T-G-7', 'T-G-8', 'T-G-9', 'T-G-10', 'T-H-10', 'T-H-11', 'T-L-5', 'T-L-6', 'T-M-4', 'T-G-11', 'T-M-5', 'T-G-12', 'T-M-6', 'T-M-7', 'T-G-13', 'T-M-8', 'T-G-14']) {
    assert.ok(covered.has(id as (typeof BETA8_HANDSHAKE_VECTOR_IDS)[number]), `${id} must be exported`);
  }

  const h7Negative = JSON.parse(findVector('T-C-2').rawFrame) as {
    result: { grantRevision: number };
  };
  assert.equal(h7Negative.result.grantRevision, -1, 'T-C-2 must carry a non-canonical H7 raw token');

  const h1Max = JSON.parse(findVector('T-M-3').rawFrame) as { params: { input: { pluginId: string } } };
  const h1NPlusOne = JSON.parse(findVector('T-G-7').rawFrame) as { params: { input: { pluginId: string } } };
  assert.equal(h1Max.params.input.pluginId.length, 256);
  assert.equal(h1NPlusOne.params.input.pluginId.length, 257);
  assert.ok(
    Buffer.byteLength(findVector('T-G-7').rawFrame, 'utf8') > Buffer.byteLength(findVector('T-M-3').rawFrame, 'utf8'),
    'N+1 vector must carry a larger raw UTF-8 frame than the legal maximum vector',
  );

  for (const id of ['T-H-10', 'T-H-11']) {
    const vector = findVector(id);
    const parsed = JSON.parse(vector.rawFrame) as {
      result: { pluginInstanceId: string; brokerSessionId: string };
    };
    const record = vector.preState.inFlightRequests[0];
    assert.ok(record?.requestSnapshot?.candidateHello, `${id} must carry the correlated CandidateHello`);
    const oversizeField = id === 'T-H-10' ? parsed.result.pluginInstanceId : parsed.result.brokerSessionId;
    assert.equal(oversizeField.length, 513, `${id} must exercise its H5/H6 N+1 result bound`);
  }
});

test('beta.8 exports executable maximum and N+1 requests for every raw UTF-8 family', () => {
  const boundaryCases = [
    { maxId: 'T-M-3', nPlusOneId: 'T-G-7', field: 'pluginId', limit: PLUGIN_ID_MAX_LENGTH, codePoint: 'a' },
    { maxId: 'T-M-4', nPlusOneId: 'T-G-11', field: 'pluginId', limit: PLUGIN_ID_MAX_LENGTH, codePoint: '😀' },
    { maxId: 'T-M-5', nPlusOneId: 'T-G-12', field: 'pluginId', limit: PLUGIN_ID_MAX_LENGTH, codePoint: '\u0000' },
    { maxId: 'T-M-6', nPlusOneId: 'T-G-9', field: 'bindingNonce', limit: BINDING_NONCE_MAX_LENGTH, codePoint: 'a' },
    { maxId: 'T-M-7', nPlusOneId: 'T-G-13', field: 'bindingNonce', limit: BINDING_NONCE_MAX_LENGTH, codePoint: '😀' },
    { maxId: 'T-M-8', nPlusOneId: 'T-G-14', field: 'bindingNonce', limit: BINDING_NONCE_MAX_LENGTH, codePoint: '\u0000' },
  ] as const;

  for (const { maxId, nPlusOneId, field, limit, codePoint } of boundaryCases) {
    const maxVector = findVector(maxId);
    const nPlusOneVector = findVector(nPlusOneId);
    const maxInput = JSON.parse(maxVector.rawFrame) as { params: { input: Record<string, string> } };
    const nPlusOneInput = JSON.parse(nPlusOneVector.rawFrame) as { params: { input: Record<string, string> } };

    assert.equal(maxVector.expectedClass, 'T-M', `${maxId} must accept the legal maximum`);
    assert.equal(nPlusOneVector.expectedClass, 'T-G', `${nPlusOneId} must reject N+1 before dispatch`);
    assert.equal(maxInput.params.input[field], codePoint.repeat(limit), `${maxId} must preserve the requested family`);
    assert.equal(nPlusOneInput.params.input[field], codePoint.repeat(limit + 1), `${nPlusOneId} must preserve the requested family`);
    assert.ok(
      Buffer.byteLength(nPlusOneVector.rawFrame, 'utf8') > Buffer.byteLength(maxVector.rawFrame, 'utf8'),
      `${nPlusOneId} must carry a larger raw UTF-8 frame than ${maxId}`,
    );
  }
});

test('beta.8 exported broker.ready safety vectors reject bad activation inputs before side effects', () => {
  const wrongType = JSON.parse(findVector('T-G-8').rawFrame) as {
    params: { input: { bindingNonce: unknown } };
  };
  const nPlusOne = JSON.parse(findVector('T-G-9').rawFrame) as {
    params: { input: { bindingNonce: string } };
  };
  const authorityInjection = JSON.parse(findVector('T-G-10').rawFrame) as {
    params: { input: { pluginInstanceId: string } };
  };

  assert.equal(typeof wrongType.params.input.bindingNonce, 'number');
  assert.equal(nPlusOne.params.input.bindingNonce.length, BINDING_NONCE_MAX_LENGTH + 1);
  assert.ok(
    Buffer.byteLength(findVector('T-G-9').rawFrame, 'utf8') > Buffer.byteLength(findVector('T-M-2').rawFrame, 'utf8'),
    'broker.ready N+1 vector must carry a larger raw UTF-8 frame than the legal activation request',
  );
  assert.equal(authorityInjection.params.input.pluginInstanceId, 'caller-injected');
});

test('beta.8 authority-injection vectors use the closed handshake rejection arm', () => {
  for (const id of ['T-G-2', 'T-G-10']) {
    const vector = findVector(id);
    const response = JSON.parse(vector.expectedResponseFrame!) as {
      error: { code: number; data: { reason: string } };
    };
    assert.equal(vector.expectedErrorArm, 'HandshakeRejectedEnvelope');
    assert.equal(response.error.code, -32090);
    assert.equal(response.error.data.reason, 'AUTHORITY_VIOLATION');
  }
});

test('beta.9 exports the closed C-2 request, rejection, and settlement vectors', () => {
  assert.deepEqual(BETA9_EVENTS_PUBLISH_VECTOR_IDS, [
    'T-M-9',
    'T-G-15',
    'T-H-12',
    'T-L-7',
  ]);
  for (const id of BETA9_EVENTS_PUBLISH_VECTOR_IDS) {
    assert.equal(findVector(id).zeroSideEffects, true, `${id} must be pre-side-effect`);
  }
  assert.equal(findVector('T-M-9').expectedClass, 'T-M');
  assert.equal(findVector('T-G-15').expectedErrorArm, 'InvalidParamsEnvelope');
  assert.equal(findVector('T-H-12').expectedClass, 'T-H');
  assert.equal(findVector('T-L-7').expectedClass, 'T-L');
});

test('beta.10 exports one lifecycle safety set spanning rows 10 through 12', () => {
  assert.deepEqual(BETA10_LIFECYCLE_VECTOR_IDS, [
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
  ]);

  const invalidIds = new Set([
    'T-G-1',
    'T-K-1',
    'T-K-4',
    'T-K-5',
    'T-K-6',
    'T-K-7',
    'T-H-3',
    'T-K-8',
    'T-K-9',
    'T-K-10',
    'T-G-16',
    'T-G-17',
    'T-G-18',
    'T-H-13',
    'T-G-19',
    'T-G-20',
  ]);
  for (const id of BETA10_LIFECYCLE_VECTOR_IDS) {
    const vector = findVector(id);
    if (invalidIds.has(id)) {
      assert.equal(vector.zeroSideEffects, true, `${id} must reject before side effects`);
    }
  }

  const lifecycleMethods = new Set([
    'host.grants.changed',
    'host.lifecycle.ping',
    'host.lifecycle.drain',
  ]);
  const directlyScopedFrames = new Set(
    DISPOSITION_FIXTURE_VECTORS.filter((vector) => {
      let method: unknown;
      try {
        method = (JSON.parse(vector.rawFrame) as { method?: unknown }).method;
      } catch {
        method = undefined;
      }
      return (
        (typeof method === 'string' && lifecycleMethods.has(method)) ||
        vector.preState.inFlightRequests.some((request) => lifecycleMethods.has(request.method))
      );
    }).map((vector) => vector.rawFrame),
  );
  const completeLifecycleIds = DISPOSITION_FIXTURE_VECTORS
    .filter((vector) => directlyScopedFrames.has(vector.rawFrame))
    .map((vector) => vector.id);
  assert.deepEqual(
    BETA10_LIFECYCLE_VECTOR_IDS,
    completeLifecycleIds,
    'public beta.10 safety set must include every canonical lifecycle fixture and proof companion',
  );

  const duplicate = JSON.parse(findVector('T-K-9').rawFrame) as {
    params: { input: { effectiveGrants: string[] } };
  };
  assert.equal(duplicate.params.input.effectiveGrants.length, 2);
  assert.equal(new Set(duplicate.params.input.effectiveGrants).size, 1);

  const unknown = JSON.parse(findVector('T-K-10').rawFrame) as {
    params: { input: { effectiveGrants: string[] } };
  };
  assert.deepEqual(unknown.params.input.effectiveGrants, ['unknown.capability']);
});

test('beta.11 exports one messaging safety set spanning rows 3 through 9', () => {
  const messagingMethods = new Set([
    'messaging.send',
    'messaging.appendElements',
    'messaging.subscribe',
    'messaging.read',
    'messaging.ack',
    'messaging.snapshot',
    'host.messaging.deliver',
  ]);
  const directlyScopedFrames = new Set(
    DISPOSITION_FIXTURE_VECTORS.filter(vector => {
      let method: unknown;
      try {
        method = (JSON.parse(vector.rawFrame) as { method?: unknown }).method;
      } catch {
        method = undefined;
      }
      return (
        (typeof method === 'string' && messagingMethods.has(method))
        || vector.preState.inFlightRequests.some(request => messagingMethods.has(request.method))
      );
    }).map(vector => vector.rawFrame),
  );
  const completeMessagingIds = DISPOSITION_FIXTURE_VECTORS
    .filter(vector => directlyScopedFrames.has(vector.rawFrame))
    .map(vector => vector.id);

  assert.deepEqual(
    BETA11_MESSAGING_VECTOR_IDS,
    completeMessagingIds,
    'public beta.11 safety set must include every canonical messaging fixture and proof companion',
  );
  assert.equal(BETA11_MESSAGING_VECTOR_IDS.length, 36);
  for (const id of BETA11_MESSAGING_VECTOR_IDS) {
    const vector = findVector(id);
    if (vector.expectedClass === 'T-G' || vector.expectedClass === 'T-H') {
      assert.equal(vector.zeroSideEffects, true, `${id} must reject before mutation or settlement`);
    }
  }
});

// ---------------------------------------------------------------------------
// 9. Response frames are valid compact JSON
// ---------------------------------------------------------------------------

test('all expected response frames are valid compact JSON', () => {
  for (const v of DISPOSITION_FIXTURE_VECTORS) {
    if (v.expectedResponseFrame !== null) {
      let parsed: unknown;
      assert.doesNotThrow(
        () => { parsed = JSON.parse(v.expectedResponseFrame!); },
        `${v.id}: expectedResponseFrame is not valid JSON`,
      );
      // Compact: re-serialization must be byte-equal
      assert.equal(
        JSON.stringify(parsed),
        v.expectedResponseFrame,
        `${v.id}: response frame is not compact-canonical JSON`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 10. CLOSED_ERROR_ARM_NAMES has exactly 11 members
// ---------------------------------------------------------------------------

test('CLOSED_ERROR_ARM_NAMES has exactly 11 members (matching 11 envelope variants)', () => {
  assert.equal(CLOSED_ERROR_ARM_NAMES.length, 11);
  // No duplicates
  assert.equal(new Set(CLOSED_ERROR_ARM_NAMES).size, 11);
});

// ---------------------------------------------------------------------------
// 11. Each fixture vector targets exactly one T-class
// ---------------------------------------------------------------------------

test('each fixture vector id starts with its expected T-class prefix', () => {
  for (const v of DISPOSITION_FIXTURE_VECTORS) {
    assert.ok(
      v.id.startsWith(v.expectedClass),
      `${v.id}: id must start with expectedClass '${v.expectedClass}'`,
    );
  }
});

// ---------------------------------------------------------------------------
// 12. Response frames contain the expected error code
// ---------------------------------------------------------------------------

test('respond-class response frames contain the expected error code', () => {
  for (const v of DISPOSITION_FIXTURE_VECTORS) {
    if (v.expectedResponseFrame !== null && v.expectedErrorCode !== null) {
      const parsed = JSON.parse(v.expectedResponseFrame) as {
        error?: { code?: number };
      };
      assert.equal(
        parsed.error?.code,
        v.expectedErrorCode,
        `${v.id}: response frame error code ${parsed.error?.code} does not match expectedErrorCode ${v.expectedErrorCode}`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 13. Per-arm byte-proof bound (FC-F0-3)
//
// For each respond-class vector, assert that its response frame byte length
// ≤ the byte-proof engine upper bound for that specific error arm. This is
// a TIGHTER bound than MAX_FRAME_BYTES — it proves that response frames
// actually fit within the byte-proof ceiling derived from the wire protocol
// type definitions, not a self-asserted maximum.
// ---------------------------------------------------------------------------

test('respond-class response frames fit within per-arm byte-proof bounds', () => {
  for (const v of DISPOSITION_FIXTURE_VECTORS) {
    if (v.expectedResponseFrame !== null && v.expectedErrorArm !== null) {
      const frameBytes = Buffer.byteLength(v.expectedResponseFrame, 'utf8');
      const armBound = ARM_BYTE_BOUNDS[v.expectedErrorArm];

      assert.ok(
        armBound !== undefined,
        `${v.id}: no byte-proof bound registered for arm '${v.expectedErrorArm}'`,
      );

      assert.ok(
        frameBytes <= armBound,
        `${v.id}: response frame is ${frameBytes} bytes, exceeds byte-proof ` +
        `bound for ${v.expectedErrorArm} (${armBound} bytes)`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 14. PreState consistency (FC-6B-3)
//
// Every vector must have a well-formed preState with inFlightRequests array.
// Each InFlightRecord has id and method. State-dependent classes require
// the preState to actually participate in classification:
//   - T-I vectors: request id must appear in inFlightRequests (collision)
//   - T-L vectors: response id must appear in inFlightRequests (correlation)
//   - T-H vectors: response id must NOT appear (unless structural failure)
// ---------------------------------------------------------------------------

test('all vectors have well-formed preState with inFlightRequests array', () => {
  for (const v of DISPOSITION_FIXTURE_VECTORS) {
    assert.ok(
      v.preState !== undefined && v.preState !== null,
      `${v.id}: must have preState`,
    );
    assert.ok(
      Array.isArray(v.preState.inFlightRequests),
      `${v.id}: preState.inFlightRequests must be an array`,
    );
    // Each record must have id and method
    for (const rec of v.preState.inFlightRequests) {
      assert.ok(
        typeof rec.id === 'string' && rec.id.length > 0,
        `${v.id}: inFlightRequests record must have non-empty string id`,
      );
      assert.ok(
        typeof rec.method === 'string' && rec.method.length > 0,
        `${v.id}: inFlightRequests record must have non-empty string method`,
      );
    }
  }
});

test('T-I vectors have the duplicate id in preState.inFlightRequests', () => {
  for (const v of DISPOSITION_FIXTURE_VECTORS) {
    if (v.expectedClass === 'T-I') {
      const parsed = JSON.parse(v.rawFrame) as { id?: string };
      assert.ok(
        parsed.id !== undefined,
        `${v.id}: T-I vector rawFrame must have an id field`,
      );
      const inFlightIds = v.preState.inFlightRequests.map((r) => r.id);
      assert.ok(
        inFlightIds.includes(parsed.id!),
        `${v.id}: T-I vector preState.inFlightRequests must contain the duplicate id '${parsed.id}'`,
      );
    }
  }
});

test('T-L (correlated settlement) vectors have the response id in preState.inFlightRequests', () => {
  for (const v of DISPOSITION_FIXTURE_VECTORS) {
    if (v.expectedClass === 'T-L') {
      const parsed = JSON.parse(v.rawFrame) as { id?: string };
      assert.ok(
        parsed.id !== undefined,
        `${v.id}: T-L vector rawFrame must have an id field`,
      );
      const inFlightIds = v.preState.inFlightRequests.map((r) => r.id);
      assert.ok(
        inFlightIds.includes(parsed.id!),
        `${v.id}: T-L vector preState.inFlightRequests must contain the correlated id '${parsed.id}'`,
      );
    }
  }
});

test('T-L vectors have method in the in-flight record for schema validation', () => {
  for (const v of DISPOSITION_FIXTURE_VECTORS) {
    if (v.expectedClass === 'T-L') {
      const parsed = JSON.parse(v.rawFrame) as { id?: string };
      const record = v.preState.inFlightRequests.find((r) => r.id === parsed.id);
      assert.ok(
        record !== undefined,
        `${v.id}: T-L vector must have an in-flight record for the response id`,
      );
      assert.ok(
        record!.method.length > 0,
        `${v.id}: T-L in-flight record must have a non-empty method for response schema validation`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 15. Partition semantics (FC-6B-1 root cause fix + FC-70-4)
//
// Each key in the partition Record represents a distinct classification
// path from §3.8-1. The test asserts:
//   (a) The Record has the expected number of keys (frozen)
//   (b) Every key maps to a real fixture vector (vectorId)
//   (c) The mapped vector has the expected T-class (expectedClass)
//   (d) No duplicate vectorIds within a partition
//
// FC-70-4 fix: The old test only checked (a) + (b) — existence without
// semantic class verification. A misclassified vector (e.g., T-D-4 when
// it should be T-K) passed because it existed. Now (c) catches that.
// ---------------------------------------------------------------------------

test('RESPONSE_CANDIDATE_CASES has exactly 9 named sub-cases', () => {
  const keys = Object.keys(RESPONSE_CANDIDATE_CASES);
  assert.equal(keys.length, 9, `expected 9 response-candidate sub-cases, got ${keys.length}`);
  // No duplicate vectorIds
  const vectorIds = Object.values(RESPONSE_CANDIDATE_CASES).map((c) => c.vectorId);
  assert.equal(new Set(vectorIds).size, vectorIds.length, 'duplicate vectorIds in RESPONSE_CANDIDATE_CASES');
});

test('every RESPONSE_CANDIDATE_CASES key maps to a real fixture vector with correct T-class', () => {
  const vectorIndex = new Map(DISPOSITION_FIXTURE_VECTORS.map((v) => [v.id, v]));

  for (const [caseName, partCase] of Object.entries(RESPONSE_CANDIDATE_CASES)) {
    const vector = vectorIndex.get(partCase.vectorId);

    // (b) vector exists
    assert.ok(
      vector !== undefined,
      `response-candidate case '${caseName}': fixture vector '${partCase.vectorId}' not found`,
    );

    // (c) vector's expectedClass matches the partition case's expectedClass
    assert.equal(
      vector!.expectedClass,
      partCase.expectedClass,
      `response-candidate case '${caseName}': vector '${partCase.vectorId}' has class ` +
      `'${vector!.expectedClass}' but partition expects '${partCase.expectedClass}'`,
    );
  }
});

test('NOTIFICATION_PARTITION_CASES has exactly 7 named sub-cases', () => {
  const keys = Object.keys(NOTIFICATION_PARTITION_CASES);
  assert.equal(keys.length, 7, `expected 7 notification-partition sub-cases, got ${keys.length}`);
  // No duplicate vectorIds
  const vectorIds = Object.values(NOTIFICATION_PARTITION_CASES).map((c) => c.vectorId);
  assert.equal(new Set(vectorIds).size, vectorIds.length, 'duplicate vectorIds in NOTIFICATION_PARTITION_CASES');
});

test('every NOTIFICATION_PARTITION_CASES key maps to a real fixture vector with correct T-class', () => {
  const vectorIndex = new Map(DISPOSITION_FIXTURE_VECTORS.map((v) => [v.id, v]));

  for (const [caseName, partCase] of Object.entries(NOTIFICATION_PARTITION_CASES)) {
    const vector = vectorIndex.get(partCase.vectorId);

    // (b) vector exists
    assert.ok(
      vector !== undefined,
      `notification-partition case '${caseName}': fixture vector '${partCase.vectorId}' not found`,
    );

    // (c) vector's expectedClass matches the partition case's expectedClass
    assert.equal(
      vector!.expectedClass,
      partCase.expectedClass,
      `notification-partition case '${caseName}': vector '${partCase.vectorId}' has class ` +
      `'${vector!.expectedClass}' but partition expects '${partCase.expectedClass}'`,
    );
  }
});

// ---------------------------------------------------------------------------
// 16. Mutual-exclusivity proof pairs
//
// 16a. Ping nonce (FC-F0-2 / FC-6B-3 / FC-70-3):
//   T-H-3 and T-L-2 share rawFrame, differ in preState.
//   FC-70-3: rawFrame now has valid PingResult {nonce:"x"}.
//
// 16b. Row-9 deliveryId (FC-702-1 / R47):
//   T-H-9 and T-L-4 share method/preState structure for
//   host.messaging.deliver. Only result.deliveryId differs:
//     T-H-9: "wrong-id" ≠ snapshot "correct-id" → T-H
//     T-L-4: "correct-id" = snapshot "correct-id" → T-L
//   This locks the byte-equality oracle's success AND failure sides.
// ---------------------------------------------------------------------------

test('T-H-3 and T-L-2 share rawFrame but differ in preState (mutual-exclusivity proof)', () => {
  const tH3 = findVector('T-H-3');
  const tL2 = findVector('T-L-2');

  // Same rawFrame
  assert.equal(
    tH3.rawFrame,
    tL2.rawFrame,
    'proof pair must share identical rawFrame',
  );

  // Different class outcomes
  assert.equal(tH3.expectedClass, 'T-H');
  assert.equal(tL2.expectedClass, 'T-L');

  // Different preState — the distinguishing factor
  assert.notDeepEqual(
    tH3.preState,
    tL2.preState,
    'proof pair must have different preState',
  );

  // T-H-3: "corr-test" NOT in inFlightRequests
  const tH3InFlightIds = tH3.preState.inFlightRequests.map((r) => r.id);
  assert.ok(
    !tH3InFlightIds.includes('corr-test'),
    'T-H-3: "corr-test" must NOT be in inFlightRequests',
  );

  // T-L-2: "corr-test" IS in inFlightRequests with method
  const tL2Record = tL2.preState.inFlightRequests.find((r) => r.id === 'corr-test');
  assert.ok(
    tL2Record !== undefined,
    'T-L-2: "corr-test" must BE in inFlightRequests',
  );
  assert.ok(
    tL2Record!.method.length > 0,
    'T-L-2: "corr-test" in-flight record must have a method',
  );
});

test('T-H-9 and T-L-4 differ only in result.deliveryId (row-9 exclusive pair, R47)', () => {
  const tH9 = findVector('T-H-9');
  const tL4 = findVector('T-L-4');

  // Same method: host.messaging.deliver
  assert.equal(tH9.preState.inFlightRequests[0]!.method, 'host.messaging.deliver');
  assert.equal(tL4.preState.inFlightRequests[0]!.method, 'host.messaging.deliver');

  // Same request id
  const h9Parsed = JSON.parse(tH9.rawFrame) as { id?: string; result?: { deliveryId?: string } };
  const l4Parsed = JSON.parse(tL4.rawFrame) as { id?: string; result?: { deliveryId?: string } };
  assert.equal(h9Parsed.id, l4Parsed.id, 'exclusive pair must share the same request id');

  // Same snapshot deliveryId (the "expected" value)
  assert.equal(
    tH9.preState.inFlightRequests[0]!.requestSnapshot?.deliveryId,
    tL4.preState.inFlightRequests[0]!.requestSnapshot?.deliveryId,
    'exclusive pair must share the same requestSnapshot.deliveryId',
  );

  // Different result.deliveryId — THE distinguishing factor
  assert.ok(
    h9Parsed.result?.deliveryId !== undefined,
    'T-H-9 must have result.deliveryId',
  );
  assert.ok(
    l4Parsed.result?.deliveryId !== undefined,
    'T-L-4 must have result.deliveryId',
  );
  assert.notEqual(
    h9Parsed.result!.deliveryId,
    l4Parsed.result!.deliveryId,
    'exclusive pair result.deliveryId must differ',
  );

  // T-H-9: result.deliveryId ≠ snapshot.deliveryId → T-H
  assert.notEqual(
    h9Parsed.result!.deliveryId,
    tH9.preState.inFlightRequests[0]!.requestSnapshot?.deliveryId,
    'T-H-9: result.deliveryId must NOT match snapshot (wrong-id → T-H)',
  );
  assert.equal(tH9.expectedClass, 'T-H');

  // T-L-4: result.deliveryId = snapshot.deliveryId → T-L
  assert.equal(
    l4Parsed.result!.deliveryId,
    tL4.preState.inFlightRequests[0]!.requestSnapshot?.deliveryId,
    'T-L-4: result.deliveryId must match snapshot (correct-id → T-L)',
  );
  assert.equal(tL4.expectedClass, 'T-L');
});

// ---------------------------------------------------------------------------
// 17. Total vector count ≥ 36
// ---------------------------------------------------------------------------

test('fixture vectors total count is at least 36', () => {
  assert.ok(
    DISPOSITION_FIXTURE_VECTORS.length >= 36,
    `expected ≥36 vectors, got ${DISPOSITION_FIXTURE_VECTORS.length}`,
  );
});

// ---------------------------------------------------------------------------
// 18. Cross-frame oracle (FC-70-3 / FC-702-1)
//
// Vectors relying on cross-frame semantic oracles must carry the data
// needed for byte-equality validation in requestSnapshot:
//   - T-L-1: ping nonce echo → requestSnapshot.nonce must match result.nonce
//   - T-L-2: ping nonce echo → requestSnapshot.nonce must match result.nonce
//   - T-L-4: row-9 deliveryId → requestSnapshot.deliveryId must match result
//   - T-H-9: row-9 deliveryId mismatch → requestSnapshot.deliveryId must
//             DIFFER from result.deliveryId (that's why it's T-H, not T-L)
// ---------------------------------------------------------------------------

test('T-L ping vectors have requestSnapshot.nonce matching result nonce', () => {
  for (const v of DISPOSITION_FIXTURE_VECTORS) {
    if (v.expectedClass !== 'T-L') continue;
    const parsed = JSON.parse(v.rawFrame) as { id?: string; result?: { nonce?: string } };
    if (!parsed.result?.nonce) continue; // only ping settlements have nonce

    const record = v.preState.inFlightRequests.find((r) => r.id === parsed.id);
    assert.ok(
      record !== undefined,
      `${v.id}: T-L ping vector must have an in-flight record`,
    );
    assert.ok(
      record!.requestSnapshot?.nonce !== undefined,
      `${v.id}: T-L ping settlement must carry requestSnapshot.nonce for byte-equality oracle`,
    );
    assert.equal(
      record!.requestSnapshot!.nonce,
      parsed.result.nonce,
      `${v.id}: requestSnapshot.nonce must match result.nonce (byte-equal echo)`,
    );
  }
});

test('T-H-9 wrong-deliveryId vector has mismatched requestSnapshot.deliveryId', () => {
  const v = findVector('T-H-9');
  const parsed = JSON.parse(v.rawFrame) as { result?: { deliveryId?: string } };

  assert.ok(
    parsed.result?.deliveryId !== undefined,
    'T-H-9 rawFrame must have result.deliveryId',
  );

  const record = v.preState.inFlightRequests[0];
  assert.ok(
    record !== undefined,
    'T-H-9 must have an in-flight record',
  );
  assert.ok(
    record.requestSnapshot?.deliveryId !== undefined,
    'T-H-9 in-flight record must have requestSnapshot.deliveryId',
  );
  assert.notEqual(
    record.requestSnapshot!.deliveryId,
    parsed.result!.deliveryId,
    'T-H-9: requestSnapshot.deliveryId must DIFFER from result.deliveryId (wrong-id scenario)',
  );
});

test('T-L-4 correct-deliveryId vector has matching requestSnapshot.deliveryId', () => {
  const v = findVector('T-L-4');
  const parsed = JSON.parse(v.rawFrame) as { result?: { deliveryId?: string } };

  assert.ok(
    parsed.result?.deliveryId !== undefined,
    'T-L-4 rawFrame must have result.deliveryId',
  );

  const record = v.preState.inFlightRequests[0];
  assert.ok(
    record !== undefined,
    'T-L-4 must have an in-flight record',
  );
  assert.ok(
    record.requestSnapshot?.deliveryId !== undefined,
    'T-L-4 in-flight record must have requestSnapshot.deliveryId',
  );
  assert.equal(
    record.requestSnapshot!.deliveryId,
    parsed.result!.deliveryId,
    'T-L-4: requestSnapshot.deliveryId must MATCH result.deliveryId (correct-id → T-L)',
  );
});

// ---------------------------------------------------------------------------
// 19. InFlightRecord.method is a valid WireMethodName (FC-70-3)
//
// The method field is typed as WireMethodName at compile time, but this
// runtime check catches any drift between the fixture data and the
// registry (e.g., a typo or a renamed method that still compiles due
// to a stale type union).
// ---------------------------------------------------------------------------

test('all InFlightRecord.method values are valid WireMethodNames', () => {
  const validMethods = new Set<string>(WIRE_METHOD_NAMES);
  for (const v of DISPOSITION_FIXTURE_VECTORS) {
    for (const rec of v.preState.inFlightRequests) {
      assert.ok(
        validMethods.has(rec.method),
        `${v.id}: InFlightRecord.method '${rec.method}' is not a valid WireMethodName`,
      );
    }
  }
});
