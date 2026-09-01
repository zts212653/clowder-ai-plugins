import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  getCatalogPlugin,
  listCatalogPlugins,
  searchCatalogPlugins,
  validatePluginCatalog,
} from '../packages/plugin-contract/dist/index.js';

const catalog = JSON.parse(await readFile(new URL('../catalog/catalog.json', import.meta.url), 'utf8'));
const validation = validatePluginCatalog(catalog);
assert.equal(validation.valid, true, validation.valid ? undefined : JSON.stringify(validation.errors));
if (!validation.valid) process.exit(1);

assert.deepEqual(
  listCatalogPlugins(validation.catalog).map((entry) => entry.pluginId),
  ['dev.clowder.video-analysis'],
);
assert.deepEqual(
  searchCatalogPlugins(validation.catalog, 'zhipu').map((entry) => entry.pluginId),
  ['dev.clowder.video-analysis'],
);
assert.equal(
  getCatalogPlugin(validation.catalog, 'dev.clowder.video-analysis')?.artifact.packageName,
  '@clowder-ai/video-analysis',
);

const version = getCatalogPlugin(validation.catalog, 'dev.clowder.video-analysis');
assert.ok(version);
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'clowder-catalog-pack-'));
try {
  const packed = spawnSync(
    process.execPath,
    ['scripts/pack-publish-artifact.mjs', 'packages/video-analysis', temporaryDirectory],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  assert.equal(
    packed.status,
    0,
    [packed.stdout, packed.stderr].filter(Boolean).join('\n'),
  );
  const [artifact] = JSON.parse(packed.stdout);
  assert.equal(artifact.name, version.artifact.packageName);
  assert.equal(artifact.version, version.version);
  assert.equal(artifact.integrity, version.artifact.integrity);
  assert.equal(artifact.shasum, version.artifact.shasum);
  const registryFilename = `${version.artifact.packageName.split('/').at(-1)}-${version.version}.tgz`;
  assert.ok(version.artifact.tarballUrl.endsWith(`/${registryFilename}`));
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

console.log('catalog validation, list/search/get, and exact packed artifact: ok');
