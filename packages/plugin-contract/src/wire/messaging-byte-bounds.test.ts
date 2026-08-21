import assert from 'node:assert/strict';
import test from 'node:test';

import { calculateByteProof } from '../byte-proof/encoded-byte-proof.js';
import type { JsonValue } from '../byte-proof/encoded-byte-proof.js';
import {
  ackRequestTemplate,
  ackResponseTemplate,
  deadlineExpiredErrorTemplate,
  deliveryRejectedErrorTemplate,
  domainErrorTemplate,
  snapshotUnavailableErrorTemplate,
  standardErrorWithIdTemplate,
  subscribeRequestTemplate,
  subscribeResponseTemplate,
} from '../byte-proof/row-proofs.js';
import {
  MESSAGING_ROW_METHODS,
  validateMessagingRowInput,
  validateMessagingRowResult,
} from '../validation/messaging-wire.js';
import { MAX_FRAME_BYTES } from './constants.js';
import {
  MESSAGING_BYTE_PROOF_ENCODING_FAMILIES,
  MESSAGING_ERROR_BYTE_PROOFS,
  MESSAGING_REQUEST_BYTE_PROOFS,
  MESSAGING_RESULT_BYTE_PROOFS,
  MESSAGING_ROW_ENCODED_BYTE_BOUNDS,
  messagingMaximumRequestInput,
  messagingMaximumResult,
  messagingRequestNPlusOneInputs,
  messagingResultNPlusOneInputs,
} from './messaging-byte-bounds.js';
import { REQUEST_ID_MAX_LENGTH } from './request-id.js';
import { WIRE_UINT53_MAX } from './wire-uint53.js';

function requestFrame(method: string, input: unknown): JsonValue {
  return {
    jsonrpc: '2.0',
    id: 'a'.repeat(REQUEST_ID_MAX_LENGTH),
    method,
    params: { meta: { deadlineUnixMs: WIRE_UINT53_MAX }, input },
  } as JsonValue;
}

function resultFrame(result: unknown): JsonValue {
  return {
    jsonrpc: '2.0',
    id: 'a'.repeat(REQUEST_ID_MAX_LENGTH),
    result,
  } as JsonValue;
}

function kernelBytes(frame: JsonValue): number {
  return calculateByteProof({
    template: frame,
    leaves: [{
      id: 'requestId',
      path: ['id'],
      maxCodePoints: REQUEST_ID_MAX_LENGTH,
      asciiOnly: true,
    }],
    frameLimitBytes: MAX_FRAME_BYTES,
  }).maxEncodedBytes;
}

test('M0-C request maxima are executable and independently measured by the proof kernel', () => {
  for (const family of MESSAGING_BYTE_PROOF_ENCODING_FAMILIES) {
    for (const method of MESSAGING_ROW_METHODS) {
      const input = messagingMaximumRequestInput(method, family);
      assert.equal(
        validateMessagingRowInput(method, input).valid,
        true,
        `${family} ${method} maximum request must be legal`,
      );
      const proofCase = MESSAGING_REQUEST_BYTE_PROOFS[method].cases.find(
        candidate => candidate.family === family,
      );
      assert.ok(proofCase);
      assert.equal(
        proofCase.encodedBytes,
        kernelBytes(requestFrame(method, input)),
        `${family} ${method} request proof must equal kernel measurement`,
      );
      assert.equal(proofCase.fitsFrame, true);
    }
  }
});

test('M0-C request N+1 witnesses are executable rejected candidates', () => {
  for (const family of MESSAGING_BYTE_PROOF_ENCODING_FAMILIES) {
    for (const method of MESSAGING_ROW_METHODS) {
      const witnesses = messagingRequestNPlusOneInputs(method, family);
      assert.ok(witnesses.length > 0, `${method} must expose request N+1 witnesses`);
      for (const witness of witnesses) {
        assert.equal(
          validateMessagingRowInput(method, witness.input).valid,
          false,
          `${family} ${method} ${witness.leaf} N+1 must reject`,
        );
      }
    }
  }
});

test('structural M0-C result maxima and N+1 witnesses are executable', () => {
  const structuralMethods = [
    'messaging.send',
    'messaging.appendElements',
    'messaging.subscribe',
    'messaging.ack',
    'host.messaging.deliver',
  ] as const;

  for (const family of MESSAGING_BYTE_PROOF_ENCODING_FAMILIES) {
    for (const method of structuralMethods) {
      const result = messagingMaximumResult(method, family);
      assert.equal(
        validateMessagingRowResult(method, result).valid,
        true,
        `${family} ${method} maximum result must be legal`,
      );
      const proofCase = MESSAGING_RESULT_BYTE_PROOFS[method].cases.find(
        candidate => candidate.family === family,
      );
      assert.ok(proofCase);
      assert.equal(proofCase.encodedBytes, kernelBytes(resultFrame(result)));

      for (const witness of messagingResultNPlusOneInputs(method, family)) {
        assert.equal(
          validateMessagingRowResult(method, witness.result).valid,
          false,
          `${family} ${method} ${witness.leaf} N+1 must reject`,
        );
      }
    }
  }
});

test('read and snapshot result bounds are explicit final-frame assembler budgets', () => {
  for (const method of ['messaging.read', 'messaging.snapshot'] as const) {
    const proof = MESSAGING_RESULT_BYTE_PROOFS[method];
    assert.equal(proof.basis, 'assembler-budget');
    assert.equal(proof.maxEncodedBytes, MAX_FRAME_BYTES);
    for (const proofCase of proof.cases) {
      assert.equal(proofCase.encodedBytes, MAX_FRAME_BYTES);
      assert.deepEqual(proofCase.nPlusOne, [{
        leaf: 'frameBytes',
        encodedBytes: MAX_FRAME_BYTES + 1,
        fitsFrame: false,
      }]);
    }
  }
});

test('simple messaging rows exactly agree with independent generic templates', () => {
  assert.equal(
    MESSAGING_ROW_ENCODED_BYTE_BOUNDS['messaging.subscribe'].maxEncodedRequestBytes,
    calculateByteProof(subscribeRequestTemplate()).maxEncodedBytes,
  );
  assert.equal(
    MESSAGING_ROW_ENCODED_BYTE_BOUNDS['messaging.subscribe'].maxEncodedResultBytes,
    calculateByteProof(subscribeResponseTemplate()).maxEncodedBytes,
  );
  assert.equal(
    MESSAGING_ROW_ENCODED_BYTE_BOUNDS['messaging.ack'].maxEncodedRequestBytes,
    calculateByteProof(ackRequestTemplate()).maxEncodedBytes,
  );
  assert.equal(
    MESSAGING_ROW_ENCODED_BYTE_BOUNDS['messaging.ack'].maxEncodedResultBytes,
    calculateByteProof(ackResponseTemplate()).maxEncodedBytes,
  );
});

test('every messaging error bound covers exactly its admitted error arms', () => {
  const standard = calculateByteProof(standardErrorWithIdTemplate()).maxEncodedBytes;
  const domain = calculateByteProof(domainErrorTemplate()).maxEncodedBytes;
  const deadline = calculateByteProof(deadlineExpiredErrorTemplate()).maxEncodedBytes;
  const snapshot = calculateByteProof(snapshotUnavailableErrorTemplate()).maxEncodedBytes;
  const delivery = calculateByteProof(deliveryRejectedErrorTemplate()).maxEncodedBytes;

  for (const method of MESSAGING_ROW_METHODS) {
    const expected = Math.max(
      standard,
      domain,
      deadline,
      ...(method === 'messaging.snapshot' ? [snapshot] : []),
      ...(method === 'host.messaging.deliver' ? [delivery] : []),
    );
    assert.equal(MESSAGING_ERROR_BYTE_PROOFS[method].maxEncodedBytes, expected);
    assert.equal(
      MESSAGING_ROW_ENCODED_BYTE_BOUNDS[method].maxEncodedErrorBytes,
      expected,
    );
  }
});

test('all structural maxima fit one frame and all row bounds are derived', () => {
  for (const method of MESSAGING_ROW_METHODS) {
    assert.ok(MESSAGING_REQUEST_BYTE_PROOFS[method].maxEncodedBytes < MAX_FRAME_BYTES);
    assert.ok(MESSAGING_ERROR_BYTE_PROOFS[method].maxEncodedBytes < MAX_FRAME_BYTES);
    assert.equal(
      MESSAGING_ROW_ENCODED_BYTE_BOUNDS[method].maxEncodedRequestBytes,
      MESSAGING_REQUEST_BYTE_PROOFS[method].maxEncodedBytes,
    );
    assert.equal(
      MESSAGING_ROW_ENCODED_BYTE_BOUNDS[method].maxEncodedResultBytes,
      MESSAGING_RESULT_BYTE_PROOFS[method].maxEncodedBytes,
    );
  }
});
