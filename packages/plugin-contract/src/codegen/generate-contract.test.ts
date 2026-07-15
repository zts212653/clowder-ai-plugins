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

test('generated object fields preserve required and optional schema fields', async () => {
  const schemas = await loadContractSchemas();
  const source = generateContractSource(schemas);

  assert.match(source, /readonly address: MessageAddress;/);
  assert.match(source, /readonly draftAudience\?: DraftAudience;/);
  assert.match(source, /readonly idempotencyKey: string;/);
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
