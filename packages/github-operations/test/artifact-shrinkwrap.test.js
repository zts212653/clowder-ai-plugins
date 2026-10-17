import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { assertProductionDependencyClosure, assertWorkspaceSdkContractClosure } from '../../../scripts/catalog-package-shrinkwrap.mjs';
import { readRetainedSdkClosure } from '../../../scripts/retained-sdk-fixture.mjs';

test('published GitHub dependency closure matches its production manifest and SDK contract', async () => {
  const read = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
  const [manifest, lock, sdk, contract] = await Promise.all([
    read('../package.json'), read('../npm-shrinkwrap.json'),
    read('../../plugin-sdk/package.json'), read('../../plugin-contract/package.json'),
  ]);
  assert.equal(lock.name, manifest.name);
  assert.equal(lock.version, manifest.version);
  assertProductionDependencyClosure(manifest, lock);
  const retained = await readRetainedSdkClosure('0.2.0-beta.19');
  assertWorkspaceSdkContractClosure(lock, { sdkVersion: sdk.version, contractVersion: contract.version, retainedSdkClosures: [retained] });
  assert.ok(lock.packages['node_modules/fastify'], 'the embedded production router needs Fastify');
});
