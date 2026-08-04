import assert from 'node:assert/strict';
import test from 'node:test';

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
});

test('the built public entry exports the runtime manifest validator', async () => {
  const contract = await import('@clowder-ai/plugin-contract');
  assert.equal(typeof contract.validateManifest, 'function');
});
