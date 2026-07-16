import assert from 'node:assert/strict';
import test from 'node:test';

import {
  checkGeneratedContract,
  generateContractSource,
  loadContractSchemas,
} from './generate-contract.js';

test('checked-in generated contract is current', async () => {
  assert.equal(await checkGeneratedContract(), true);
});

test('generated PluginFeature uses the schema-owned Capability union', async () => {
  const schemas = await loadContractSchemas();
  const source = generateContractSource(schemas);

  assert.match(source, /export type Capability =/);
  assert.match(source, /'messaging\.send'/);
  assert.match(source, /readonly capabilities: readonly Capability\[\]/);
});

test('generated contract exposes the signed capability grant policy', async () => {
  const schemas = await loadContractSchemas();
  const source = generateContractSource(schemas);

  assert.match(source, /export const FIRST_PARTY_PRESET_CAPABILITIES = L1_CAPABILITIES;/);
  assert.match(source, /export const DEFAULT_WHISPER_TARGETS = \[\] as const;/);
  assert.match(source, /export const LIFECYCLE_CALLBACKS_ARE_PROTOCOL_INTRINSIC = true as const;/);
  assert.match(source, /@signed\(G-0 2026-07-15\)/);
});

test('generated contract exposes the signed seven-day replay default', async () => {
  const schemas = await loadContractSchemas();
  const source = generateContractSource(schemas);

  assert.match(source, /export const MESSAGING_REPLAY_DEFAULTS = \{/);
  assert.match(source, /defaultRetentionDays: 7,/);
  assert.match(source, /canonicalMessagesTtl: 0,/);
});

test('generation rejects unsigned or ambiguous first-party grant policy metadata', async () => {
  const unsigned = structuredClone(await loadContractSchemas());
  const unsignedPolicy = unsigned.manifest['x-clowder-capability-policy'] as {
    signed?: { gate?: string };
  };
  unsignedPolicy.signed = { gate: 'candidate' };

  assert.throws(() => generateContractSource(unsigned), /capability policy.*signed.*G-0/);

  const widened = structuredClone(await loadContractSchemas());
  const widenedPolicy = widened.manifest['x-clowder-capability-policy'] as {
    firstPartyPreset?: { allowedLayers?: string[] };
  };
  widenedPolicy.firstPartyPreset!.allowedLayers = ['L1', 'L2'];

  assert.throws(() => generateContractSource(widened), /first-party preset.*one known capability layer/);
});

test('generation rejects replay metadata that violates canonical TTL=0', async () => {
  const mutated = structuredClone(await loadContractSchemas());
  const replay = mutated.messaging['x-clowder-replay-retention'] as {
    signed?: { gate?: string };
    canonicalMessagesTtl?: number;
  };
  replay.canonicalMessagesTtl = 7;

  assert.throws(() => generateContractSource(mutated), /canonical messages.*TTL=0/);
});

test('replay defaults are projected from schema metadata rather than handwritten constants', async () => {
  const mutated = structuredClone(await loadContractSchemas());
  const replay = mutated.messaging['x-clowder-replay-retention'] as {
    defaultRetentionDays?: number;
  };
  replay.defaultRetentionDays = 14;

  assert.match(generateContractSource(mutated), /defaultRetentionDays: 14,/);
});

test('generated object fields preserve required and optional schema fields', async () => {
  const schemas = await loadContractSchemas();
  const source = generateContractSource(schemas);

  assert.match(source, /readonly address: MessageAddress;/);
  assert.match(source, /readonly draftAudience\?: DraftAudience;/);
  assert.match(source, /readonly idempotencyKey: string;/);
});

test('generated runtime types preserve transport-specific entrypoint requirements', async () => {
  const schemas = await loadContractSchemas();
  const source = generateContractSource(schemas);

  assert.match(source, /export type RuntimeDeclaration = ExternalRuntimeDeclaration \| BuiltinRuntimeDeclaration;/);
  assert.match(source, /export type ExternalRuntimeDeclaration = [\s\S]*readonly entrypoint: string;/);
  assert.match(source, /export type BuiltinRuntimeDeclaration = [\s\S]*readonly entrypoint\?: string;/);
});

test('a schema mutation deterministically changes the generated projection', async () => {
  const schemas = await loadContractSchemas();
  const baseline = generateContractSource(schemas);
  const mutated = structuredClone(schemas);
  const actorKind = mutated.messaging.$defs?.['ActorKind'];
  assert.ok(actorKind?.enum);
  actorKind.enum.push('fixture_actor');

  const changed = generateContractSource(mutated);

  assert.notEqual(changed, baseline);
  assert.match(changed, /'fixture_actor'/);
});

test('generation fails when structural messaging bounds drift from metadata', async () => {
  const mutated = structuredClone(await loadContractSchemas());
  const elements = mutated.messaging.$defs?.['DraftPayload']?.properties?.['elements'];
  assert.ok(elements);
  (elements as { maxItems?: number }).maxItems = 31;

  assert.throws(
    () => generateContractSource(mutated),
    /maxElementsPerOperation.*DraftPayload\.elements/,
  );
});

test('generation binds canonical payloads to the message-level element cap', async () => {
  const mutated = structuredClone(await loadContractSchemas());
  const bounds = mutated.messaging['x-clowder-bounds'] as Record<string, number>;
  bounds['maxElementsPerMessage'] = 127;

  assert.throws(
    () => generateContractSource(mutated),
    /maxElementsPerMessage.*MessagePayload\.elements/,
  );
});

test('generation fails when data strategy metadata drifts from schema constraints', async () => {
  const mutated = structuredClone(await loadContractSchemas());
  const strategies = mutated.manifest['x-clowder-data-class-strategies'] as Record<
    string,
    string[]
  >;
  strategies['user-authored'] = ['lifecycle'];

  assert.throws(
    () => generateContractSource(mutated),
    /data-class strategy metadata.*schema constraints/,
  );
});
