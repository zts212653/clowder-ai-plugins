import assert from 'node:assert/strict';
import test from 'node:test';

import { calculateByteProof } from './encoded-byte-proof.js';
import {
  subscribeRequestTemplate,
  subscribeResponseTemplate,
  ackRequestTemplate,
  ackResponseTemplate,
  pingRequestTemplate,
  pingResponseTemplate,
  drainRequestTemplate,
  drainResponseTemplate,
  grantsChangedMaxBytes,
  grantsChangedNPlusOneBytes,
  parseErrorStaticBytes,
  invalidRequestNullIdStaticBytes,
  standardErrorWithIdTemplate,
  handshakeRejectedErrorTemplate,
  deliveryRejectedErrorTemplate,
  domainErrorTemplate,
  deadlineExpiredErrorTemplate,
  snapshotUnavailableErrorTemplate,
  getClosedRowTemplates,
} from './row-proofs.js';
import { MAX_FRAME_BYTES } from '../wire/constants.js';

// ---------------------------------------------------------------------------
// Helper: all byte-proof templates (request/response + error)
// ---------------------------------------------------------------------------

const ALL_BYTEPROOF_TEMPLATES = [
  { label: 'Row 5 subscribe request', factory: subscribeRequestTemplate },
  { label: 'Row 5 subscribe response', factory: subscribeResponseTemplate },
  { label: 'Row 7 ack request', factory: ackRequestTemplate },
  { label: 'Row 7 ack response', factory: ackResponseTemplate },
  { label: 'Row 11 ping request', factory: pingRequestTemplate },
  { label: 'Row 11 ping response', factory: pingResponseTemplate },
  { label: 'Row 12 drain request', factory: drainRequestTemplate },
  { label: 'Row 12 drain response', factory: drainResponseTemplate },
  { label: 'T-F standard error with id', factory: standardErrorWithIdTemplate },
  { label: 'T-G handshake rejected error', factory: handshakeRejectedErrorTemplate },
  { label: 'T-G delivery rejected error', factory: deliveryRejectedErrorTemplate },
  { label: 'T-G domain error', factory: domainErrorTemplate },
  { label: 'T-G deadline expired error', factory: deadlineExpiredErrorTemplate },
  { label: 'T-G snapshot unavailable error', factory: snapshotUnavailableErrorTemplate },
] as const;

// ---------------------------------------------------------------------------
// 1. Each closed row template executes without error
// ---------------------------------------------------------------------------

test('each byte-proof template executes calculateByteProof without error', () => {
  for (const { label, factory } of ALL_BYTEPROOF_TEMPLATES) {
    const input = factory();
    const proof = calculateByteProof(input);
    assert.ok(
      proof.cases.length === 3,
      `${label}: expected 3 encoding families, got ${proof.cases.length}`,
    );
    assert.ok(
      proof.maxEncodedBytes > 0,
      `${label}: maxEncodedBytes must be positive`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2. All templates fit within MAX_FRAME_BYTES
// ---------------------------------------------------------------------------

test('all byte-proof templates fit within MAX_FRAME_BYTES for every encoding family', () => {
  for (const { label, factory } of ALL_BYTEPROOF_TEMPLATES) {
    const proof = calculateByteProof(factory());
    for (const c of proof.cases) {
      assert.ok(
        c.fitsFrame,
        `${label} [${c.family}]: ${c.encodedBytes} bytes exceeds frame limit ${MAX_FRAME_BYTES}`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 3. N+1 candidates exist for each template
// ---------------------------------------------------------------------------

test('N+1 candidates are generated for each leaf in every byte-proof template', () => {
  for (const { label, factory } of ALL_BYTEPROOF_TEMPLATES) {
    const input = factory();
    const proof = calculateByteProof(input);

    for (const c of proof.cases) {
      assert.equal(
        c.nPlusOne.length,
        input.leaves.length,
        `${label} [${c.family}]: expected ${input.leaves.length} N+1 candidates`,
      );

      // Each N+1 candidate must reference a valid leaf profile id
      const leafIds = new Set(input.leaves.map((l) => l.id));
      for (const candidate of c.nPlusOne) {
        assert.ok(
          leafIds.has(candidate.profileId),
          `${label} [${c.family}]: unknown N+1 profileId "${candidate.profileId}"`,
        );
        assert.ok(
          candidate.encodedBytes > 0,
          `${label} [${c.family}]: N+1 candidate ${candidate.profileId} encodedBytes must be positive`,
        );
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 4. RequestId ASCII annotation
//
// RequestId grammar is [A-Za-z0-9._:-]{1,128} (ASCII-only).
// The byte-proof engine computes all three encoding families for structural
// completeness, but only the 'ascii' family produces semantically valid
// RequestId values. The multibyte family (emoji) and escaping family
// (NUL) generate code points outside the RequestId grammar.
//
// For byte proofs, the 'ascii' family is always the cheapest (1 byte per
// code point vs 4 for multibyte or 6 for escaping). Since RequestId is
// ASCII-only, the 'ascii' family is both the binding worst-case and the
// only semantically valid family for RequestId.
// ---------------------------------------------------------------------------

test('RequestId leaf has asciiOnly annotation', () => {
  // Verify the RequestId leaf in any template has asciiOnly: true
  const input = drainRequestTemplate();
  const requestIdLeaf = input.leaves.find((l) => l.id === 'requestId');
  assert.ok(requestIdLeaf, 'requestId leaf must exist');
  assert.equal(
    requestIdLeaf.asciiOnly,
    true,
    'requestId leaf must be marked asciiOnly since its grammar is [A-Za-z0-9._:-]',
  );
});

test('RequestId ascii family produces smaller encoded bytes than multibyte/escaping', () => {
  // Use a template with only RequestId as the variable leaf
  const proof = calculateByteProof(drainResponseTemplate());

  const asciiCase = proof.cases.find((c) => c.family === 'ascii');
  const multibyteCase = proof.cases.find((c) => c.family === 'multibyte');
  const escapingCase = proof.cases.find((c) => c.family === 'escaping');

  assert.ok(asciiCase && multibyteCase && escapingCase);
  assert.ok(
    asciiCase.encodedBytes < multibyteCase.encodedBytes,
    'ascii family must produce fewer bytes than multibyte for ASCII-only leaves',
  );
  assert.ok(
    asciiCase.encodedBytes < escapingCase.encodedBytes,
    'ascii family must produce fewer bytes than escaping for ASCII-only leaves',
  );
});

// ---------------------------------------------------------------------------
// 5. Row 10 static computation
// ---------------------------------------------------------------------------

test('grantsChangedMaxBytes fits within MAX_FRAME_BYTES', () => {
  const maxBytes = grantsChangedMaxBytes();
  assert.ok(
    maxBytes > 0,
    'grantsChangedMaxBytes must be positive',
  );
  assert.ok(
    maxBytes < MAX_FRAME_BYTES,
    `grantsChangedMaxBytes (${maxBytes}) must be < MAX_FRAME_BYTES (${MAX_FRAME_BYTES})`,
  );
});

test('grantsChangedNPlusOneBytes exceeds grantsChangedMaxBytes', () => {
  const maxBytes = grantsChangedMaxBytes();
  const nPlusOneBytes = grantsChangedNPlusOneBytes();
  assert.ok(
    nPlusOneBytes > maxBytes,
    `N+1 bytes (${nPlusOneBytes}) must exceed max bytes (${maxBytes})`,
  );
});

test('grantsChangedNPlusOneBytes still fits within MAX_FRAME_BYTES (cardinality bound, not frame bound)', () => {
  const nPlusOneBytes = grantsChangedNPlusOneBytes();
  assert.ok(
    nPlusOneBytes < MAX_FRAME_BYTES,
    `N+1 bytes (${nPlusOneBytes}) fits frame; cardinality is the binding constraint, not frame size`,
  );
});

// ---------------------------------------------------------------------------
// 6. getClosedRowTemplates covers all 5 closed rows
// ---------------------------------------------------------------------------

test('getClosedRowTemplates covers rows 5, 7, 10, 11, 12', () => {
  const templates = getClosedRowTemplates();
  const rowNumbers = Object.keys(templates).map(Number).sort((a, b) => a - b);
  assert.deepEqual(rowNumbers, [5, 7, 10, 11, 12]);
});

test('getClosedRowTemplates request/response rows have valid ByteProofInput', () => {
  const templates = getClosedRowTemplates();
  for (const row of [5, 7, 11, 12] as const) {
    const entry = templates[row];
    assert.ok(entry.request.template, `row ${row} request must have a template`);
    assert.ok(entry.request.leaves.length > 0, `row ${row} request must have leaves`);
    assert.ok(entry.response.template, `row ${row} response must have a template`);
    assert.ok(entry.response.leaves.length > 0, `row ${row} response must have leaves`);
  }
});

test('getClosedRowTemplates row 10 notification has maxBytes and nPlusOneBytes', () => {
  const templates = getClosedRowTemplates();
  const row10 = templates[10];
  assert.ok(row10.notification.maxBytes > 0, 'row 10 maxBytes must be positive');
  assert.ok(row10.notification.nPlusOneBytes > 0, 'row 10 nPlusOneBytes must be positive');
  assert.ok(
    row10.notification.nPlusOneBytes > row10.notification.maxBytes,
    'row 10 nPlusOneBytes must exceed maxBytes',
  );
});

// ---------------------------------------------------------------------------
// Error frame static byte counts
// ---------------------------------------------------------------------------

test('T-B parseErrorStaticBytes returns a positive value within frame budget', () => {
  const bytes = parseErrorStaticBytes();
  assert.ok(bytes > 0, 'parseErrorStaticBytes must be positive');
  assert.ok(bytes < MAX_FRAME_BYTES, `parseErrorStaticBytes (${bytes}) must fit frame`);
});

test('T-D invalidRequestNullIdStaticBytes returns a positive value within frame budget', () => {
  const bytes = invalidRequestNullIdStaticBytes();
  assert.ok(bytes > 0, 'invalidRequestNullIdStaticBytes must be positive');
  assert.ok(bytes < MAX_FRAME_BYTES, `invalidRequestNullIdStaticBytes (${bytes}) must fit frame`);
});

test('T-D invalidRequestNullIdStaticBytes > T-B parseErrorStaticBytes (longer message)', () => {
  // "Invalid Request" (15 chars) > "Parse error" (11 chars)
  assert.ok(
    invalidRequestNullIdStaticBytes() > parseErrorStaticBytes(),
    'Invalid Request frame must be larger than Parse error frame',
  );
});
