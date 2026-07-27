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
// R2 Finding 1: Response result shape validation (fail-closed)
// ---------------------------------------------------------------------------

test('ping result:null without snapshot is T-H (null is not {nonce:string})', () => {
  const rawFrame = '{"jsonrpc":"2.0","id":"r1","result":null}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  const inFlight = new Map<string, InFlightEntry>([
    ['r1', { method: 'host.lifecycle.ping' }],
  ]);
  const result = classifyFrame(frame, inFlight);
  assert.equal(result.disposition, 'T-H', 'null result for ping must not accept');
  assert.equal(result.outcome, 'close');
});

test('ping result with extra field is T-H (closed shape)', () => {
  const rawFrame = '{"jsonrpc":"2.0","id":"r1","result":{"nonce":"x","extra":1}}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  const inFlight = new Map<string, InFlightEntry>([
    ['r1', { method: 'host.lifecycle.ping', requestSnapshot: { nonce: 'x' } }],
  ]);
  const result = classifyFrame(frame, inFlight);
  assert.equal(result.disposition, 'T-H', 'extra field in ping result must reject');
  assert.equal(result.outcome, 'close');
});

test('ack result:{} is T-H (ack result must be null)', () => {
  const rawFrame = '{"jsonrpc":"2.0","id":"r1","result":{}}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  const inFlight = new Map<string, InFlightEntry>([
    ['r1', { method: 'messaging.ack' }],
  ]);
  const result = classifyFrame(frame, inFlight);
  assert.equal(result.disposition, 'T-H', 'non-null result for ack must reject');
  assert.equal(result.outcome, 'close');
});

test('subscribe result:null is T-H (must be {subscriptionId:string})', () => {
  const rawFrame = '{"jsonrpc":"2.0","id":"r1","result":null}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  const inFlight = new Map<string, InFlightEntry>([
    ['r1', { method: 'messaging.subscribe' }],
  ]);
  const result = classifyFrame(frame, inFlight);
  assert.equal(result.disposition, 'T-H', 'null result for subscribe must reject');
  assert.equal(result.outcome, 'close');
});

test('drain result:{} is T-H (drain result must be null)', () => {
  const rawFrame = '{"jsonrpc":"2.0","id":"r1","result":{}}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  const inFlight = new Map<string, InFlightEntry>([
    ['r1', { method: 'host.lifecycle.drain' }],
  ]);
  const result = classifyFrame(frame, inFlight);
  assert.equal(result.disposition, 'T-H', 'non-null result for drain must reject');
  assert.equal(result.outcome, 'close');
});

test('error with unknown code 123 is T-H (closed error code set)', () => {
  const rawFrame = '{"jsonrpc":"2.0","id":"r1","error":{"code":123,"message":"whatever"}}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  const inFlight = new Map<string, InFlightEntry>([
    ['r1', { method: 'host.lifecycle.ping' }],
  ]);
  const result = classifyFrame(frame, inFlight);
  assert.equal(result.disposition, 'T-H', 'unknown error code must reject');
  assert.equal(result.outcome, 'close');
});

test('standard error with data field is T-H (standard errors forbid data)', () => {
  const rawFrame = '{"jsonrpc":"2.0","id":"r1","error":{"code":-32603,"message":"Internal error","data":{}}}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  const inFlight = new Map<string, InFlightEntry>([
    ['r1', { method: 'host.lifecycle.ping' }],
  ]);
  const result = classifyFrame(frame, inFlight);
  assert.equal(result.disposition, 'T-H', 'standard error with data must reject');
  assert.equal(result.outcome, 'close');
});

test('application error without data field is T-H (application errors require data)', () => {
  const rawFrame = '{"jsonrpc":"2.0","id":"r1","error":{"code":-32093,"message":"deadline expired"}}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  const inFlight = new Map<string, InFlightEntry>([
    ['r1', { method: 'host.lifecycle.ping' }],
  ]);
  const result = classifyFrame(frame, inFlight);
  assert.equal(result.disposition, 'T-H', 'application error without data must reject');
  assert.equal(result.outcome, 'close');
});

test('error with wrong code→message mapping is T-H (canonical mapping)', () => {
  const rawFrame = '{"jsonrpc":"2.0","id":"r1","error":{"code":-32603,"message":"wrong message"}}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  const inFlight = new Map<string, InFlightEntry>([
    ['r1', { method: 'host.lifecycle.ping' }],
  ]);
  const result = classifyFrame(frame, inFlight);
  assert.equal(result.disposition, 'T-H', 'wrong code→message mapping must reject');
  assert.equal(result.outcome, 'close');
});

test('valid standard error (Internal error) with in-flight is T-L', () => {
  const rawFrame = '{"jsonrpc":"2.0","id":"r1","error":{"code":-32603,"message":"Internal error"}}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  const inFlight = new Map<string, InFlightEntry>([
    ['r1', { method: 'host.lifecycle.ping' }],
  ]);
  const result = classifyFrame(frame, inFlight);
  assert.equal(result.disposition, 'T-L', 'valid standard error with in-flight must accept');
  assert.equal(result.outcome, 'accept');
});

test('valid application error (deadline_expired) with in-flight is T-L', () => {
  const rawFrame = '{"jsonrpc":"2.0","id":"r1","error":{"code":-32093,"message":"deadline expired","data":{}}}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  const inFlight = new Map<string, InFlightEntry>([
    ['r1', { method: 'host.lifecycle.ping' }],
  ]);
  const result = classifyFrame(frame, inFlight);
  assert.equal(result.disposition, 'T-L', 'valid application error with in-flight must accept');
  assert.equal(result.outcome, 'accept');
});

test('valid subscribe result {subscriptionId:"sub-1"} is T-L', () => {
  const rawFrame = '{"jsonrpc":"2.0","id":"r1","result":{"subscriptionId":"sub-1"}}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  const inFlight = new Map<string, InFlightEntry>([
    ['r1', { method: 'messaging.subscribe' }],
  ]);
  const result = classifyFrame(frame, inFlight);
  assert.equal(result.disposition, 'T-L', 'valid subscribe result must accept');
  assert.equal(result.outcome, 'accept');
});

test('valid ack result null is T-L', () => {
  const rawFrame = '{"jsonrpc":"2.0","id":"r1","result":null}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  const inFlight = new Map<string, InFlightEntry>([
    ['r1', { method: 'messaging.ack' }],
  ]);
  const result = classifyFrame(frame, inFlight);
  assert.equal(result.disposition, 'T-L', 'valid ack null result must accept');
  assert.equal(result.outcome, 'accept');
});

test('valid drain result null is T-L', () => {
  const rawFrame = '{"jsonrpc":"2.0","id":"r1","result":null}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  const inFlight = new Map<string, InFlightEntry>([
    ['r1', { method: 'host.lifecycle.drain' }],
  ]);
  const result = classifyFrame(frame, inFlight);
  assert.equal(result.disposition, 'T-L', 'valid drain null result must accept');
  assert.equal(result.outcome, 'accept');
});

// ---------------------------------------------------------------------------
// R2 Finding 2: Nested closed-shape key enforcement
// ---------------------------------------------------------------------------

test('request params with extra key beyond meta+input is T-F', () => {
  const rawFrame = '{"jsonrpc":"2.0","id":"r1","method":"host.lifecycle.ping","params":{"meta":{"deadlineUnixMs":1},"input":{"nonce":"x"},"extra":1}}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  const result = classifyFrame(frame, NO_IN_FLIGHT);
  assert.equal(result.disposition, 'T-F', 'extra params key must reject');
  assert.equal(result.outcome, 'respond');
});

test('request meta with extra key beyond deadlineUnixMs is T-G', () => {
  const rawFrame = '{"jsonrpc":"2.0","id":"r1","method":"host.lifecycle.ping","params":{"meta":{"deadlineUnixMs":1,"extra":true},"input":{"nonce":"x"}}}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  const result = classifyFrame(frame, NO_IN_FLIGHT);
  assert.equal(result.disposition, 'T-G', 'extra meta key must reject');
  assert.equal(result.outcome, 'respond');
});

test('ping input with extra key beyond nonce is T-G', () => {
  const rawFrame = '{"jsonrpc":"2.0","id":"r1","method":"host.lifecycle.ping","params":{"meta":{"deadlineUnixMs":1},"input":{"nonce":"x","extra":1}}}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  const result = classifyFrame(frame, NO_IN_FLIGHT);
  assert.equal(result.disposition, 'T-G', 'extra input key must reject');
  assert.equal(result.outcome, 'respond');
});

test('notification params with extra key is T-K', () => {
  const rawFrame = '{"jsonrpc":"2.0","method":"host.grants.changed","params":{"meta":{"deadlineUnixMs":1},"input":{"grantRevision":0,"effectiveGrants":[]},"extra":1}}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  const result = classifyFrame(frame, NO_IN_FLIGHT);
  assert.equal(result.disposition, 'T-K', 'extra notification params key must reject');
  assert.equal(result.outcome, 'close');
});

test('notification meta with extra key is T-K', () => {
  const rawFrame = '{"jsonrpc":"2.0","method":"host.grants.changed","params":{"meta":{"deadlineUnixMs":1,"extra":true},"input":{"grantRevision":0,"effectiveGrants":[]}}}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  const result = classifyFrame(frame, NO_IN_FLIGHT);
  assert.equal(result.disposition, 'T-K', 'extra notification meta key must reject');
  assert.equal(result.outcome, 'close');
});

test('notification input with extra key is T-K (grants.changed input closed)', () => {
  const rawFrame = '{"jsonrpc":"2.0","method":"host.grants.changed","params":{"meta":{"deadlineUnixMs":1},"input":{"grantRevision":0,"effectiveGrants":[],"extra":1}}}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  const result = classifyFrame(frame, NO_IN_FLIGHT);
  assert.equal(result.disposition, 'T-K', 'extra notification input key must reject');
  assert.equal(result.outcome, 'close');
});

test('error body with extra field beyond code/message is T-H (standard error)', () => {
  const rawFrame = '{"jsonrpc":"2.0","id":"r1","error":{"code":-32603,"message":"Internal error","extra":1}}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  const inFlight = new Map<string, InFlightEntry>([
    ['r1', { method: 'host.lifecycle.ping' }],
  ]);
  const result = classifyFrame(frame, inFlight);
  assert.equal(result.disposition, 'T-H', 'extra error body key must reject');
  assert.equal(result.outcome, 'close');
});

// ---------------------------------------------------------------------------
// R3 Finding 1: Per-arm application error data schema validation
// ---------------------------------------------------------------------------

test('handshake rejection with missing reason is T-H', () => {
  const rawFrame = '{"jsonrpc":"2.0","id":"r1","error":{"code":-32090,"message":"handshake rejected","data":{}}}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  const inFlight = new Map<string, InFlightEntry>([
    ['r1', { method: 'host.lifecycle.ping', requestSnapshot: { nonce: 'x' } }],
  ]);
  const result = classifyFrame(frame, inFlight);
  assert.equal(result.disposition, 'T-H', 'handshake rejection missing reason must reject');
  assert.equal(result.outcome, 'close');
});

test('handshake rejection with unknown reason is T-H', () => {
  const rawFrame = '{"jsonrpc":"2.0","id":"r1","error":{"code":-32090,"message":"handshake rejected","data":{"reason":"UNKNOWN_REASON"}}}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  const inFlight = new Map<string, InFlightEntry>([
    ['r1', { method: 'host.lifecycle.ping', requestSnapshot: { nonce: 'x' } }],
  ]);
  const result = classifyFrame(frame, inFlight);
  assert.equal(result.disposition, 'T-H', 'unknown handshake rejection reason must reject');
  assert.equal(result.outcome, 'close');
});

test('handshake rejection with extra data key is T-H', () => {
  const rawFrame = '{"jsonrpc":"2.0","id":"r1","error":{"code":-32090,"message":"handshake rejected","data":{"reason":"MALFORMED_HELLO","extra":1}}}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  const inFlight = new Map<string, InFlightEntry>([
    ['r1', { method: 'host.lifecycle.ping', requestSnapshot: { nonce: 'x' } }],
  ]);
  const result = classifyFrame(frame, inFlight);
  assert.equal(result.disposition, 'T-H', 'extra key in handshake rejection data must reject');
  assert.equal(result.outcome, 'close');
});

test('deadline_expired with non-empty data is T-H (must be Record<string,never>)', () => {
  const rawFrame = '{"jsonrpc":"2.0","id":"r1","error":{"code":-32093,"message":"deadline expired","data":{"extra":1}}}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  const inFlight = new Map<string, InFlightEntry>([
    ['r1', { method: 'host.lifecycle.ping', requestSnapshot: { nonce: 'x' } }],
  ]);
  const result = classifyFrame(frame, inFlight);
  assert.equal(result.disposition, 'T-H', 'non-empty deadline_expired data must reject');
  assert.equal(result.outcome, 'close');
});

test('domain_error with extra data key is T-H', () => {
  const rawFrame = '{"jsonrpc":"2.0","id":"r1","error":{"code":-32092,"message":"domain error","data":{"code":"VALIDATION","extra":1}}}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  const inFlight = new Map<string, InFlightEntry>([
    ['r1', { method: 'host.lifecycle.ping', requestSnapshot: { nonce: 'x' } }],
  ]);
  const result = classifyFrame(frame, inFlight);
  assert.equal(result.disposition, 'T-H', 'extra key in domain error data must reject');
  assert.equal(result.outcome, 'close');
});

test('domain_error with unknown MessagingErrorCode is T-H', () => {
  const rawFrame = '{"jsonrpc":"2.0","id":"r1","error":{"code":-32092,"message":"domain error","data":{"code":"UNKNOWN_CODE"}}}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  const inFlight = new Map<string, InFlightEntry>([
    ['r1', { method: 'host.lifecycle.ping', requestSnapshot: { nonce: 'x' } }],
  ]);
  const result = classifyFrame(frame, inFlight);
  assert.equal(result.disposition, 'T-H', 'unknown MessagingErrorCode must reject');
  assert.equal(result.outcome, 'close');
});

test('domain_error with valid MessagingErrorCode is T-L', () => {
  const rawFrame = '{"jsonrpc":"2.0","id":"r1","error":{"code":-32092,"message":"domain error","data":{"code":"VALIDATION"}}}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  const inFlight = new Map<string, InFlightEntry>([
    ['r1', { method: 'host.lifecycle.ping', requestSnapshot: { nonce: 'x' } }],
  ]);
  const result = classifyFrame(frame, inFlight);
  assert.equal(result.disposition, 'T-L', 'valid MessagingErrorCode must accept');
  assert.equal(result.outcome, 'accept');
});

test('domain_error with non-string code is T-H', () => {
  const rawFrame = '{"jsonrpc":"2.0","id":"r1","error":{"code":-32092,"message":"domain error","data":{"code":42}}}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  const inFlight = new Map<string, InFlightEntry>([
    ['r1', { method: 'host.lifecycle.ping', requestSnapshot: { nonce: 'x' } }],
  ]);
  const result = classifyFrame(frame, inFlight);
  assert.equal(result.disposition, 'T-H', 'non-string domain error code must reject');
  assert.equal(result.outcome, 'close');
});

test('snapshot_unavailable with valid reason is T-L', () => {
  const rawFrame = '{"jsonrpc":"2.0","id":"r1","error":{"code":-32094,"message":"snapshot unavailable","data":{"reason":"VIEW_EXPIRED"}}}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  const inFlight = new Map<string, InFlightEntry>([
    ['r1', { method: 'host.lifecycle.ping', requestSnapshot: { nonce: 'x' } }],
  ]);
  const result = classifyFrame(frame, inFlight);
  assert.equal(result.disposition, 'T-L', 'valid snapshot_unavailable must accept');
  assert.equal(result.outcome, 'accept');
});

test('valid handshake_rejected with known reason is T-L', () => {
  const rawFrame = '{"jsonrpc":"2.0","id":"r1","error":{"code":-32090,"message":"handshake rejected","data":{"reason":"PACKAGE_MISMATCH"}}}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  const inFlight = new Map<string, InFlightEntry>([
    ['r1', { method: 'host.lifecycle.ping', requestSnapshot: { nonce: 'x' } }],
  ]);
  const result = classifyFrame(frame, inFlight);
  assert.equal(result.disposition, 'T-L', 'valid handshake_rejected must accept');
  assert.equal(result.outcome, 'accept');
});

test('ParseError (-32700) with correlated string id is T-H (must have null id)', () => {
  const rawFrame = '{"jsonrpc":"2.0","id":"r1","error":{"code":-32700,"message":"Parse error"}}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  const inFlight = new Map<string, InFlightEntry>([
    ['r1', { method: 'host.lifecycle.ping', requestSnapshot: { nonce: 'x' } }],
  ]);
  const result = classifyFrame(frame, inFlight);
  assert.equal(result.disposition, 'T-H', 'ParseError with string id violates null-id mandate');
  assert.equal(result.outcome, 'close');
});

// ---------------------------------------------------------------------------
// R3 Finding 2: Oracle fail-closed on missing snapshot
// ---------------------------------------------------------------------------

test('ping success with valid shape but no oracle snapshot is T-H (fail-closed)', () => {
  const rawFrame = '{"jsonrpc":"2.0","id":"r1","result":{"nonce":"hello"}}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  // In-flight entry for ping WITHOUT requestSnapshot — caller bug
  const inFlight = new Map<string, InFlightEntry>([
    ['r1', { method: 'host.lifecycle.ping' }],
  ]);
  const result = classifyFrame(frame, inFlight);
  assert.equal(result.disposition, 'T-H', 'missing ping oracle snapshot must fail-closed');
  assert.equal(result.outcome, 'close');
});

test('ping success with snapshot nonce present is T-L (oracle pass)', () => {
  const rawFrame = '{"jsonrpc":"2.0","id":"r1","result":{"nonce":"hello"}}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  const inFlight = new Map<string, InFlightEntry>([
    ['r1', { method: 'host.lifecycle.ping', requestSnapshot: { nonce: 'hello' } }],
  ]);
  const result = classifyFrame(frame, inFlight);
  assert.equal(result.disposition, 'T-L', 'ping with matching nonce oracle must accept');
  assert.equal(result.outcome, 'accept');
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
