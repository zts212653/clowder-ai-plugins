import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  calculateByteProof,
  type JsonValue,
} from './encoded-byte-proof.js';

interface BuildConfig {
  exclude?: unknown;
}

const buildConfig = JSON.parse(
  readFileSync(new URL('../../tsconfig.build.json', import.meta.url), 'utf8'),
) as BuildConfig;

test('keeps generic byte-proof tooling out of the published dist artifact', () => {
  assert.ok(
    Array.isArray(buildConfig.exclude) && buildConfig.exclude.includes('src/byte-proof'),
    'the generic calculator must not be compiled into the immutable beta.2 package',
  );
});

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
      // These values copy frozen schema maxLength values (code-point semantics).
      // They are an input example, never a proposed P-1a public wire bound.
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

test('rejects duplicate byte-proof profile ids', () => {
  assert.throws(
    () =>
      calculateByteProof({
        template: { left: 'left', right: 'right' },
        leaves: [
          { id: 'duplicate', path: ['left'], maxCodePoints: 1 },
          { id: 'duplicate', path: ['right'], maxCodePoints: 1 },
        ],
        frameLimitBytes: 10,
      }),
    /duplicate byte-proof profile id/,
  );
});

test('rejects duplicate byte-proof profile paths', () => {
  assert.throws(
    () =>
      calculateByteProof({
        template: { value: 'value' },
        leaves: [
          { id: 'first', path: ['value'], maxCodePoints: 1 },
          { id: 'second', path: ['value'], maxCodePoints: 1 },
        ],
        frameLimitBytes: 10,
      }),
    /duplicate byte-proof profile path/,
  );
});

test('rejects an unresolved byte-proof profile path', () => {
  assert.throws(
    () =>
      calculateByteProof({
        template: { present: 'value' },
        leaves: [{ id: 'missing', path: ['absent'], maxCodePoints: 1 }],
        frameLimitBytes: 10,
      }),
    /has an unresolved path/,
  );
});

test('rejects a byte-proof template containing a non-finite number', () => {
  assert.throws(
    () =>
      calculateByteProof({
        template: { value: 'value', malformed: Number.NaN },
        leaves: [{ id: 'value', path: ['value'], maxCodePoints: 1 }],
        frameLimitBytes: 10,
      }),
    /only finite JSON numbers/,
  );
});
