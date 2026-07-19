import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  calculateByteProof,
  type JsonValue,
} from './encoded-byte-proof.js';

test('calculates all compact-JSON encoding families with N/N+1 candidates', () => {
  const proof = calculateByteProof({
    template: {
      id: 'fixture-id',
      metadata: { token: 'fixture-token' },
    },
    leaves: [
      { id: 'requestId', path: ['id'], maxCodePoints: 2 },
      { id: 'token', path: ['metadata', 'token'], maxCodePoints: 1 },
    ],
    frameLimitBytes: 51,
  });

  assert.deepEqual(
    proof.cases.map(({ family, encodedBytes, fitsFrame }) => ({
      family,
      encodedBytes,
      fitsFrame,
    })),
    [
      { family: 'ascii', encodedBytes: 36, fitsFrame: true },
      { family: 'multibyte', encodedBytes: 45, fitsFrame: true },
      { family: 'escaping', encodedBytes: 51, fitsFrame: true },
    ],
  );
  assert.deepEqual(proof.worstCaseFamilies, ['escaping']);
  assert.deepEqual(proof.cases[2]?.nPlusOne, [
    {
      profileId: 'requestId',
      encodedBytes: 57,
      fitsFrame: false,
      exceedsFrameBy: 6,
    },
    {
      profileId: 'token',
      encodedBytes: 57,
      fitsFrame: false,
      exceedsFrameBy: 6,
    },
  ]);
});

test('proves the three encoding families against a frozen P-2 message-draft fixture', () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL('../../fixtures/messaging/valid/message-draft.json', import.meta.url),
      'utf8',
    ),
  ) as Record<string, unknown>;
  delete fixture['_meta'];

  const proof = calculateByteProof({
    template: fixture as JsonValue,
    leaves: [
      { id: 'threadHandle', path: ['address', 'handle'], maxCodePoints: 256 },
      { id: 'idempotencyKey', path: ['idempotencyKey'], maxCodePoints: 200 },
      {
        id: 'pluginInstanceId',
        path: ['payload', 'provenance', 'origin', 'instanceId'],
        maxCodePoints: 256,
      },
      {
        id: 'elementId',
        path: ['payload', 'elements', 0, 'elementId'],
        maxCodePoints: 128,
      },
    ],
    frameLimitBytes: 1_048_576,
  });

  assert.equal(proof.cases.every(({ fitsFrame }) => fitsFrame), true);
  assert.equal(proof.maxEncodedBytes, proof.cases[2]?.encodedBytes);
  assert.deepEqual(
    proof.cases[2]?.nPlusOne.map(({ profileId }) => profileId),
    ['threadHandle', 'idempotencyKey', 'pluginInstanceId', 'elementId'],
  );
});

test('rejects a profile that does not resolve to a string leaf', () => {
  assert.throws(
    () =>
      calculateByteProof({
        template: { count: 1 },
        leaves: [{ id: 'count', path: ['count'], maxCodePoints: 1 }],
        frameLimitBytes: 10,
      }),
    /must resolve to a string/,
  );
});
