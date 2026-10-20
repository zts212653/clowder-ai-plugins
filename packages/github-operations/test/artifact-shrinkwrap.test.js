import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {parse} from 'yaml';
import { assertProductionDependencyClosure, assertWorkspaceSdkContractClosure, sdkContractClosureForConsumer } from '../../../scripts/catalog-package-shrinkwrap.mjs';

test('published GitHub dependency closure matches its production manifest and SDK contract', async () => {
  const read = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
  const [manifest, lock, sdk, contract] = await Promise.all([
    read('../package.json'), read('../npm-shrinkwrap.json'),
    read('../../plugin-sdk/package.json'), read('../../plugin-contract/package.json'),
  ]);
  assert.equal(lock.name, manifest.name);
  assert.equal(lock.version, manifest.version);
  assertProductionDependencyClosure(manifest, lock);
  const workspaceLock=parse(await readFile(new URL('../../../pnpm-lock.yaml',import.meta.url),'utf8'));
  assertWorkspaceSdkContractClosure(lock, sdkContractClosureForConsumer(manifest,{workspaceSdk:sdk,workspaceContract:contract,lock:workspaceLock}));
  assert.ok(lock.packages['node_modules/fastify'], 'the embedded production router needs Fastify');
});
