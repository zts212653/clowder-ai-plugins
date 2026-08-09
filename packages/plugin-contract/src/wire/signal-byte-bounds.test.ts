import assert from 'node:assert/strict';
import test from 'node:test';

import {
  validateEventsPublishInput,
  validateEventsPublishResult,
} from '../validation/signals.js';
import { MAX_FRAME_BYTES } from './constants.js';
import { validateRequestId } from './request-id.js';
import {
  ERROR_CODE_TO_MESSAGE,
  INVALID_REQUEST_CODE,
  PARSE_ERROR_CODE,
  STANDARD_ERROR_CODES,
} from './errors.js';
import {
  EVENTS_PUBLISH_BYTE_PROOF_ENCODING_FAMILIES,
  EVENTS_PUBLISH_ERROR_BYTE_PROOF,
  EVENTS_PUBLISH_REQUEST_BYTE_PROOF,
  EVENTS_PUBLISH_RESULT_BYTE_PROOF,
  EVENTS_PUBLISH_ROW_ENCODED_BYTE_BOUNDS,
  eventsPublishMaximumInput,
  eventsPublishMaximumResult,
  eventsPublishNPlusOneInputs,
  eventsPublishResultNPlusOneWitnesses,
  eventsPublishStandardErrorEnvelopes,
  eventsPublishStandardErrorNPlusOneWitnesses,
} from './signal-byte-bounds.js';

function resultEnvelope(requestId: string, result: object): object {
  return { jsonrpc: '2.0', id: requestId, result };
}

function errorEnvelope(id: string | null, error: object): object {
  return { jsonrpc: '2.0', id, error };
}

test('row 13 maximum frames are legal in every raw UTF-8 family', () => {
  const encodedRequestBytes: number[] = [];
  for (const family of EVENTS_PUBLISH_BYTE_PROOF_ENCODING_FAMILIES) {
    const maximum = eventsPublishMaximumInput(family);
    assert.equal(validateEventsPublishInput(maximum.input).valid, true, family);
    assert.notEqual(validateRequestId(maximum.requestId), null, family);
    assert.equal(maximum.payloadEncodedBytes, 65_536, family);
    encodedRequestBytes.push(Buffer.byteLength(JSON.stringify({
      jsonrpc: '2.0',
      id: maximum.requestId,
      method: 'events.publish',
      params: {
        meta: { deadlineUnixMs: Number.MAX_SAFE_INTEGER },
        input: maximum.input,
      },
    }), 'utf8'));
  }

  assert.deepEqual(
    encodedRequestBytes,
    EVENTS_PUBLISH_REQUEST_BYTE_PROOF.cases.map(({ encodedBytes }) => encodedBytes),
  );
  assert.equal(
    Math.max(...encodedRequestBytes),
    EVENTS_PUBLISH_ROW_ENCODED_BYTE_BOUNDS.maxEncodedRequestBytes,
  );

});

test('row 13 maximum result envelope equals its proof and rejects every N+1 leaf', () => {
  const maximum = eventsPublishMaximumResult();
  assert.notEqual(validateRequestId(maximum.requestId), null);
  assert.equal(validateEventsPublishResult(maximum.result).valid, true);
  assert.equal(
    Buffer.byteLength(JSON.stringify(resultEnvelope(maximum.requestId, maximum.result)), 'utf8'),
    EVENTS_PUBLISH_RESULT_BYTE_PROOF.maxEncodedBytes,
  );

  assert.deepEqual(
    eventsPublishResultNPlusOneWitnesses().map(({ leaf }) => leaf),
    ['requestId', 'publicationId'],
  );
  for (const witness of eventsPublishResultNPlusOneWitnesses()) {
    const rejected = witness.leaf === 'requestId'
      ? validateRequestId(witness.requestId) === null
      : !validateEventsPublishResult(witness.result).valid;
    assert.equal(rejected, true, `result.${witness.leaf} must reject`);
  }
});

test('row 13 measures every permitted standard error envelope and its N+1 id', () => {
  const envelopes = eventsPublishStandardErrorEnvelopes();
  assert.equal(envelopes.length, 6, 'five standard errors plus the second Invalid Request id arm');
  assert.deepEqual([...new Set(envelopes.map(({ error }) => error.code))], STANDARD_ERROR_CODES);

  const encodedBytes = envelopes.map(({ id, error }) => {
    assert.equal(error.message, ERROR_CODE_TO_MESSAGE[error.code]);
    if (error.code === PARSE_ERROR_CODE) assert.equal(id, null);
    if (id === null) {
      assert.equal(
        error.code === PARSE_ERROR_CODE || error.code === INVALID_REQUEST_CODE,
        true,
        `unexpected null-id arm for ${error.code}`,
      );
    } else {
      assert.notEqual(validateRequestId(id), null);
    }
    return Buffer.byteLength(JSON.stringify(errorEnvelope(id, error)), 'utf8');
  });
  assert.equal(Math.max(...encodedBytes), EVENTS_PUBLISH_ERROR_BYTE_PROOF.maxEncodedBytes);

  const nPlusOne = eventsPublishStandardErrorNPlusOneWitnesses();
  assert.equal(nPlusOne.length, 4, 'every string-id standard error arm has an N+1 witness');
  for (const witness of nPlusOne) {
    assert.equal(validateRequestId(witness.id), null, `${witness.arm}.requestId must reject`);
  }
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
