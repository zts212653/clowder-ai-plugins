import assert from 'node:assert/strict';
import test from 'node:test';
import { assertDeploymentCatalog } from './deployment.js';
import { L2_CAPABILITIES } from '../generated/contract.generated.js';
const catalog = () => ({ roster: { cat: { family: 'maine-coon', available: true, lead: false } }, defaultCatId: 'cat',
  policy: { requireDifferentFamily: true, preferActiveInThread: true, preferLead: false, excludeUnavailable: true } });
test('deployment catalog is a closed minimal L2 contract', () => {
  assert.ok((L2_CAPABILITIES as readonly string[]).includes('deployment.read'));
  assertDeploymentCatalog(catalog());
  for (const extra of ['roles', 'evaluation', 'model', 'prompt']) {
    const value = catalog(); Object.assign(value.roster.cat, { [extra]: 'private' });
    assert.throws(() => assertDeploymentCatalog(value));
  }
  assert.throws(() => assertDeploymentCatalog({ ...catalog(), secret: 'private' }));
  assert.throws(() => assertDeploymentCatalog({ ...catalog(), defaultCatId: 'missing' }));
  assert.throws(() => assertDeploymentCatalog({ ...catalog(), roster: {} }));
  const wrong = catalog(); Object.assign(wrong.policy, { verified: true });
  assert.throws(() => assertDeploymentCatalog(wrong));
});
