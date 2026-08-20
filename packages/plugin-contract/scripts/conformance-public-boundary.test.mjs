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
  assert.ok(Array.isArray(conformance.BETA10_LIFECYCLE_VECTOR_IDS));
  assert.ok(conformance.BETA10_LIFECYCLE_VECTOR_IDS.includes('T-L-10'));
  assert.ok(Array.isArray(conformance.BETA11_MESSAGING_VECTOR_IDS));
  assert.equal(conformance.BETA11_MESSAGING_VECTOR_IDS.length, 36);
  assert.deepEqual(conformance.M0C_BEHAVIOR_CASE_IDS, [
    'raw-thread-id-rejection',
    'system-audience-dual-rejection',
    'cross-instance-handle-rejection',
    'origin-forgery-rejection',
    'base-revision-conflict-zero-change',
    'stale-cursor-snapshot-roundtrip',
    'cross-subscription-ack-rejection',
    'reply-to-cross-thread-leakage',
    'epistemic-status-upgrade-rejection',
    'preset-l2-rejected',
    'preset-visible-revocable',
    'whisper-target-beyond-default-empty-grant-rejected',
    'append-without-grant-rejected',
    'denied-on-message-rejected',
    'permission-matrix-complete',
    'delete-replay-events-preserves-canonical-messages',
    'snapshot-without-grant-rejected',
    'foreign-replay-delete-rejected',
  ]);
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

test('the built public entry exports the runtime manifest validator', async () => {
  const contract = await import('@clowder-ai/plugin-contract');
  assert.equal(typeof contract.validateManifest, 'function');
});
