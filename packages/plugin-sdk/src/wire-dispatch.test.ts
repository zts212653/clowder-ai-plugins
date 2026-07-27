/**
 * Wire dispatch classifier tests — fixture-driven from the contract's
 * frozen disposition table (§3.8-1), plus structural edge cases.
 *
 * S1 scope: classify decoded NDJSON frames into disposition classes
 * T-C through T-L. T-A (transport) and T-B (JSON parse) are handled
 * by the NDJSON decoder layer, not the dispatch classifier.
 *
 * All fixture vectors consumed from @clowder-ai/plugin-contract — no
 * fixture data is redefined here (Fable's S1 boundary).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

// Test-only relative import: disposition fixtures are not part of the
// published beta.4 public surface. SDK tests consume them directly from
// contract source (tsx resolves .ts at runtime; test files are excluded
// from the SDK dist artifact). See Fable ruling on F1/beta.4 immutability.
import {
  DISPOSITION_FIXTURE_VECTORS,
  type DispositionFixtureVector,
} from '../../plugin-contract/src/wire/disposition-fixtures.js';

import type {
  DecodedNdjsonFrame,
  JsonObject,
} from '@clowder-ai/plugin-contract/conformance';

import {
  classifyFrame,
  type DispatchResult,
  type InFlightEntry,
} from './wire-dispatch.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a DecodedNdjsonFrame from fixture rawFrame, or null for pre-decode vectors. */
function frameFromFixture(v: DispositionFixtureVector): DecodedNdjsonFrame | null {
  if (v.rawFrameEncoding === 'hex') return null; // T-A: byte-level failure
  try {
    const raw = Buffer.from(v.rawFrame, 'utf8');
    const value = JSON.parse(v.rawFrame) as JsonObject;
    return { raw, value };
  } catch {
    return null; // T-B: JSON parse failure
  }
}

/** Build InFlightEntry map from fixture preState. */
function inFlightFromFixture(
  v: DispositionFixtureVector,
): ReadonlyMap<string, InFlightEntry> {
  const map = new Map<string, InFlightEntry>();
  for (const rec of v.preState.inFlightRequests) {
    map.set(rec.id, {
      method: rec.method,
      requestSnapshot: rec.requestSnapshot,
    });
  }
  return map;
}

const NO_IN_FLIGHT: ReadonlyMap<string, InFlightEntry> = new Map();

// ---------------------------------------------------------------------------
// Fixture-driven sweep: all T-C through T-L vectors
// ---------------------------------------------------------------------------

const classifiableVectors = DISPOSITION_FIXTURE_VECTORS.filter(
  v => v.expectedClass !== 'T-A' && v.expectedClass !== 'T-B',
);

for (const v of classifiableVectors) {
  test(`disposition ${v.id}: ${v.description}`, () => {
    const frame = frameFromFixture(v);
    assert.ok(
      frame !== null,
      `fixture ${v.id} must be parseable for post-decode classification`,
    );

    const result = classifyFrame(frame, inFlightFromFixture(v));

    assert.equal(
      result.disposition,
      v.expectedClass,
      `expected disposition ${v.expectedClass}, got ${result.disposition}`,
    );
    assert.equal(
      result.outcome,
      v.expectedOutcome,
      `expected outcome ${v.expectedOutcome}, got ${result.outcome}`,
    );

    if (v.expectedResponseFrame !== null) {
      assert.equal(result.outcome, 'respond');
      assert.ok(
        result.response !== undefined,
        'respond outcome must carry a response envelope',
      );
      assert.equal(
        JSON.stringify(result.response),
        v.expectedResponseFrame,
        'response frame must match the contract-defined expected envelope',
      );
    } else if (result.outcome !== 'accept') {
      assert.equal(
        result.response,
        undefined,
        'non-respond outcomes must not carry a response',
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Fixture coverage sanity
// ---------------------------------------------------------------------------

test('fixture sweep covers all post-decode vectors from the contract', () => {
  const preDecodeCount = DISPOSITION_FIXTURE_VECTORS.filter(
    v => v.expectedClass === 'T-A' || v.expectedClass === 'T-B',
  ).length;
  assert.equal(
    classifiableVectors.length,
    DISPOSITION_FIXTURE_VECTORS.length - preDecodeCount,
  );
  assert.ok(
    classifiableVectors.length >= 30,
    `expected ≥30 post-decode vectors, got ${classifiableVectors.length}`,
  );
});

// ---------------------------------------------------------------------------
// Structural edge cases — behaviors the fixtures reference but worth
// testing with explicit intent
// ---------------------------------------------------------------------------

test('valid request that passes all checks returns accept with null disposition', () => {
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(
      '{"jsonrpc":"2.0","id":"req-1","method":"host.lifecycle.ping","params":{"meta":{"deadlineUnixMs":1},"input":{"nonce":"hello"}}}',
      'utf8',
    ),
    value: {
      jsonrpc: '2.0',
      id: 'req-1',
      method: 'host.lifecycle.ping',
      params: {
        meta: { deadlineUnixMs: 1 },
        input: { nonce: 'hello' },
      },
    },
  };

  const result = classifyFrame(frame, NO_IN_FLIGHT);
  assert.equal(result.outcome, 'accept');
  assert.equal(result.disposition, null);
});

test('reserved method with valid envelope is T-G (input type never → value violation)', () => {
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(
      '{"jsonrpc":"2.0","id":"r1","method":"messaging.send","params":{"meta":{"deadlineUnixMs":1},"input":{}}}',
      'utf8',
    ),
    value: {
      jsonrpc: '2.0',
      id: 'r1',
      method: 'messaging.send',
      params: { meta: { deadlineUnixMs: 1 }, input: {} },
    },
  };

  const result = classifyFrame(frame, NO_IN_FLIGHT);
  // RESERVED rows have input type `never` — no legal params value exists
  // in v0. The disposition table has no accept class for Requests
  // (ACCEPT_CLASSES = {T-J, T-L} only). Fable ruling: T-G respond error.
  assert.equal(result.disposition, 'T-G');
  assert.equal(result.outcome, 'respond');
  assert.ok(result.response !== undefined);
});

// ---------------------------------------------------------------------------
// Fail-closed anti-examples — each proves a specific fail-open gap is sealed.
// These are the independent refutation vectors from the R1 review.
// ---------------------------------------------------------------------------

test('response candidate missing jsonrpc is T-H, not T-L (closed envelope)', () => {
  const rawFrame = '{"id":"r1","result":{"nonce":"x"}}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  const inFlight = new Map<string, InFlightEntry>([
    ['r1', { method: 'host.lifecycle.ping', requestSnapshot: { nonce: 'x' } }],
  ]);
  const result = classifyFrame(frame, inFlight);
  assert.equal(result.disposition, 'T-H', 'missing jsonrpc must not settle as T-L');
  assert.equal(result.outcome, 'close');
});

test('response candidate with extra outer member is T-H (closed envelope)', () => {
  const rawFrame = '{"jsonrpc":"2.0","id":"r1","result":{"nonce":"x"},"extra":1}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  const inFlight = new Map<string, InFlightEntry>([
    ['r1', { method: 'host.lifecycle.ping', requestSnapshot: { nonce: 'x' } }],
  ]);
  const result = classifyFrame(frame, inFlight);
  assert.equal(result.disposition, 'T-H', 'extra outer key must not settle as T-L');
  assert.equal(result.outcome, 'close');
});

test('error response with empty error body {} is T-H (missing code/message)', () => {
  const rawFrame = '{"jsonrpc":"2.0","id":"r1","error":{}}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  const inFlight = new Map<string, InFlightEntry>([
    ['r1', { method: 'host.lifecycle.ping' }],
  ]);
  const result = classifyFrame(frame, inFlight);
  assert.equal(result.disposition, 'T-H', 'error without code/message must not settle as T-L');
  assert.equal(result.outcome, 'close');
});

test('grants.changed notification with unknown capability is T-K (authorization boundary)', () => {
  const rawFrame = '{"jsonrpc":"2.0","method":"host.grants.changed","params":{"meta":{"deadlineUnixMs":1},"input":{"grantRevision":0,"effectiveGrants":["UNKNOWN_CAP"]}}}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  const result = classifyFrame(frame, NO_IN_FLIGHT);
  assert.equal(result.disposition, 'T-K', 'unknown capability must not be accepted as T-J');
  assert.equal(result.outcome, 'close');
});

test('grants.changed notification with duplicate capability is T-K (authorization boundary)', () => {
  const rawFrame = '{"jsonrpc":"2.0","method":"host.grants.changed","params":{"meta":{"deadlineUnixMs":1},"input":{"grantRevision":0,"effectiveGrants":["messaging.send","messaging.send"]}}}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  const result = classifyFrame(frame, NO_IN_FLIGHT);
  assert.equal(result.disposition, 'T-K', 'duplicate capability must not be accepted as T-J');
  assert.equal(result.outcome, 'close');
});

test('notification-only method (host.grants.changed) with id is T-F (direction gate)', () => {
  const rawFrame = '{"jsonrpc":"2.0","id":"r1","method":"host.grants.changed","params":{"meta":{"deadlineUnixMs":1},"input":{"grantRevision":0,"effectiveGrants":[]}}}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  const result = classifyFrame(frame, NO_IN_FLIGHT);
  assert.equal(result.disposition, 'T-F', 'notification-only method as request must be rejected');
  assert.equal(result.outcome, 'respond');
});

// ---------------------------------------------------------------------------
// Mutual-exclusivity proof pair (pre-existing)
// ---------------------------------------------------------------------------

test('the same raw frame classified as T-H without in-flight and T-L with in-flight', () => {
  const rawFrame =
    '{"jsonrpc":"2.0","id":"corr-test","result":{"nonce":"x"}}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };

  // Without in-flight → T-H (uncorrelated)
  const withoutInFlight = classifyFrame(frame, NO_IN_FLIGHT);
  assert.equal(withoutInFlight.disposition, 'T-H');
  assert.equal(withoutInFlight.outcome, 'close');

  // With in-flight → T-L (correlated, nonce matches)
  const inFlight = new Map<string, InFlightEntry>([
    [
      'corr-test',
      {
        method: 'host.lifecycle.ping',
        requestSnapshot: { nonce: 'x' },
      },
    ],
  ]);
  const withInFlight = classifyFrame(frame, inFlight);
  assert.equal(withInFlight.disposition, 'T-L');
  assert.equal(withInFlight.outcome, 'accept');
});
