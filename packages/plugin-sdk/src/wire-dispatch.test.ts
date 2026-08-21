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
  HANDSHAKE_REJECTED_CODE,
  HANDSHAKE_REJECTED_MESSAGE,
} from '@clowder-ai/plugin-contract';

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

const HELLO_CANDIDATE = {
  pluginId: 'example.loopback',
  packageDigest: `sha512-${'A'.repeat(86)}==`,
  contractVersion: '0.1.0-beta.8',
  wireVersion: '0.1.0',
} as const;

const HELLO_BINDING = {
  ...HELLO_CANDIDATE,
  pluginInstanceId: 'instance-1',
  brokerSessionId: 'session-1',
  grantRevision: 0,
  effectiveGrants: [],
  bindingNonce: 'nonce-1',
} as const;

function helloResponseFrame(result: object): DecodedNdjsonFrame {
  const rawFrame = JSON.stringify({ jsonrpc: '2.0', id: 'hello-response', result });
  return {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
}

function helloInFlightEntry(): InFlightEntry {
  return {
    method: 'broker.hello',
    requestSnapshot: { candidateHello: HELLO_CANDIDATE },
  };
}

function frameFromValue(value: JsonObject): DecodedNdjsonFrame {
  const rawFrame = JSON.stringify(value);
  return {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
}

const M0C_DRAFT = {
  address: { kind: 'thread_handle', handle: 'thread-handle-1' },
  idempotencyKey: 'send-1',
  payload: {
    provenance: { epistemicStatus: 'inference' },
    elements: [
      { elementId: 'element-1', kind: 'text', payload: { text: 'hello' } },
    ],
  },
} as const;

const M0C_ENVELOPE = {
  messageId: 'message-1',
  revision: 1,
  threadId: 'thread-1',
  actor: { kind: 'user', id: 'user-1' },
  audience: { kind: 'public' },
  occurredAt: '2026-08-18T03:00:00.000Z',
  payload: {
    provenance: {
      origin: { kind: 'host' },
      epistemicStatus: 'user_intent',
    },
    elements: [
      { elementId: 'element-1', kind: 'text', payload: { text: 'hello' } },
    ],
  },
} as const;

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

test('valid lifecycle request reaches T-M once its row is ready', () => {
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
  assert.equal(result.disposition, 'T-M');
});

test('valid broker.hello reaches T-M once the handshake row is ready', () => {
  const rawFrame = JSON.stringify({
    jsonrpc: '2.0',
    id: 'hello-1',
    method: 'broker.hello',
    params: {
      meta: { deadlineUnixMs: 1 },
      input: {
        pluginId: 'example.loopback',
        packageDigest: `sha512-${'A'.repeat(86)}==`,
        contractVersion: '0.1.0-beta.8',
        wireVersion: '0.1.0',
      },
    },
  });
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };

  const result = classifyFrame(frame, NO_IN_FLIGHT);
  assert.equal(result.disposition, 'T-M');
  assert.equal(result.outcome, 'accept');
  assert.equal(result.response, undefined);
});

test('valid events.publish reaches T-M while authority-bearing input is T-G', () => {
  const input = {
    signalType: 'feishu.meeting_artifact.generated.v1',
    eventId: 'feishu-minute-om_abc123-v7',
    idempotencyKey: 'feishu:minute:om_abc123:7',
    occurredAt: '2026-08-09T04:12:31Z',
    payload: { artifactId: 'om_abc123', revision: '7' },
    source: { handle: 'feishu://minutes/om_abc123?revision=7' },
  };

  for (const [candidate, expected] of [
    [input, 'T-M'],
    [{ ...input, destination: { threadId: 'thread-1' } }, 'T-G'],
  ] as const) {
    const rawFrame = JSON.stringify({
      jsonrpc: '2.0',
      id: 'publish-1',
      method: 'events.publish',
      params: { meta: { deadlineUnixMs: 1 }, input: candidate },
    });
    const result = classifyFrame({
      raw: Buffer.from(rawFrame, 'utf8'),
      value: JSON.parse(rawFrame) as JsonObject,
    }, NO_IN_FLIGHT);

    assert.equal(result.disposition, expected);
    assert.equal(result.outcome, expected === 'T-M' ? 'accept' : 'respond');
  }
});

test('events.publish accepts only closed Host receipts and standard errors', () => {
  const inFlight = new Map<string, InFlightEntry>([
    ['publish-1', { method: 'events.publish' }],
  ]);

  for (const [settlement, disposition] of [
    [{ result: { publicationId: 'publication-1', disposition: 'accepted' } }, 'T-L'],
    [{ result: { publicationId: 'publication-1', disposition: 'accepted', destination: 'thread-1' } }, 'T-H'],
    [{ error: { code: -32602, message: 'Invalid params' } }, 'T-L'],
    [{ error: { code: -32093, message: 'deadline expired', data: {} } }, 'T-H'],
  ] as const) {
    const rawFrame = JSON.stringify({ jsonrpc: '2.0', id: 'publish-1', ...settlement });
    const result = classifyFrame({
      raw: Buffer.from(rawFrame, 'utf8'),
      value: JSON.parse(rawFrame) as JsonObject,
    }, inFlight);
    assert.equal(result.disposition, disposition);
    assert.equal(result.outcome, disposition === 'T-L' ? 'accept' : 'close');
  }
});

test('Host-owned fields injected into either handshake request are authority violations', () => {
  const authorityFields = [
    ['pluginInstanceId', 'instance-1'],
    ['brokerSessionId', 'session-1'],
    ['grantRevision', 1],
    ['effectiveGrants', []],
  ] as const;

  for (const [field, injected] of authorityFields) {
    for (const [method, input] of [
      ['broker.hello', { ...HELLO_CANDIDATE, [field]: injected }],
      ['broker.ready', { bindingNonce: 'nonce-1', [field]: injected }],
    ] as const) {
      const rawFrame = JSON.stringify({
        jsonrpc: '2.0',
        id: 'a',
        method,
        params: { meta: { deadlineUnixMs: 1 }, input },
      });
      const result = classifyFrame({
        raw: Buffer.from(rawFrame, 'utf8'),
        value: JSON.parse(rawFrame) as JsonObject,
      }, NO_IN_FLIGHT);

      assert.equal(result.disposition, 'T-G', `${method}.${field} must remain a value-level rejection`);
      assert.deepEqual(result.response, {
        jsonrpc: '2.0',
        id: 'a',
        error: {
          code: HANDSHAKE_REJECTED_CODE,
          message: HANDSHAKE_REJECTED_MESSAGE,
          data: { reason: 'AUTHORITY_VIOLATION' },
        },
      }, `${method}.${field} must return HANDSHAKE_REJECTED/AUTHORITY_VIOLATION`);
    }
  }
});

test('non-canonical injected grantRevision remains a handshake authority violation', () => {
  for (const grantRevision of [-1, 1.5]) {
    for (const [method, input] of [
      ['broker.hello', { ...HELLO_CANDIDATE, grantRevision }],
      ['broker.ready', { bindingNonce: 'nonce-1', grantRevision }],
    ] as const) {
      const rawFrame = JSON.stringify({
        jsonrpc: '2.0',
        id: 'authority-injection',
        method,
        params: { meta: { deadlineUnixMs: 1 }, input },
      });
      const result = classifyFrame(
        {
          raw: Buffer.from(rawFrame, 'utf8'),
          value: JSON.parse(rawFrame) as JsonObject,
        },
        NO_IN_FLIGHT,
      );

      assert.equal(result.disposition, 'T-G', `${method}.${grantRevision} must reach the authority gate`);
      assert.deepEqual(result.response, {
        jsonrpc: '2.0',
        id: 'authority-injection',
        error: {
          code: HANDSHAKE_REJECTED_CODE,
          message: HANDSHAKE_REJECTED_MESSAGE,
          data: { reason: 'AUTHORITY_VIOLATION' },
        },
      });
    }
  }
});

test('broker.hello SessionBinding is T-L only when it echoes the in-flight candidate', () => {
  const inFlight = new Map<string, InFlightEntry>([
    ['hello-response', helloInFlightEntry()],
  ]);

  const positive = classifyFrame(helloResponseFrame(HELLO_BINDING), inFlight);
  assert.equal(positive.disposition, 'T-L');
  assert.equal(positive.outcome, 'accept');

  const mismatches: ReadonlyArray<readonly [keyof typeof HELLO_CANDIDATE, string]> = [
    ['pluginId', 'different.plugin'],
    ['packageDigest', `sha512-${'B'.repeat(86)}==`],
    ['contractVersion', '0.1.0-beta.9'],
    ['wireVersion', '0.2.0'],
  ];

  for (const [field, value] of mismatches) {
    const result = classifyFrame(
      helloResponseFrame({ ...HELLO_BINDING, [field]: value }),
      inFlight,
    );
    assert.equal(result.disposition, 'T-H', `${field} mismatch must close before T-L`);
    assert.equal(result.outcome, 'close');
  }
});

test('broker.hello non-canonical H7 raw integers close at T-C before response validation', () => {
  const inFlight = new Map<string, InFlightEntry>([
    ['hello-response', helloInFlightEntry()],
  ]);

  for (const grantRevision of [-1, 1.5]) {
    const result = classifyFrame(
      helloResponseFrame({ ...HELLO_BINDING, grantRevision }),
      inFlight,
    );
    assert.equal(result.disposition, 'T-C', `${grantRevision} must fail raw WireUInt53 canonicality`);
    assert.equal(result.outcome, 'close');
  }
});

test('non-hello result grantRevision is validated at T-H, not treated as H7', () => {
  for (const [id, method] of [
    ['ready-response', 'broker.ready'],
    ['ping-response', 'host.lifecycle.ping'],
  ] as const) {
    const rawFrame = JSON.stringify({
      jsonrpc: '2.0',
      id,
      result: { grantRevision: -1 },
    });
    const result = classifyFrame(
      {
        raw: Buffer.from(rawFrame, 'utf8'),
        value: JSON.parse(rawFrame) as JsonObject,
      },
      new Map<string, InFlightEntry>([[id, { method }]]),
    );
    assert.equal(result.disposition, 'T-H', `${method} must use its own result grammar`);
    assert.equal(result.outcome, 'close');
  }
});

test('method-bearing frame with a hello id does not apply the H7 result gate', () => {
  const rawFrame = JSON.stringify({
    jsonrpc: '2.0',
    id: 'hello-response',
    method: 'host.lifecycle.ping',
    params: {
      meta: { deadlineUnixMs: 1 },
      input: { nonce: 'hello' },
    },
    result: { grantRevision: -1 },
  });
  const result = classifyFrame(
    {
      raw: Buffer.from(rawFrame, 'utf8'),
      value: JSON.parse(rawFrame) as JsonObject,
    },
    new Map<string, InFlightEntry>([
      ['hello-response', helloInFlightEntry()],
    ]),
  );

  assert.equal(result.disposition, 'T-F');
  assert.equal(result.outcome, 'respond');
});

test('WireUInt53 input gates are scoped to their owning methods', () => {
  const requestRaw = JSON.stringify({
    jsonrpc: '2.0',
    id: 'ping-with-foreign-leaf',
    method: 'host.lifecycle.ping',
    params: {
      meta: { deadlineUnixMs: 1 },
      input: { nonce: 'hello', deadlineUnixMs: -1 },
    },
  });
  const requestResult = classifyFrame(
    {
      raw: Buffer.from(requestRaw, 'utf8'),
      value: JSON.parse(requestRaw) as JsonObject,
    },
    NO_IN_FLIGHT,
  );
  assert.equal(requestResult.disposition, 'T-G');
  assert.equal(requestResult.outcome, 'respond');

  const responseRaw = JSON.stringify({
    jsonrpc: '2.0',
    id: 'ping-response',
    params: { meta: { deadlineUnixMs: -1 } },
    result: { nonce: 'hello' },
  });
  const responseResult = classifyFrame(
    {
      raw: Buffer.from(responseRaw, 'utf8'),
      value: JSON.parse(responseRaw) as JsonObject,
    },
    new Map<string, InFlightEntry>([
      ['ping-response', { method: 'host.lifecycle.ping' }],
    ]),
  );
  assert.equal(responseResult.disposition, 'T-H');
  assert.equal(responseResult.outcome, 'close');
});

test('broker.hello SessionBinding without a candidate snapshot fails closed', () => {
  const inFlight = new Map<string, InFlightEntry>([
    ['hello-response', { method: 'broker.hello' }],
  ]);

  const result = classifyFrame(helloResponseFrame(HELLO_BINDING), inFlight);
  assert.equal(result.disposition, 'T-H');
  assert.equal(result.outcome, 'close');
});

test('ready messaging.send with malformed input is T-G', () => {
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
  assert.equal(result.disposition, 'T-G');
  assert.equal(result.outcome, 'respond');
  assert.ok(result.response !== undefined);
});

// ---------------------------------------------------------------------------
// Ready standalone requests reach the dispatch boundary in either direction.
// ---------------------------------------------------------------------------

test('ready messaging.subscribe with valid input is T-M', () => {
  const rawFrame = '{"jsonrpc":"2.0","id":"s1","method":"messaging.subscribe","params":{"meta":{"deadlineUnixMs":1},"input":{"handle":"chan"}}}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  const result = classifyFrame(frame, NO_IN_FLIGHT);
  assert.equal(result.disposition, 'T-M');
  assert.equal(result.outcome, 'accept');
});

test('ready messaging.ack with valid input is T-M', () => {
  const rawFrame = '{"jsonrpc":"2.0","id":"a1","method":"messaging.ack","params":{"meta":{"deadlineUnixMs":1},"input":{"subscriptionId":"sub-1","ackToken":"tok-1"}}}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  const result = classifyFrame(frame, NO_IN_FLIGHT);
  assert.equal(result.disposition, 'T-M');
  assert.equal(result.outcome, 'accept');
});

// ---------------------------------------------------------------------------
// T-C canonicality: non-scalar strings (lone surrogates)
// (codex R1 P2 — JSON.stringify roundtrips surrogates, byte-equality passes)
// ---------------------------------------------------------------------------

test('frame with lone high surrogate in string value is T-C (non-scalar string)', () => {
  // \ud800 is a lone high surrogate — not a valid Unicode scalar value.
  // JSON.parse produces U+D800, JSON.stringify escapes it back to \ud800,
  // so byte-equality passes. The non-scalar string check catches it.
  const rawFrame = '{"jsonrpc":"2.0","id":"r1","method":"host.lifecycle.ping","params":{"meta":{"deadlineUnixMs":1},"input":{"nonce":"\\ud800"}}}';
  const parsed = JSON.parse(rawFrame) as JsonObject;
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: parsed,
  };
  const result = classifyFrame(frame, NO_IN_FLIGHT);
  assert.equal(result.disposition, 'T-C', 'lone surrogate must be rejected as non-scalar string');
  assert.equal(result.outcome, 'close');
});

test('frame with lone low surrogate in object key is T-C (non-scalar string)', () => {
  const rawFrame = '{"jsonrpc":"2.0","\\udcba":"extra"}';
  const parsed = JSON.parse(rawFrame) as JsonObject;
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: parsed,
  };
  const result = classifyFrame(frame, NO_IN_FLIGHT);
  assert.equal(result.disposition, 'T-C', 'lone surrogate in key must be rejected');
  assert.equal(result.outcome, 'close');
});

// ---------------------------------------------------------------------------
// T-C canonicality: BOM-prefixed frame
// (codex R2 P2-1 — TextDecoder default strips BOM, byte-equality passes)
// ---------------------------------------------------------------------------

test('frame with UTF-8 BOM prefix is T-C (BOM is non-canonical)', () => {
  // UTF-8 BOM (EF BB BF) is stripped by TextDecoder default (ignoreBOM:false).
  // With ignoreBOM:true the BOM stays in rawStr, causing byte mismatch → T-C.
  const json = '{"jsonrpc":"2.0","id":"a","method":"host.lifecycle.ping","params":{"meta":{"deadlineUnixMs":1},"input":{"nonce":"x"}}}';
  const bomBytes = new Uint8Array([0xEF, 0xBB, 0xBF, ...Buffer.from(json)]);
  const frame: DecodedNdjsonFrame = {
    raw: bomBytes,
    value: JSON.parse(json) as JsonObject,
  };
  const result = classifyFrame(frame, NO_IN_FLIGHT);
  assert.equal(result.disposition, 'T-C', 'BOM-prefixed frame must be T-C');
  assert.equal(result.outcome, 'close');
});

// ---------------------------------------------------------------------------
// T-C canonicality: exponent-form numbers
// (codex R2 P2-2 — V8 JSON.stringify(1e+21) → "1e+21", byte-equality passes)
// ---------------------------------------------------------------------------

test('frame with V8-canonical exponent-form number at WireUInt53 position is T-C', () => {
  // 1e+21 ≥ 10^21, so V8's JSON.stringify uses exponent notation "1e+21".
  // Byte-equality passes because both raw and canonical have the same form.
  // hasNonCanonicalUInt53Token catches it — at the meta.deadlineUnixMs
  // WireUInt53 position, isCanonicalUInt53Token("1e+21") is false because
  // exponent form violates the raw decimal-digit-only profile.
  const json = '{"jsonrpc":"2.0","id":"a","method":"host.lifecycle.ping","params":{"meta":{"deadlineUnixMs":1e+21},"input":{"nonce":"x"}}}';
  const parsed = JSON.parse(json) as JsonObject;
  // Sanity: byte-equality would pass without the WireUInt53 position check
  assert.equal(json, JSON.stringify(parsed), 'exponent form roundtrips through JSON');
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(json, 'utf8'),
    value: parsed,
  };
  const result = classifyFrame(frame, NO_IN_FLIGHT);
  assert.equal(result.disposition, 'T-C', 'exponent-form number at WireUInt53 position must be T-C');
  assert.equal(result.outcome, 'close');
});

test('frame with non-V8-canonical exponent form is already T-C via byte-equality', () => {
  // 1e3 → JSON.parse → 1000 → JSON.stringify → "1000" (not "1e3").
  // Byte-equality catches this without needing the exponent check.
  const json = '{"jsonrpc":"2.0","id":"a","method":"host.lifecycle.ping","params":{"meta":{"deadlineUnixMs":1e3},"input":{"nonce":"x"}}}';
  const parsed = JSON.parse(json) as JsonObject;
  assert.notEqual(json, JSON.stringify(parsed), 'non-V8-canonical exponent does not roundtrip');
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(json, 'utf8'),
    value: parsed,
  };
  const result = classifyFrame(frame, NO_IN_FLIGHT);
  assert.equal(result.disposition, 'T-C', 'non-canonical exponent is T-C via byte-equality');
  assert.equal(result.outcome, 'close');
});

// ---------------------------------------------------------------------------
// T-C canonicality: deeply nested frame → stack overflow guard
// (codex R3 P2-2 — JSON.stringify is recursive, V8 JSON.parse is iterative)
// ---------------------------------------------------------------------------

test('deeply nested canonical frame is T-C, not a thrown exception', () => {
  // Build a deeply nested canonical JSON string that V8's iterative
  // JSON.parse handles but recursive JSON.stringify overflows on.
  const depth = 10_000;
  const prefix = '{"a":'.repeat(depth);
  const core = '{"x":1}';
  const suffix = '}'.repeat(depth);
  const json = prefix + core + suffix;
  const parsed = JSON.parse(json) as JsonObject;
  // Sanity: JSON.stringify throws for this depth
  assert.throws(() => JSON.stringify(parsed), RangeError, 'stringify must overflow');
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(json, 'utf8'),
    value: parsed,
  };
  // classifyFrame must NOT throw — it must return T-C close
  const result = classifyFrame(frame, NO_IN_FLIGHT);
  assert.equal(result.disposition, 'T-C', 'deep nesting must be T-C, not thrown');
  assert.equal(result.outcome, 'close');
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

test('valid application error (deadline_expired) on messaging.ack is T-L', () => {
  const rawFrame = '{"jsonrpc":"2.0","id":"r1","error":{"code":-32093,"message":"deadline expired","data":{}}}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  // Use messaging.ack (CLOSED row 7) — allows deadline_expired.
  // Ping (row 11) is standard-only per P1-2.
  const inFlight = new Map<string, InFlightEntry>([
    ['r1', { method: 'messaging.ack' }],
  ]);
  const result = classifyFrame(frame, inFlight);
  assert.equal(result.disposition, 'T-L', 'valid application error on allowed method must accept');
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

test('handshake rejection with missing reason is T-H (data validation)', () => {
  const rawFrame = '{"jsonrpc":"2.0","id":"r1","error":{"code":-32090,"message":"handshake rejected","data":{}}}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  // broker.hello (ready) — data validation rejects missing reason
  // before the per-method check would also reject it.
  const inFlight = new Map<string, InFlightEntry>([
    ['r1', { method: 'broker.hello' }],
  ]);
  const result = classifyFrame(frame, inFlight);
  assert.equal(result.disposition, 'T-H', 'handshake rejection missing reason must reject');
  assert.equal(result.outcome, 'close');
});

test('handshake rejection with unknown reason is T-H (data validation)', () => {
  const rawFrame = '{"jsonrpc":"2.0","id":"r1","error":{"code":-32090,"message":"handshake rejected","data":{"reason":"UNKNOWN_REASON"}}}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  const inFlight = new Map<string, InFlightEntry>([
    ['r1', { method: 'broker.hello' }],
  ]);
  const result = classifyFrame(frame, inFlight);
  assert.equal(result.disposition, 'T-H', 'unknown handshake rejection reason must reject');
  assert.equal(result.outcome, 'close');
});

test('handshake rejection with extra data key is T-H (data validation)', () => {
  const rawFrame = '{"jsonrpc":"2.0","id":"r1","error":{"code":-32090,"message":"handshake rejected","data":{"reason":"MALFORMED_HELLO","extra":1}}}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  const inFlight = new Map<string, InFlightEntry>([
    ['r1', { method: 'broker.hello' }],
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
  // Use messaging.ack (allows deadline_expired) to exercise DATA validation
  const inFlight = new Map<string, InFlightEntry>([
    ['r1', { method: 'messaging.ack' }],
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
  // Use messaging.subscribe (allows domain_error) to exercise DATA validation
  const inFlight = new Map<string, InFlightEntry>([
    ['r1', { method: 'messaging.subscribe' }],
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
  // Use messaging.subscribe (allows domain_error) to exercise DATA validation
  const inFlight = new Map<string, InFlightEntry>([
    ['r1', { method: 'messaging.subscribe' }],
  ]);
  const result = classifyFrame(frame, inFlight);
  assert.equal(result.disposition, 'T-H', 'unknown MessagingErrorCode must reject');
  assert.equal(result.outcome, 'close');
});

test('domain_error with valid MessagingErrorCode on messaging.subscribe is T-L', () => {
  const rawFrame = '{"jsonrpc":"2.0","id":"r1","error":{"code":-32092,"message":"domain error","data":{"code":"VALIDATION"}}}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  // Use messaging.subscribe (CLOSED row 5) — allows domain_error.
  const inFlight = new Map<string, InFlightEntry>([
    ['r1', { method: 'messaging.subscribe' }],
  ]);
  const result = classifyFrame(frame, inFlight);
  assert.equal(result.disposition, 'T-L', 'valid MessagingErrorCode on allowed method must accept');
  assert.equal(result.outcome, 'accept');
});

test('domain_error with non-string code is T-H', () => {
  const rawFrame = '{"jsonrpc":"2.0","id":"r1","error":{"code":-32092,"message":"domain error","data":{"code":42}}}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  // Use messaging.subscribe (allows domain_error) to exercise DATA validation
  const inFlight = new Map<string, InFlightEntry>([
    ['r1', { method: 'messaging.subscribe' }],
  ]);
  const result = classifyFrame(frame, inFlight);
  assert.equal(result.disposition, 'T-H', 'non-string domain error code must reject');
  assert.equal(result.outcome, 'close');
});

test('snapshot_unavailable with valid reason on messaging.snapshot is T-L', () => {
  const rawFrame = '{"jsonrpc":"2.0","id":"r1","error":{"code":-32094,"message":"snapshot unavailable","data":{"reason":"VIEW_EXPIRED"}}}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  // Row 8 (messaging.snapshot) allows snapshot_unavailable per the frozen error table.
  const inFlight = new Map<string, InFlightEntry>([
    ['r1', { method: 'messaging.snapshot' }],
  ]);
  const result = classifyFrame(frame, inFlight);
  assert.equal(result.disposition, 'T-L', 'snapshot_unavailable on messaging.snapshot must accept');
  assert.equal(result.outcome, 'accept');
});

test('valid handshake_rejected on ping is T-H (per-method error restriction, maintainer RED)', () => {
  // Maintainer P1-2 RED: ping (row 11) permits standard errors only.
  // HANDSHAKE_REJECTED belongs to the ready handshake rows 1-2 — not row 11.
  const rawFrame = '{"jsonrpc":"2.0","id":"r1","error":{"code":-32090,"message":"handshake rejected","data":{"reason":"PACKAGE_MISMATCH"}}}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  const inFlight = new Map<string, InFlightEntry>([
    ['r1', { method: 'host.lifecycle.ping', requestSnapshot: { nonce: 'x' } }],
  ]);
  const result = classifyFrame(frame, inFlight);
  assert.equal(result.disposition, 'T-H', 'handshake_rejected on ping must reject (per-method)');
  assert.equal(result.outcome, 'close');
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

// ---------------------------------------------------------------------------
// Row 9 (deliver) oracle fail-closed regression (Sol R4 F1)
// ---------------------------------------------------------------------------

test('deliver response with missing snapshot is T-H (fail-closed)', () => {
  const rawFrame = '{"jsonrpc":"2.0","id":"d1","result":{"deliveryId":"abc"}}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  // In-flight entry for deliver with NO requestSnapshot
  const inFlight = new Map<string, InFlightEntry>([
    ['d1', { method: 'host.messaging.deliver' }],
  ]);
  const result = classifyFrame(frame, inFlight);
  assert.equal(result.disposition, 'T-H', 'missing deliver snapshot must fail-closed');
  assert.equal(result.outcome, 'close');
});

test('deliver response with empty snapshot (no deliveryId) is T-H (fail-closed)', () => {
  const rawFrame = '{"jsonrpc":"2.0","id":"d2","result":{"deliveryId":"abc"}}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  // In-flight entry for deliver with snapshot but no deliveryId field
  const inFlight = new Map<string, InFlightEntry>([
    ['d2', { method: 'host.messaging.deliver', requestSnapshot: {} }],
  ]);
  const result = classifyFrame(frame, inFlight);
  assert.equal(result.disposition, 'T-H', 'empty deliver snapshot must fail-closed');
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

// ---------------------------------------------------------------------------
// P1-1: WireUInt53 raw-token grammar at T-C
// (maintainer requirement — non-canonical numeric tokens at WireUInt53
// positions must be T-C/close, not deferred to T-G/T-K)
// ---------------------------------------------------------------------------

test('request with deadlineUnixMs:-1 is T-C (negative token violates WireUInt53 grammar)', () => {
  // -1 passes byte-equality (JSON.stringify(-1) = "-1") but violates
  // the WireUInt53 raw grammar 0|[1-9][0-9]{0,15} — no sign allowed.
  const rawFrame = '{"jsonrpc":"2.0","id":"r1","method":"host.lifecycle.ping","params":{"meta":{"deadlineUnixMs":-1},"input":{"nonce":"x"}}}';
  const parsed = JSON.parse(rawFrame) as JsonObject;
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: parsed,
  };
  const result = classifyFrame(frame, NO_IN_FLIGHT);
  assert.equal(result.disposition, 'T-C', 'negative deadlineUnixMs must be T-C');
  assert.equal(result.outcome, 'close');
});

test('request with deadlineUnixMs:1.5 is T-C (fractional token violates WireUInt53 grammar)', () => {
  // 1.5 passes byte-equality but violates WireUInt53 — no decimal allowed.
  const rawFrame = '{"jsonrpc":"2.0","id":"r1","method":"host.lifecycle.ping","params":{"meta":{"deadlineUnixMs":1.5},"input":{"nonce":"x"}}}';
  const parsed = JSON.parse(rawFrame) as JsonObject;
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: parsed,
  };
  const result = classifyFrame(frame, NO_IN_FLIGHT);
  assert.equal(result.disposition, 'T-C', 'fractional deadlineUnixMs must be T-C');
  assert.equal(result.outcome, 'close');
});

test('notification with grantRevision:-1 is T-C (negative token at WireUInt53 position)', () => {
  const rawFrame = '{"jsonrpc":"2.0","method":"host.grants.changed","params":{"meta":{"deadlineUnixMs":1},"input":{"grantRevision":-1,"effectiveGrants":[]}}}';
  const parsed = JSON.parse(rawFrame) as JsonObject;
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: parsed,
  };
  const result = classifyFrame(frame, NO_IN_FLIGHT);
  assert.equal(result.disposition, 'T-C', 'negative grantRevision must be T-C');
  assert.equal(result.outcome, 'close');
});

test('notification with deadlineUnixMs:0.5 is T-C (fractional meta token)', () => {
  const rawFrame = '{"jsonrpc":"2.0","method":"host.grants.changed","params":{"meta":{"deadlineUnixMs":0.5},"input":{"grantRevision":0,"effectiveGrants":[]}}}';
  const parsed = JSON.parse(rawFrame) as JsonObject;
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: parsed,
  };
  const result = classifyFrame(frame, NO_IN_FLIGHT);
  assert.equal(result.disposition, 'T-C', 'fractional notification deadlineUnixMs must be T-C');
  assert.equal(result.outcome, 'close');
});

test('drain input with deadlineUnixMs:-100 is T-C (negative drain deadline)', () => {
  const rawFrame = '{"jsonrpc":"2.0","id":"r1","method":"host.lifecycle.drain","params":{"meta":{"deadlineUnixMs":1},"input":{"deadlineUnixMs":-100}}}';
  const parsed = JSON.parse(rawFrame) as JsonObject;
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: parsed,
  };
  const result = classifyFrame(frame, NO_IN_FLIGHT);
  assert.equal(result.disposition, 'T-C', 'negative drain input deadline must be T-C');
  assert.equal(result.outcome, 'close');
});

// ---------------------------------------------------------------------------
// P1-2: Per-method error code restriction
// (maintainer requirement — application errors only allowed on their
// designated rows, standard-only rows reject application errors)
// ---------------------------------------------------------------------------

test('drain response with deadline_expired is T-L (row 12 allows deadline)', () => {
  // Maintainer probe: drain + canonical DEADLINE_EXPIRED must be T-L.
  const rawFrame = '{"jsonrpc":"2.0","id":"r1","error":{"code":-32093,"message":"deadline expired","data":{}}}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  const inFlight = new Map<string, InFlightEntry>([
    ['r1', { method: 'host.lifecycle.drain' }],
  ]);
  const result = classifyFrame(frame, inFlight);
  assert.equal(result.disposition, 'T-L', 'deadline_expired on drain must accept');
  assert.equal(result.outcome, 'accept');
});

test('deliver response with delivery_rejected is T-L (row 9 allows it)', () => {
  // Maintainer probe: deliver + canonical DELIVERY_REJECTED must be T-L.
  const rawFrame = '{"jsonrpc":"2.0","id":"d1","error":{"code":-32091,"message":"delivery rejected","data":{"reason":"PLUGIN_BUSY"}}}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  const inFlight = new Map<string, InFlightEntry>([
    ['d1', { method: 'host.messaging.deliver', requestSnapshot: { deliveryId: 'abc' } }],
  ]);
  const result = classifyFrame(frame, inFlight);
  assert.equal(result.disposition, 'T-L', 'delivery_rejected on deliver must accept');
  assert.equal(result.outcome, 'accept');
});

test('drain response with handshake_rejected is T-H (wrong-row error)', () => {
  // Negative: HANDSHAKE_REJECTED only allowed on rows 1-2, not row 12.
  const rawFrame = '{"jsonrpc":"2.0","id":"r1","error":{"code":-32090,"message":"handshake rejected","data":{"reason":"MALFORMED_HELLO"}}}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  const inFlight = new Map<string, InFlightEntry>([
    ['r1', { method: 'host.lifecycle.drain' }],
  ]);
  const result = classifyFrame(frame, inFlight);
  assert.equal(result.disposition, 'T-H', 'handshake_rejected on drain must reject');
  assert.equal(result.outcome, 'close');
});

test('deliver response with domain_error is T-H (wrong-row error)', () => {
  // Negative: DOMAIN_ERROR not allowed on row 9 (only DELIVERY_REJECTED).
  const rawFrame = '{"jsonrpc":"2.0","id":"d1","error":{"code":-32092,"message":"domain error","data":{"code":"VALIDATION"}}}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  const inFlight = new Map<string, InFlightEntry>([
    ['d1', { method: 'host.messaging.deliver', requestSnapshot: { deliveryId: 'abc' } }],
  ]);
  const result = classifyFrame(frame, inFlight);
  assert.equal(result.disposition, 'T-H', 'domain_error on deliver must reject');
  assert.equal(result.outcome, 'close');
});

test('snapshot_unavailable on ping is T-H (wrong-row error, standard-only)', () => {
  const rawFrame = '{"jsonrpc":"2.0","id":"r1","error":{"code":-32094,"message":"snapshot unavailable","data":{"reason":"VIEW_EXPIRED"}}}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  const inFlight = new Map<string, InFlightEntry>([
    ['r1', { method: 'host.lifecycle.ping' }],
  ]);
  const result = classifyFrame(frame, inFlight);
  assert.equal(result.disposition, 'T-H', 'snapshot_unavailable on ping must reject');
  assert.equal(result.outcome, 'close');
});

test('ping response with deadline_expired is T-H (row 11 standard-only)', () => {
  // Ping (row 11) permits standard errors only (maintainer-confirmed).
  // deadline_expired is an application error → per-method rejection.
  const rawFrame = '{"jsonrpc":"2.0","id":"r1","error":{"code":-32093,"message":"deadline expired","data":{}}}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  const inFlight = new Map<string, InFlightEntry>([
    ['r1', { method: 'host.lifecycle.ping' }],
  ]);
  const result = classifyFrame(frame, inFlight);
  assert.equal(result.disposition, 'T-H', 'application error on standard-only row must reject');
  assert.equal(result.outcome, 'close');
});

test('drain response with domain_error is T-H (row 12 standard-only)', () => {
  const rawFrame = '{"jsonrpc":"2.0","id":"r1","error":{"code":-32092,"message":"domain error","data":{"code":"VALIDATION"}}}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  const inFlight = new Map<string, InFlightEntry>([
    ['r1', { method: 'host.lifecycle.drain' }],
  ]);
  const result = classifyFrame(frame, inFlight);
  assert.equal(result.disposition, 'T-H', 'application error on drain must reject');
  assert.equal(result.outcome, 'close');
});

test('broker.hello response with valid handshake_rejected is T-L (row 1 allows it)', () => {
  // Rows 1-2 allow HANDSHAKE_REJECTED per the frozen per-row error table.
  // Error eligibility is keyed off the row, not leafClosure.
  const rawFrame = '{"jsonrpc":"2.0","id":"r1","error":{"code":-32090,"message":"handshake rejected","data":{"reason":"PACKAGE_MISMATCH"}}}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  const inFlight = new Map<string, InFlightEntry>([
    ['r1', { method: 'broker.hello' }],
  ]);
  const result = classifyFrame(frame, inFlight);
  assert.equal(result.disposition, 'T-L', 'handshake_rejected on broker.hello must accept');
  assert.equal(result.outcome, 'accept');
});

test('ready broker.hello row accepts a correlated standard error as T-L', () => {
  const rawFrame = '{"jsonrpc":"2.0","id":"r1","error":{"code":-32603,"message":"Internal error"}}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  const inFlight = new Map<string, InFlightEntry>([
    ['r1', { method: 'broker.hello' }],
  ]);
  const result = classifyFrame(frame, inFlight);
  assert.equal(result.disposition, 'T-L', 'standard error on broker.hello must accept');
  assert.equal(result.outcome, 'accept');
});

// ---------------------------------------------------------------------------
// P1-2: closed result validation remains fail-closed
// (maintainer requirement — no unvalidated result may reach T-L)
// ---------------------------------------------------------------------------

test('broker.hello response with result:null is T-H (closed result shape rejects null)', () => {
  // The beta.8 CLOSED broker.hello result is SessionBinding, never null.
  const rawFrame = '{"jsonrpc":"2.0","id":"r1","result":null}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  const inFlight = new Map<string, InFlightEntry>([
    ['r1', { method: 'broker.hello' }],
  ]);
  const result = classifyFrame(frame, inFlight);
  assert.equal(result.disposition, 'T-H', 'broker.hello null result must fail-closed');
  assert.equal(result.outcome, 'close');
});

test('messaging.send response with result:{} is T-H (closed result validation)', () => {
  const rawFrame = '{"jsonrpc":"2.0","id":"r1","result":{}}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  const inFlight = new Map<string, InFlightEntry>([
    ['r1', { method: 'messaging.send' }],
  ]);
  const result = classifyFrame(frame, inFlight);
  assert.equal(result.disposition, 'T-H', 'malformed send result must fail-closed');
  assert.equal(result.outcome, 'close');
});

test('messaging.send legacy receipt handle is T-H after messageHandle closure', () => {
  const rawFrame =
    '{"jsonrpc":"2.0","id":"r1","result":{"messageId":"message-1","threadId":"thread-1","revision":1,"handle":{"kind":"message","token":"host-issued-message-handle"}}}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  const inFlight = new Map<string, InFlightEntry>([
    ['r1', { method: 'messaging.send' }],
  ]);
  const result = classifyFrame(frame, inFlight);
  assert.equal(result.disposition, 'T-H', 'legacy handle field must fail-closed');
  assert.equal(result.outcome, 'close');
});

test('M0-C valid requests reach T-M and malformed requests reach T-G', () => {
  const cases = [
    ['messaging.send', M0C_DRAFT, { ...M0C_DRAFT, authority: 'host' }],
    [
      'messaging.appendElements',
      {
        handle: { kind: 'message', token: 'message-handle-1' },
        operationId: 'append-1',
        baseRevision: 1,
        elements: [
          { elementId: 'element-2', kind: 'text', payload: { text: 'more' } },
        ],
      },
      { handle: 'raw-handle', operationId: 'append-1', elements: [] },
    ],
    ['messaging.subscribe', { handle: 'thread-handle-1' }, { handle: '' }],
    [
      'messaging.read',
      { subscriptionId: 'subscription-1', limit: 2 },
      { subscriptionId: 'subscription-1', limit: 33 },
    ],
    [
      'messaging.ack',
      { subscriptionId: 'subscription-1', ackToken: 'ack-1' },
      { subscriptionId: 'subscription-1', ackToken: '' },
    ],
    [
      'messaging.snapshot',
      { subscriptionId: 'subscription-1', maxItems: 2 },
      { subscriptionId: 'subscription-1', maxItems: 0 },
    ],
    [
      'host.messaging.deliver',
      {
        deliveryId: 'delivery-1',
        threadHandle: { kind: 'thread_handle', handle: 'thread-handle-1' },
        envelope: M0C_ENVELOPE,
      },
      {
        deliveryId: 'delivery-1',
        threadHandle: { kind: 'thread_handle', handle: 'thread-handle-1' },
        envelope: { ...M0C_ENVELOPE, occurredAt: '2026-08-18T03:00:00Z' },
      },
    ],
  ] as const;

  for (const [method, validInput, malformedInput] of cases) {
    for (const [input, expected] of [
      [validInput, 'T-M'],
      [malformedInput, 'T-G'],
    ] as const) {
      const result = classifyFrame(
        frameFromValue({
          jsonrpc: '2.0',
          id: `request-${method}`,
          method,
          params: { meta: { deadlineUnixMs: 1 }, input },
        }),
        NO_IN_FLIGHT,
      );
      assert.equal(result.disposition, expected, `${method} must classify as ${expected}`);
    }
  }
});

test('M0-C valid results reach T-L and malformed results reach T-H', () => {
  const cases = [
    [
      'messaging.send',
      {
        messageId: 'message-1',
        threadId: 'thread-1',
        revision: 1,
        messageHandle: { kind: 'message', token: 'message-handle-1' },
      },
      { messageId: 'message-1', threadId: 'thread-1', revision: 1 },
      {},
    ],
    [
      'messaging.appendElements',
      { messageId: 'message-1', revision: 2, appliedElementIds: ['element-2'] },
      { messageId: 'message-1', revision: 2, appliedElementIds: [] },
      { appendElementIds: ['element-2'] },
    ],
    [
      'messaging.subscribe',
      { subscriptionId: 'subscription-1' },
      { subscriptionId: 'subscription-1', extra: true },
      {},
    ],
    [
      'messaging.read',
      { events: [], ackToken: null, stale: false },
      { events: [], ackToken: 'ack-1', stale: false },
      { readLimit: 1 },
    ],
    ['messaging.ack', null, {}, {}],
    [
      'messaging.snapshot',
      { items: [], nextPageToken: null, snapshotAckToken: 'snapshot-ack-1' },
      { items: [], nextPageToken: null, snapshotAckToken: null },
      { snapshotMaxItems: 1 },
    ],
    [
      'host.messaging.deliver',
      { deliveryId: 'delivery-1' },
      { deliveryId: 'wrong-delivery' },
      { deliveryId: 'delivery-1' },
    ],
  ] as const;

  for (const [method, validResult, malformedResult, requestSnapshot] of cases) {
    for (const [result, expected] of [
      [validResult, 'T-L'],
      [malformedResult, 'T-H'],
    ] as const) {
      const classified = classifyFrame(
        frameFromValue({ jsonrpc: '2.0', id: `response-${method}`, result }),
        new Map<string, InFlightEntry>([
          [
            `response-${method}`,
            { method, requestSnapshot },
          ],
        ]),
      );
      assert.equal(
        classified.disposition,
        expected,
        `${method} result must classify as ${expected}`,
      );
    }
  }
});

test('M0-C read and snapshot enforce request-relative page limits', () => {
  const publishEvent = {
    eventId: 'event-1',
    sequence: 1,
    type: 'message.publish',
    envelope: M0C_ENVELOPE,
  } as const;
  const readResult = {
    events: [publishEvent, { ...publishEvent, eventId: 'event-2', sequence: 2 }],
    ackToken: 'ack-2',
    stale: false,
  } as const;
  const snapshotResult = {
    items: [M0C_ENVELOPE, { ...M0C_ENVELOPE, messageId: 'message-2' }],
    nextPageToken: null,
    snapshotAckToken: 'snapshot-ack-2',
  } as const;

  for (const [method, result, requestSnapshot] of [
    ['messaging.read', readResult, { readLimit: 1 }],
    ['messaging.snapshot', snapshotResult, { snapshotMaxItems: 1 }],
  ] as const) {
    const classified = classifyFrame(
      frameFromValue({ jsonrpc: '2.0', id: 'page-response', result }),
      new Map<string, InFlightEntry>([
        ['page-response', { method, requestSnapshot }],
      ]),
    );
    assert.equal(classified.disposition, 'T-H', `${method} must enforce its request limit`);
  }
});

// ---------------------------------------------------------------------------
// P1-2: Row 9 deliver closed member set enforcement
// (maintainer requirement — {deliveryId} only, no extras)
// ---------------------------------------------------------------------------

test('deliver result with extra field is T-H (closed ack member set)', () => {
  // Maintainer P1-2 RED: row 9 accepts {deliveryId:"d1",extra:true}
  // despite the frozen closed acknowledgement member set {deliveryId}.
  const rawFrame = '{"jsonrpc":"2.0","id":"d1","result":{"deliveryId":"abc","extra":true}}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  const inFlight = new Map<string, InFlightEntry>([
    ['d1', { method: 'host.messaging.deliver', requestSnapshot: { deliveryId: 'abc' } }],
  ]);
  const result = classifyFrame(frame, inFlight);
  assert.equal(result.disposition, 'T-H', 'extra field in deliver result must reject');
  assert.equal(result.outcome, 'close');
});

test('deliver result with only deliveryId (matching) is T-L (closed ack shape)', () => {
  // Positive counterexample: exact closed member set {deliveryId}, matches oracle.
  const rawFrame = '{"jsonrpc":"2.0","id":"d1","result":{"deliveryId":"correct"}}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  const inFlight = new Map<string, InFlightEntry>([
    ['d1', { method: 'host.messaging.deliver', requestSnapshot: { deliveryId: 'correct' } }],
  ]);
  const result = classifyFrame(frame, inFlight);
  assert.equal(result.disposition, 'T-L', 'exact closed ack shape with matching oracle must accept');
  assert.equal(result.outcome, 'accept');
});

// ---------------------------------------------------------------------------
// P1-2 (R2): deliveryId string bounds enforcement (1..128 code points)
// ---------------------------------------------------------------------------

test('deliver result with deliveryId length 1 is T-L (min bound)', () => {
  const id = 'x';
  const rawFrame = `{"jsonrpc":"2.0","id":"d1","result":{"deliveryId":"${id}"}}`;
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  const inFlight = new Map<string, InFlightEntry>([
    ['d1', { method: 'host.messaging.deliver', requestSnapshot: { deliveryId: id } }],
  ]);
  const result = classifyFrame(frame, inFlight);
  assert.equal(result.disposition, 'T-L', 'deliveryId at min bound must accept');
  assert.equal(result.outcome, 'accept');
});

test('deliver result with deliveryId length 128 is T-L (max bound)', () => {
  const id = 'a'.repeat(128);
  const rawFrame = `{"jsonrpc":"2.0","id":"d1","result":{"deliveryId":"${id}"}}`;
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  const inFlight = new Map<string, InFlightEntry>([
    ['d1', { method: 'host.messaging.deliver', requestSnapshot: { deliveryId: id } }],
  ]);
  const result = classifyFrame(frame, inFlight);
  assert.equal(result.disposition, 'T-L', 'deliveryId at max bound must accept');
  assert.equal(result.outcome, 'accept');
});

test('deliver result with deliveryId length 129 is T-H (N+1 above max)', () => {
  // Maintainer P1-2: frozen row-9 ack has deliveryId 1..128; 129 is invalid.
  const id = 'a'.repeat(129);
  const rawFrame = `{"jsonrpc":"2.0","id":"d1","result":{"deliveryId":"${id}"}}`;
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  const inFlight = new Map<string, InFlightEntry>([
    ['d1', { method: 'host.messaging.deliver', requestSnapshot: { deliveryId: id } }],
  ]);
  const result = classifyFrame(frame, inFlight);
  assert.equal(result.disposition, 'T-H', 'deliveryId exceeding max bound must reject');
  assert.equal(result.outcome, 'close');
});

test('deliver result with empty deliveryId is T-H (below min bound)', () => {
  const rawFrame = '{"jsonrpc":"2.0","id":"d1","result":{"deliveryId":""}}';
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  const inFlight = new Map<string, InFlightEntry>([
    ['d1', { method: 'host.messaging.deliver', requestSnapshot: { deliveryId: '' } }],
  ]);
  const result = classifyFrame(frame, inFlight);
  assert.equal(result.disposition, 'T-H', 'empty deliveryId must reject');
  assert.equal(result.outcome, 'close');
});

test('deliver snapshot with deliveryId length 129 is T-H (snapshot fail-closed)', () => {
  // Snapshot itself must also be a legal oracle value (1..128 code points).
  const id = 'b'.repeat(129);
  const rawFrame = `{"jsonrpc":"2.0","id":"d1","result":{"deliveryId":"${id}"}}`;
  const frame: DecodedNdjsonFrame = {
    raw: Buffer.from(rawFrame, 'utf8'),
    value: JSON.parse(rawFrame) as JsonObject,
  };
  const inFlight = new Map<string, InFlightEntry>([
    ['d1', { method: 'host.messaging.deliver', requestSnapshot: { deliveryId: id } }],
  ]);
  const result = classifyFrame(frame, inFlight);
  assert.equal(result.disposition, 'T-H', 'out-of-bounds snapshot deliveryId must fail-closed');
  assert.equal(result.outcome, 'close');
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
