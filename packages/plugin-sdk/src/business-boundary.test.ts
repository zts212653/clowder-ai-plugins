import assert from 'node:assert/strict';
import test from 'node:test';
import * as sdk from './index.js';
import { createFeatureContextSession, type FeatureBinding, type FeatureHostAdapter } from './feature-context.js';

const binding = {pluginInstanceId:'instance', pluginId:'dev.boundary', featureId:'main', packageRevision:'1',
  integrityEpoch:0, activationRevision:0, grantRevision:0, executionLease:'lease', dataPath:'/isolated/instance',
  grantedCapabilities:[]} as FeatureBinding;

test('Host client does not expose plugin business policy or a Host-owned local server', async () => {
  const adapter = Object.fromEntries(['custody','deployment','frustration','browserServices'].map(key => [key, {}]));
  const session = createFeatureContextSession(binding, adapter as unknown as FeatureHostAdapter);
  try {
    for (const key of ['custody','deployment','frustration','browserServices']) {
      assert.equal(Object.hasOwn(session.context, key), false, key);
    }
  } finally { await session.revoke(); }
});

test('SDK exports no business completion, deployment or feedback clients', () => {
  for (const name of ['createCustodyClient','guardPredicateVerifier','createDeploymentClient','createFrustrationClient']) {
    assert.equal(Object.hasOwn(sdk, name), false, name);
  }
});
