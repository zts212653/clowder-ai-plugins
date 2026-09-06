import assert from 'node:assert/strict';
import test from 'node:test';

import {
  checkGeneratedContract,
  generateContractSource,
  loadContractSchemas,
} from './generate-contract.js';
import type { JsonSchema } from './generate-contract.js';

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

test('generated contract projects behavior fixture operations and assertions', async () => {
  const schemas = await loadContractSchemas();
  const source = generateContractSource(schemas);

  assert.match(source, /export type BehaviorFixture =/);
  assert.match(source, /export type BehaviorCase =/);
  assert.match(source, /export type BehaviorExecution =/);
  assert.match(
    source,
    /'plugin-to-host-wire'.*'wire-admission'.*'host-to-plugin-delivery'.*'host-control'/s,
  );
  assert.match(source, /readonly verdictOracle:/);
  assert.match(source, /readonly code: -32602;/);
  assert.match(source, /readonly operation: 'send'/);
  assert.match(source, /readonly operation: 'deleteReplayEvents'/);
  const sideEffectAssertion = source.slice(
    source.indexOf('export type SideEffectAssertion ='),
    source.indexOf('export type ExpectedVerdict ='),
  );
  assert.equal(sideEffectAssertion.match(/readonly assertion:/g)?.length, 5);
  assert.match(
    sideEffectAssertion,
    /readonly assertion: 'unchanged';[\s\S]*readonly value\?: never;/,
  );
  assert.match(
    sideEffectAssertion,
    /readonly assertion: 'state_equals';[\s\S]*readonly value: unknown;/,
  );
  const expectedVerdict = source.slice(
    source.indexOf('export type ExpectedVerdict ='),
    source.indexOf('export type BehaviorCase ='),
  );
  assert.match(
    expectedVerdict,
    /readonly status: 'success';[\s\S]*readonly errorCode\?: never;/,
  );
  assert.match(
    expectedVerdict,
    /readonly status: 'error';[\s\S]*readonly errorCode: MessagingErrorCode;/,
  );
  assert.match(
    source,
    /readonly execution: [^\n]*readonly method: 'messaging\.send'[^\n]*;\n[\s\S]*readonly when: Extract<FixtureOperation, \{ readonly operation: 'send' \}>;/,
  );
  assert.equal(
    source.match(/export type MessagingErrorCode =/g)?.length,
    1,
    'shared messaging definitions must be generated exactly once',
  );
});

test('generated contract projects the physical-limb schema from the same truth source', async () => {
  const schemas = await loadContractSchemas();
  const source = generateContractSource(schemas);

  assert.match(source, /export type PhysicalLimbContribution =/);
  assert.match(source, /export type PhysicalLimbObservation =/);
  assert.match(source, /export type PhysicalLimbAction =/);
  assert.match(source, /export type PhysicalLimbReadiness =/);
  assert.match(source, /'limb\.sensor\.microphone'/);
});

test('generated contract preserves fixed-length arrays as readonly tuples', async () => {
  const schemas = await loadContractSchemas();
  const source = generateContractSource(schemas);

  assert.match(
    source,
    /export type PhysicalLimbRgb = readonly \[number, number, number\];/,
  );
});

test('behavior capability names resolve to the manifest-owned Capability type', async () => {
  const schemas = await loadContractSchemas();
  const source = generateContractSource(schemas);

  assert.match(source, /export type CapabilityName = Capability;/);
  assert.doesNotMatch(source, /export type CapabilityName = unknown;/);
});

test('generation rejects a behavior alias that drifts from its messaging definition', async () => {
  const mutated = structuredClone(await loadContractSchemas());
  const behaviorErrorCode = mutated.behavior.$defs?.['MessagingErrorCode'];
  assert.ok(behaviorErrorCode?.enum);
  behaviorErrorCode.enum.push('BEHAVIOR_ONLY_ERROR');

  assert.throws(
    () => generateContractSource(mutated),
    /behavior MessagingErrorCode must match the messaging schema definition/,
  );
});

test('generated contract exposes the signed P7D replay window default', async () => {
  const schemas = await loadContractSchemas();
  const source = generateContractSource(schemas);

  assert.match(
    source,
    /export const MESSAGING_REPLAY_WINDOW_DEFAULT = 'P7D' as const;/,
  );
  assert.match(source, /@signed\(G-0 2026-07-15\)/);
  assert.match(source, /Host control plane\/UI obligation/);
});

test('generation rejects a non-duration replay window default', async () => {
  const mutated = structuredClone(await loadContractSchemas());
  (mutated.messaging as Record<string, unknown>)['x-clowder-replay-window-default'] =
    '7 days';

  assert.throws(() => generateContractSource(mutated), /replay window default.*ISO 8601 days/);
});

test('replay window default is projected from schema metadata', async () => {
  const mutated = structuredClone(await loadContractSchemas());
  (mutated.messaging as Record<string, unknown>)['x-clowder-replay-window-default'] =
    'P14D';

  assert.match(
    generateContractSource(mutated),
    /export const MESSAGING_REPLAY_WINDOW_DEFAULT = 'P14D' as const;/,
  );
});

test('generated object fields preserve required and optional schema fields', async () => {
  const schemas = await loadContractSchemas();
  const source = generateContractSource(schemas);

  assert.match(source, /readonly address: MessageAddress;/);
  assert.match(source, /readonly draftAudience\?: DraftAudience;/);
  assert.match(source, /readonly idempotencyKey: string;/);
  assert.match(source, /export type LocalizedDescription = string \| LocalizedDescriptionObject;/);
  assert.match(source, /export type PluginIcon = 'github' \| PackageIcon;/);
  assert.match(source, /readonly description\?: LocalizedDescription;/);
  assert.match(source, /readonly icon\?: PluginIcon;/);
  assert.match(source, /export type CatalogPluginEntry = [\s\S]*readonly description: LocalizedDescription;/);
  assert.match(source, /export type CatalogPluginEntry = [\s\S]*readonly icon: PluginIcon;/);
});

test('generated package icons preserve type-dependent filename suffixes', async () => {
  const schemas = await loadContractSchemas();
  const source = generateContractSource(schemas);
  const packageIcon = source.slice(
    source.indexOf('export type PackageIcon ='),
    source.indexOf('export type PluginIcon ='),
  );

  assert.equal(packageIcon.match(/readonly type:/g)?.length, 2);
  assert.match(packageIcon, /readonly type: 'svg';[\s\S]*`\$\{string\}\.svg`/);
  assert.match(packageIcon, /readonly type: 'png';[\s\S]*`\$\{string\}\.png`/);
});

test('generated configuration fields preserve kind-dependent schema constraints', async () => {
  const schemas = await loadContractSchemas();
  const source = generateContractSource(schemas);
  const configurationField = source.slice(
    source.indexOf('export type ConfigurationField ='),
    source.indexOf('export type EnvironmentBinding ='),
  );

  assert.equal(configurationField.match(/readonly kind:/g)?.length, 6);
  assert.match(
    configurationField,
    /readonly kind: 'select';[\s\S]*readonly default\?: string;[\s\S]*readonly options: readonly ConfigurationOption\[\];/,
  );
  assert.match(
    configurationField,
    /readonly kind: 'secret';[\s\S]*readonly default\?: never;[\s\S]*readonly options\?: never;/,
  );
  assert.match(
    configurationField,
    /readonly kind: 'boolean';[\s\S]*readonly default\?: boolean;[\s\S]*readonly options\?: never;/,
  );
  assert.match(
    configurationField,
    /readonly kind: 'number';[\s\S]*readonly default\?: number;[\s\S]*readonly options\?: never;/,
  );
});

test('generation fails closed for an unclassified conditional definition', async () => {
  const mutated = structuredClone(await loadContractSchemas());
  const environmentBinding = mutated.manifest.$defs?.['EnvironmentBinding'];
  assert.ok(environmentBinding);
  (environmentBinding as { allOf?: JsonSchema[] }).allOf = [
    {
      if: { properties: { source: { const: 'env' } } },
      then: { required: ['name'] },
    },
  ];

  assert.throws(
    () => generateContractSource(mutated),
    /Unhandled conditional schema definition: EnvironmentBinding/,
  );
});

test('generation fails closed for an unclassified conditional behavior definition', async () => {
  const mutated = structuredClone(await loadContractSchemas());
  const fixtureMetadata = mutated.behavior.$defs?.['FixtureMetadata'];
  assert.ok(fixtureMetadata);
  (fixtureMetadata as { allOf?: JsonSchema[] }).allOf = [
    {
      if: { properties: { version: { const: 'v0' } } },
      then: { required: ['contractVersion'] },
    },
  ];

  assert.throws(
    () => generateContractSource(mutated),
    /Unhandled conditional behavior definition: FixtureMetadata/,
  );
});

test('generated runtime types preserve transport-specific entrypoint requirements', async () => {
  const schemas = await loadContractSchemas();
  const source = generateContractSource(schemas);

  assert.match(source, /export type RuntimeDeclaration = ExternalRuntimeDeclaration \| BuiltinRuntimeDeclaration;/);
  assert.match(source, /export type ExternalRuntimeDeclaration = [\s\S]*readonly entrypoint: PackageRelativePath;/);
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
