import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);

test('the built conformance boundary exports the stdio harness', async () => {
  const [harness, conformance] = await Promise.all([
    import('../dist/conformance/stdio-harness/index.js'),
    import('@clowder-ai/plugin-contract/conformance'),
  ]);

  const missingPublicExports = Object.keys(harness)
    .filter((exportName) => !Object.hasOwn(conformance, exportName))
    .sort();

  assert.deepEqual(missingPublicExports, []);
  assert.equal(conformance.MAX_NDJSON_FRAME_BYTES, 1_048_576);
  assert.ok(Array.isArray(conformance.DISPOSITION_FIXTURE_VECTORS));
  assert.ok(Array.isArray(conformance.BETA8_HANDSHAKE_VECTOR_IDS));
  assert.ok(conformance.BETA8_HANDSHAKE_VECTOR_IDS.includes('T-L-5'));
  assert.equal(Object.hasOwn(conformance,'BETA10_LIFECYCLE_VECTOR_IDS'),false);
  assert.ok(Array.isArray(conformance.BETA11_MESSAGING_VECTOR_IDS));
  assert.equal(conformance.BETA11_MESSAGING_VECTOR_IDS.length, 39);
  assert.equal(
    conformance.M0C_BEHAVIOR_FIXTURE_EXPORT,
    '@clowder-ai/plugin-contract/fixtures/behavior/messaging/adversarial-invariants',
  );

  const messagingFixture = require(conformance.M0C_BEHAVIOR_FIXTURE_EXPORT);
  assert.deepEqual(
    messagingFixture.cases.map(({ id }) => id),
    conformance.M0C_BEHAVIOR_CASE_IDS,
  );

  const contract = await import('@clowder-ai/plugin-contract');
  assert.equal(
    contract.LIFECYCLE_ROW_ENCODED_BYTE_BOUNDS['host.lifecycle.ping']
      .maxEncodedRequestBytes > 0,
    true,
  );
});

test('the built public entry exports runtime manifest and catalog validators', async () => {
  const contract = await import('@clowder-ai/plugin-contract');
  assert.equal(typeof contract.validateManifest, 'function');
  assert.equal(typeof contract.validatePluginCatalog, 'function');
  assert.equal(typeof contract.listCatalogPlugins, 'function');
  assert.equal(typeof contract.searchCatalogPlugins, 'function');
  assert.equal(typeof contract.getCatalogPlugin, 'function');

  const catalogSchema = require('@clowder-ai/plugin-contract/schemas/catalog');
  assert.equal(catalogSchema.title, 'Clowder AI Plugin Catalog (v1)');
  const metadataSchema = require('@clowder-ai/plugin-contract/schemas/plugin-metadata');
  assert.equal(metadataSchema.title, 'Clowder AI Plugin Product Metadata (v1)');
});
