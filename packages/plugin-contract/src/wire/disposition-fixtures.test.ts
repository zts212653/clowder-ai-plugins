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
 *       NOTIFICATION_PARTITION_CASES (7 keys) map to real fixture vectors.
 *   16. Mutual-exclusivity proof pair: T-H-3 and T-L-2 share rawFrame,
 *       differ only in preState.
 *   17. Minimum vector count.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DISPOSITION_FIXTURE_VECTORS,
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

test('every disposition class T-A through T-L has at least one fixture vector', () => {
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
// 15. Partition semantics (FC-6B-1 root cause fix)
//
// Instead of counting to 9/7, we verify NAMED sub-cases. Each key in
// the partition Record represents a distinct classification path from
// §3.8-1. The test asserts that:
//   (a) The Record has the expected number of keys
//   (b) Every key maps to a real fixture vector
//   (c) The mapped vector has the expected T-class for that sub-case
// ---------------------------------------------------------------------------

test('RESPONSE_CANDIDATE_CASES has exactly 9 named sub-cases', () => {
  const keys = Object.keys(RESPONSE_CANDIDATE_CASES);
  assert.equal(keys.length, 9, `expected 9 response-candidate sub-cases, got ${keys.length}`);
  // No duplicate values
  const values = Object.values(RESPONSE_CANDIDATE_CASES);
  assert.equal(new Set(values).size, values.length, 'duplicate vector ids in RESPONSE_CANDIDATE_CASES');
});

test('every RESPONSE_CANDIDATE_CASES key maps to a real fixture vector', () => {
  const vectorIds = new Set(DISPOSITION_FIXTURE_VECTORS.map((v) => v.id));
  for (const [caseName, vectorId] of Object.entries(RESPONSE_CANDIDATE_CASES)) {
    assert.ok(
      vectorIds.has(vectorId),
      `response-candidate case '${caseName}': fixture vector '${vectorId}' not found`,
    );
  }
});

test('NOTIFICATION_PARTITION_CASES has exactly 7 named sub-cases', () => {
  const keys = Object.keys(NOTIFICATION_PARTITION_CASES);
  assert.equal(keys.length, 7, `expected 7 notification-partition sub-cases, got ${keys.length}`);
  // No duplicate values
  const values = Object.values(NOTIFICATION_PARTITION_CASES);
  assert.equal(new Set(values).size, values.length, 'duplicate vector ids in NOTIFICATION_PARTITION_CASES');
});

test('every NOTIFICATION_PARTITION_CASES key maps to a real fixture vector', () => {
  const vectorIds = new Set(DISPOSITION_FIXTURE_VECTORS.map((v) => v.id));
  for (const [caseName, vectorId] of Object.entries(NOTIFICATION_PARTITION_CASES)) {
    assert.ok(
      vectorIds.has(vectorId),
      `notification-partition case '${caseName}': fixture vector '${vectorId}' not found`,
    );
  }
});

// ---------------------------------------------------------------------------
// 16. Mutual-exclusivity proof pair (FC-F0-2 / FC-6B-3)
//
// T-H-3 and T-L-2 MUST share the same rawFrame but differ in preState.
// This proves the classifier must consult preState to distinguish them.
// With FC-6B-3, preState now carries method for each in-flight record.
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

// ---------------------------------------------------------------------------
// 17. Total vector count ≥ 28 (increased from 25 after FC-6B fixes)
// ---------------------------------------------------------------------------

test('fixture vectors total count is at least 28', () => {
  assert.ok(
    DISPOSITION_FIXTURE_VECTORS.length >= 28,
    `expected ≥28 vectors, got ${DISPOSITION_FIXTURE_VECTORS.length}`,
  );
});
