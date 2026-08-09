import assert from 'node:assert/strict';
import test from 'node:test';

import {
  validateEventsPublishInput,
  validateEventsPublishResult,
} from '../validation/signals.js';
import { MAX_FRAME_BYTES } from './constants.js';
import { validateRequestId } from './request-id.js';
import {
  EVENTS_PUBLISH_BYTE_PROOF_ENCODING_FAMILIES,
  EVENTS_PUBLISH_ERROR_BYTE_PROOF,
  EVENTS_PUBLISH_REQUEST_BYTE_PROOF,
  EVENTS_PUBLISH_RESULT_BYTE_PROOF,
  EVENTS_PUBLISH_ROW_ENCODED_BYTE_BOUNDS,
  eventsPublishMaximumInput,
  eventsPublishNPlusOneInputs,
} from './signal-byte-bounds.js';

test('row 13 maximum frames are legal in every raw UTF-8 family', () => {
  for (const family of EVENTS_PUBLISH_BYTE_PROOF_ENCODING_FAMILIES) {
    const maximum = eventsPublishMaximumInput(family);
    assert.equal(validateEventsPublishInput(maximum.input).valid, true, family);
    assert.notEqual(validateRequestId(maximum.requestId), null, family);
    assert.equal(maximum.payloadEncodedBytes, 65_536, family);
  }

  assert.equal(
    validateEventsPublishResult({
      publicationId: 'a'.repeat(128),
      disposition: 'duplicate',
    }).valid,
    true,
  );
});

test('row 13 exports one rejected N+1 witness for every bounded leaf', () => {
  const expectedLeaves = [
    'requestId',
    'signalType',
    'eventId',
    'idempotencyKey',
    'occurredAt',
    'payloadBytes',
    'sourceHandle',
  ];

  for (const family of EVENTS_PUBLISH_BYTE_PROOF_ENCODING_FAMILIES) {
    const witnesses = eventsPublishNPlusOneInputs(family);
    assert.deepEqual(witnesses.map(({ leaf }) => leaf), expectedLeaves);
    for (const witness of witnesses) {
      const rejected = witness.leaf === 'requestId'
        ? validateRequestId(witness.requestId) === null
        : !validateEventsPublishInput(witness.input).valid;
      assert.equal(rejected, true, `${family}.${witness.leaf} must reject`);
    }
  }
});

test('row 13 derived byte proofs fit the frame and bind the registry summary', () => {
  for (const proof of [
    EVENTS_PUBLISH_REQUEST_BYTE_PROOF,
    EVENTS_PUBLISH_RESULT_BYTE_PROOF,
    EVENTS_PUBLISH_ERROR_BYTE_PROOF,
  ]) {
    assert.ok(proof.maxEncodedBytes > 0);
    assert.ok(proof.maxEncodedBytes < MAX_FRAME_BYTES);
    assert.equal(proof.cases.length, 3);
    assert.equal(proof.cases.every(({ fitsFrame }) => fitsFrame), true);
  }

  assert.deepEqual(EVENTS_PUBLISH_ROW_ENCODED_BYTE_BOUNDS, {
    maxEncodedRequestBytes: EVENTS_PUBLISH_REQUEST_BYTE_PROOF.maxEncodedBytes,
    maxEncodedResultBytes: EVENTS_PUBLISH_RESULT_BYTE_PROOF.maxEncodedBytes,
    maxEncodedErrorBytes: EVENTS_PUBLISH_ERROR_BYTE_PROOF.maxEncodedBytes,
  });
});
