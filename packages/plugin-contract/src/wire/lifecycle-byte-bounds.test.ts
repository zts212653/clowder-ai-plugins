import assert from 'node:assert/strict';
import test from 'node:test';

import { calculateByteProof } from '../byte-proof/encoded-byte-proof.js';
import {
  deadlineExpiredErrorTemplate,
  drainRequestTemplate,
  drainResponseTemplate,
  grantsChangedMaxBytes,
  grantsChangedNPlusOneBytes,
  pingRequestTemplate,
  pingResponseTemplate,
  standardErrorWithIdTemplate,
} from '../byte-proof/row-proofs.js';
import { MAX_FRAME_BYTES } from './constants.js';
import {
  HOST_GRANTS_CHANGED_NOTIFICATION_BYTE_PROOF,
  HOST_LIFECYCLE_DRAIN_ERROR_BYTE_PROOF,
  HOST_LIFECYCLE_DRAIN_REQUEST_BYTE_PROOF,
  HOST_LIFECYCLE_DRAIN_RESULT_BYTE_PROOF,
  HOST_LIFECYCLE_PING_ERROR_BYTE_PROOF,
  HOST_LIFECYCLE_PING_REQUEST_BYTE_PROOF,
  HOST_LIFECYCLE_PING_RESULT_BYTE_PROOF,
  LIFECYCLE_BYTE_PROOF_ENCODING_FAMILIES,
  LIFECYCLE_ROW_ENCODED_BYTE_BOUNDS,
} from './lifecycle-byte-bounds.js';

const REQUEST_RESULT_PROOFS = [
  HOST_LIFECYCLE_PING_REQUEST_BYTE_PROOF,
  HOST_LIFECYCLE_PING_RESULT_BYTE_PROOF,
  HOST_LIFECYCLE_DRAIN_REQUEST_BYTE_PROOF,
  HOST_LIFECYCLE_DRAIN_RESULT_BYTE_PROOF,
] as const;

test('lifecycle byte proofs cover every raw UTF-8 family and fit one frame', () => {
  assert.deepEqual([...LIFECYCLE_BYTE_PROOF_ENCODING_FAMILIES], [
    'ascii',
    'multibyte',
    'escaping',
  ]);

  for (const proof of [
    HOST_GRANTS_CHANGED_NOTIFICATION_BYTE_PROOF,
    ...REQUEST_RESULT_PROOFS,
    HOST_LIFECYCLE_PING_ERROR_BYTE_PROOF,
    HOST_LIFECYCLE_DRAIN_ERROR_BYTE_PROOF,
  ]) {
    assert.equal(proof.cases.length, LIFECYCLE_BYTE_PROOF_ENCODING_FAMILIES.length);
    assert.equal(
      proof.maxEncodedBytes,
      Math.max(...proof.cases.map(proofCase => proofCase.encodedBytes)),
    );
    for (const proofCase of proof.cases) {
      assert.ok(proofCase.fitsFrame);
      assert.ok(proofCase.encodedBytes < MAX_FRAME_BYTES);
      for (const witness of proofCase.nPlusOne) {
        assert.ok(witness.encodedBytes > 0, `${proofCase.family}/${witness.leaf}`);
      }
    }
  }
});

test('production lifecycle maxima equal the independent row-proof engine', () => {
  assert.equal(
    HOST_GRANTS_CHANGED_NOTIFICATION_BYTE_PROOF.maxEncodedBytes,
    grantsChangedMaxBytes(),
  );
  assert.equal(
    HOST_GRANTS_CHANGED_NOTIFICATION_BYTE_PROOF.cases[0]?.nPlusOne[0]?.encodedBytes,
    grantsChangedNPlusOneBytes(),
  );
  assert.equal(
    HOST_LIFECYCLE_PING_REQUEST_BYTE_PROOF.maxEncodedBytes,
    calculateByteProof(pingRequestTemplate()).maxEncodedBytes,
  );
  assert.equal(
    HOST_LIFECYCLE_PING_RESULT_BYTE_PROOF.maxEncodedBytes,
    calculateByteProof(pingResponseTemplate()).maxEncodedBytes,
  );
  assert.equal(
    HOST_LIFECYCLE_DRAIN_REQUEST_BYTE_PROOF.maxEncodedBytes,
    calculateByteProof(drainRequestTemplate()).maxEncodedBytes,
  );
  assert.equal(
    HOST_LIFECYCLE_DRAIN_RESULT_BYTE_PROOF.maxEncodedBytes,
    calculateByteProof(drainResponseTemplate()).maxEncodedBytes,
  );
});

test('ping proves nonce and request-id N+1 in every encoding family', () => {
  for (const proof of [
    HOST_LIFECYCLE_PING_REQUEST_BYTE_PROOF,
    HOST_LIFECYCLE_PING_RESULT_BYTE_PROOF,
  ]) {
    for (const proofCase of proof.cases) {
      assert.deepEqual(
        proofCase.nPlusOne.map(witness => witness.leaf).sort(),
        ['nonce', 'requestId'],
      );
      for (const witness of proofCase.nPlusOne) {
        assert.ok(witness.encodedBytes > proofCase.encodedBytes);
      }
    }
  }
});

test('drain proves request-id and numeric-domain rejection witnesses', () => {
  for (const proofCase of HOST_LIFECYCLE_DRAIN_REQUEST_BYTE_PROOF.cases) {
    assert.deepEqual(
      proofCase.nPlusOne.map(witness => witness.leaf).sort(),
      ['deadlineUnixMs', 'requestId'],
    );
  }
  for (const proofCase of HOST_LIFECYCLE_DRAIN_RESULT_BYTE_PROOF.cases) {
    assert.deepEqual(proofCase.nPlusOne.map(witness => witness.leaf), ['requestId']);
  }
});

test('lifecycle error maxima cover standard errors and drain deadline expiry', () => {
  const standardMax = calculateByteProof(standardErrorWithIdTemplate()).maxEncodedBytes;
  const deadlineMax = calculateByteProof(deadlineExpiredErrorTemplate()).maxEncodedBytes;

  assert.equal(HOST_LIFECYCLE_PING_ERROR_BYTE_PROOF.maxEncodedBytes, standardMax);
  assert.equal(
    HOST_LIFECYCLE_DRAIN_ERROR_BYTE_PROOF.maxEncodedBytes,
    Math.max(standardMax, deadlineMax),
  );
});

test('registry summary contains only the bounds applicable to each lifecycle row', () => {
  assert.deepEqual(LIFECYCLE_ROW_ENCODED_BYTE_BOUNDS, {
    'host.grants.changed': {
      maxEncodedRequestBytes: HOST_GRANTS_CHANGED_NOTIFICATION_BYTE_PROOF.maxEncodedBytes,
    },
    'host.lifecycle.ping': {
      maxEncodedRequestBytes: HOST_LIFECYCLE_PING_REQUEST_BYTE_PROOF.maxEncodedBytes,
      maxEncodedResultBytes: HOST_LIFECYCLE_PING_RESULT_BYTE_PROOF.maxEncodedBytes,
      maxEncodedErrorBytes: HOST_LIFECYCLE_PING_ERROR_BYTE_PROOF.maxEncodedBytes,
    },
    'host.lifecycle.drain': {
      maxEncodedRequestBytes: HOST_LIFECYCLE_DRAIN_REQUEST_BYTE_PROOF.maxEncodedBytes,
      maxEncodedResultBytes: HOST_LIFECYCLE_DRAIN_RESULT_BYTE_PROOF.maxEncodedBytes,
      maxEncodedErrorBytes: HOST_LIFECYCLE_DRAIN_ERROR_BYTE_PROOF.maxEncodedBytes,
    },
  });
});
