import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { assertProductionDependencyClosure } from '../../../scripts/catalog-package-shrinkwrap.mjs';

test('published GitHub dependency closure matches its production manifest and SDK contract', async () => {
  const read = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
  const [manifest, lock] = await Promise.all([
    read('../package.json'), read('../npm-shrinkwrap.json'),
  ]);
  assert.equal(lock.name, manifest.name);
  assert.equal(lock.version, manifest.version);
  assertProductionDependencyClosure(manifest, lock);
  assert.ok(lock.packages['node_modules/fastify'], 'the embedded production router needs Fastify');
});
