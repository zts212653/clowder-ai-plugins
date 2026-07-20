/**
 * Conformance fixture vector collection assertions.
 *
 * These tests verify the structural integrity of the disposition fixture
 * vectors, NOT the behavior of a classifier (which doesn't exist in D0).
 *
 * Assertion families:
 *   1. Coverage: every T-class has ≥1 fixture vector (12/12).
 *   2. Uniqueness: no two vectors share an id.
 *   3. Outcome consistency: vector outcome matches DISPOSITION_TABLE.
 *   4. Respond-class arm membership: expectedErrorArm ∈ 11 closed arms.
 *   5. Respond-class id-arm correctness: null-id arms produce null in response.
 *   6. Frame budget: all response frames fit within MAX_FRAME_BYTES.
 *   7. Error code membership: expectedErrorCode ∈ class's errorCodes.
 *   8. Close/accept invariants: null response markers for non-respond classes.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DISPOSITION_FIXTURE_VECTORS,
  CLOSED_ERROR_ARM_NAMES,
} from './disposition-fixtures.js';

import {
  DISPOSITION_CLASSES,
  DISPOSITION_TABLE,
  RESPOND_CLASSES,
} from './disposition.js';

import { MAX_FRAME_BYTES } from './constants.js';

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
