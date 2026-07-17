import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';

import { WIRE_METHOD_REGISTRY } from './registry.js';
import {
  WIRE_ERROR_CLASSES,
  WIRE_ERROR_CODE_RANGE,
  HANDSHAKE_REJECT_REASONS,
} from './errors.js';
import {
  CONTRACT_MINTED_BOUNDS,
  FROZEN_BYTE_CEILINGS,
  MAX_FRAME_BYTES,
  INTERNAL_ASSEMBLER_BUDGETS,
  PAGE_CARDINALITY_BOUNDS,
} from './bounds.js';

const EXPECTED_METHODS = [
  'broker.hello',
  'broker.ready',
  'messaging.send',
  'messaging.appendElements',
  'messaging.subscribe',
  'messaging.read',
  'messaging.ack',
  'messaging.snapshot',
  'host.messaging.deliver',
  'host.grants.changed',
  'host.lifecycle.ping',
  'host.lifecycle.drain',
];

test('registry reserves exactly the 12 co-signed production names, in canonical order', () => {
  assert.deepEqual(
    WIRE_METHOD_REGISTRY.map((row) => row.method),
    EXPECTED_METHODS,
  );
});

test('reservation-only lifecycle: every row is ready=false (D0 = Option A)', () => {
  for (const row of WIRE_METHOD_REGISTRY) {
    assert.equal(row.ready, false, `${row.method} must stay ready=false until proofs pass`);
  }
});

test('no fixture verb ever appears as a production method', () => {
  const fixtureVerbs = ['setup', 'observe', 'applyGrantPreset', 'revokeGrant', 'deliverOnMessage'];
  for (const row of WIRE_METHOD_REGISTRY) {
    for (const verb of fixtureVerbs) {
      assert.ok(!row.method.includes(verb), `${row.method} collides with fixture verb ${verb}`);
    }
  }
});

test('error classes cover the contract-reserved range contiguously with const messages', () => {
  const codes = WIRE_ERROR_CLASSES.map((c) => c.code).sort((a, b) => a - b);
  assert.deepEqual(codes, [-32094, -32093, -32092, -32091, -32090]);
  assert.equal(codes[0], WIRE_ERROR_CODE_RANGE.min);
  assert.equal(codes[codes.length - 1], WIRE_ERROR_CODE_RANGE.max);
  for (const cls of WIRE_ERROR_CLASSES) {
    assert.ok(cls.message.length > 0, `${cls.name} needs a const message (JSON-RPC 2.0 §5.1)`);
    assert.equal(cls.message, cls.message.toLowerCase(), 'const messages are stable lowercase');
  }
});

test('handshake reject taxonomy stays the closed 7-value enum', () => {
  assert.equal(HANDSHAKE_REJECT_REASONS.length, 7);
  assert.ok(HANDSHAKE_REJECT_REASONS.includes('BINDING_REPLAY'));
});

test('frozen byte ceilings match the frozen schema x-clowder-bounds verbatim', async () => {
  const schema = JSON.parse(
    await readFile(new URL('../schemas/messaging.schema.json', import.meta.url), 'utf8'),
  ) as { 'x-clowder-bounds'?: Record<string, number> };
  const frozen = schema['x-clowder-bounds'];
  assert.ok(frozen, 'messaging schema must carry x-clowder-bounds');
  assert.equal(FROZEN_BYTE_CEILINGS.maxElementPayloadBytes, frozen.maxElementPayloadBytes);
  assert.equal(FROZEN_BYTE_CEILINGS.maxTotalPayloadBytes, frozen.maxTotalPayloadBytes);
});

test('read cardinality mirrors the frozen SubscriptionNormalResponse literal', async () => {
  const schema = JSON.parse(
    await readFile(new URL('../schemas/messaging.schema.json', import.meta.url), 'utf8'),
  ) as {
    $defs: Record<string, { properties?: Record<string, { maxItems?: number; minItems?: number }> }>;
  };
  const normal = schema.$defs.SubscriptionNormalResponse;
  assert.ok(normal?.properties?.events);
  assert.equal(PAGE_CARDINALITY_BOUNDS.readEventsPerPage.max, normal.properties.events.maxItems);
  assert.equal(PAGE_CARDINALITY_BOUNDS.readEventsPerPage.min, normal.properties.events.minItems);
  assert.equal(PAGE_CARDINALITY_BOUNDS.readLimit.max, PAGE_CARDINALITY_BOUNDS.readEventsPerPage.max);
});

test('public/internal split: budgets stay strictly inside the frame cap and are not public bounds', () => {
  assert.ok(INTERNAL_ASSEMBLER_BUDGETS.pageByteBudget < MAX_FRAME_BYTES);
  assert.ok(
    INTERNAL_ASSEMBLER_BUDGETS.maxSerializedItemBytes < INTERNAL_ASSEMBLER_BUDGETS.pageByteBudget,
  );
  const publicKeys = Object.keys(CONTRACT_MINTED_BOUNDS);
  for (const internalKey of Object.keys(INTERNAL_ASSEMBLER_BUDGETS)) {
    assert.ok(!publicKeys.includes(internalKey), `${internalKey} must not leak into public bounds`);
  }
});

test('contract-minted bounds all carry minLength 1 (empty token != absent)', () => {
  for (const [name, bound] of Object.entries(CONTRACT_MINTED_BOUNDS)) {
    assert.equal(bound.minLength, 1, `${name} must reject the empty string`);
    assert.ok(bound.maxLength === 128 || bound.maxLength === 512, `${name} uses the canonical tiers`);
  }
});
