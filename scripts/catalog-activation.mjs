import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCatalogPlugin, validatePluginCatalog } from '../packages/plugin-contract/dist/index.js';
import { assertRegistryCompatibility, OFFICIAL_NPM_REGISTRY, readRegistryIntegrity } from './registry-publish-compatibility.mjs';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const maxArchiveBytes = 64 * 1024 * 1024;

export function assertCatalogActivated(candidate, live) {
  validate(candidate); validate(live);
  const pending = [];
  for (const plugin of candidate.plugins) {
    const expected = getCatalogPlugin(candidate, plugin.pluginId);
    const actual = getCatalogPlugin(live, plugin.pluginId);
    try { assert.deepEqual(actual, expected); }
    catch { pending.push(`${plugin.pluginId}@${expected.version}`); }
  }
  assert.deepEqual(pending, [],
    `Catalog activation pending: ${pending.join(', ')}. The publication owner must run pnpm catalog:activate and deliver the reviewed catalog PR; npm publication alone is not completion.`);
}

function validate(catalog) {
  const result = validatePluginCatalog(catalog);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
}

export function assertInitialPluginSelectionAvailable(selection, catalog) {
  validate(catalog);
  assert.equal(selection?.schemaVersion, 1, 'Invalid initial plugin selection schema');
  assert.ok(Array.isArray(selection.plugins) && selection.plugins.length <= 64,
    'Invalid initial plugin selection list');
  const seen = new Set();
  for (const plugin of selection.plugins) {
    assert.ok(plugin && typeof plugin.pluginId === 'string' && plugin.pluginId.length > 0
      && typeof plugin.enabled === 'boolean', 'Invalid initial plugin selection entry');
    assert.ok(!seen.has(plugin.pluginId), `Duplicate initial plugin: ${plugin.pluginId}`);
    seen.add(plugin.pluginId);
    // A disabled selection is installed too; enabled only controls activation.
    assert.ok(getCatalogPlugin(catalog, plugin.pluginId),
      `Initial plugin is absent from catalog: ${plugin.pluginId}`);
  }
  return seen.size;
}

function archiveUrl(name, version) {
  return `${OFFICIAL_NPM_REGISTRY}/${name}/-/${name.split('/').at(-1)}-${version}.tgz`;
}

export async function readPublishedArchive(url) {
  assert.equal(new URL(url).origin, OFFICIAL_NPM_REGISTRY);
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Archive unavailable: ${url}: HTTP ${response.status}`);
  if (Number(response.headers.get('content-length')) > maxArchiveBytes) throw new Error('Archive too large');
  assert.ok(response.body, 'Archive has no body');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxArchiveBytes) { await reader.cancel(); throw new Error('Archive too large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}

export function assertPublishedArchive(bytes, artifact) {
  assert.ok(bytes.length <= maxArchiveBytes, 'Archive too large');
  assert.equal(`sha512-${createHash('sha512').update(bytes).digest('base64')}`, artifact.integrity,
    `${artifact.packageName}@${artifact.version}: archive integrity mismatch`);
  if (artifact.shasum) assert.equal(createHash('sha1').update(bytes).digest('hex'), artifact.shasum);
  const result = spawnSync('tar', ['-xOzf', '-', 'package/package.json'], {
    input: bytes, encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 10_000,
  });
  assert.equal(result.status, 0, `Cannot read archive identity: ${result.stderr}`);
  const pkg = JSON.parse(result.stdout);
  assert.equal(pkg.name, artifact.packageName, 'Archive package name mismatch');
  assert.equal(pkg.version, artifact.version, 'Archive package version mismatch');
}

export async function assertCatalogAvailable(catalog, {
  registryIntegrity = readRegistryIntegrity, readArchive = readPublishedArchive,
} = {}) {
  validate(catalog);
  const checked = new Map();
  // Host discovery offers the highest version. Historical rows remain immutable
  // provenance; they are not a demand to publish old, never-released candidates.
  for (const plugin of catalog.plugins) {
    const { artifact } = getCatalogPlugin(catalog, plugin.pluginId);
    const key = `${artifact.packageName}@${artifact.version}`;
    if (checked.has(key)) { assert.equal(checked.get(key), artifact.integrity); continue; }
    assert.equal(await registryIntegrity(artifact.packageName, artifact.version), artifact.integrity,
      `${key}: live catalog requires a published immutable identity`);
    assertPublishedArchive(await readArchive(artifact.tarballUrl), artifact);
    checked.set(key, artifact.integrity);
  }
  return checked.size;
}

export async function activateCatalog({
  root = repoRoot, registryIntegrity = readRegistryIntegrity,
  readArchive = readPublishedArchive, packCurrentPackage,
} = {}) {
  const candidatePath = join(root, 'catalog/candidate.json');
  const livePath = join(root, 'catalog/catalog.json');
  const selectionPath = join(root, 'catalog/initial-plugins.json');
  const candidateBytes = await readFile(candidatePath, 'utf8');
  const liveBytes = await readFile(livePath, 'utf8');
  const selectionBytes = await readFile(selectionPath, 'utf8');
  const candidate = JSON.parse(candidateBytes), live = JSON.parse(liveBytes);
  validate(candidate); validate(live);
  assertInitialPluginSelectionAvailable(JSON.parse(selectionBytes), candidate);
  for (const plugin of live.plugins) for (const version of plugin.versions) {
    const retained = candidate.plugins.find(p => p.pluginId === plugin.pluginId)?.versions
      .find(v => v.version === version.version);
    assert.deepEqual(retained, version, `${plugin.pluginId}@${version.version}: cannot remove or rewrite an active release`);
  }
  const artifacts = [];
  const result = await assertRegistryCompatibility({
    catalog: candidate, root, registryIntegrity,
    workflowSource: await readFile(join(root, '.github/workflows/contract-ci.yml'), 'utf8'),
    packCurrentPackage: async (directory, destination) => {
      let artifact;
      if (packCurrentPackage) artifact = await packCurrentPackage(directory, destination);
      else {
        const packed = spawnSync(process.execPath, ['scripts/pack-publish-artifact.mjs', directory, destination],
          { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
        assert.equal(packed.status, 0, packed.stderr);
        [artifact] = JSON.parse(packed.stdout);
      }
      artifacts.push(artifact);
      return artifact;
    },
  });
  const required = new Set(artifacts.map(a => `${a.name}@${a.version}`));
  assert.deepEqual(result.unpublished.filter(identity => required.has(identity)), [],
    'Activation requires the complete publication batch, including Contract and SDK');
  await assertCatalogAvailable(candidate, { registryIntegrity, readArchive });
  // Core archives are publication dependencies, even though they have no plugin catalog row.
  for (const artifact of artifacts) if (!candidate.plugins.some(p => p.versions.some(v =>
    v.artifact.packageName === artifact.name && v.version === artifact.version))) {
    assertPublishedArchive(await readArchive(archiveUrl(artifact.name, artifact.version)),
      { packageName: artifact.name, version: artifact.version, integrity: artifact.integrity });
  }
  assert.equal(await readFile(candidatePath, 'utf8'), candidateBytes, 'Candidate changed during verification');
  assert.equal(await readFile(livePath, 'utf8'), liveBytes, 'Live catalog changed during verification');
  assert.equal(await readFile(selectionPath, 'utf8'), selectionBytes, 'Initial selection changed during verification');
  const temporary = `${livePath}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, candidateBytes, { flag: 'wx' }); await rename(temporary, livePath); }
  finally { await rm(temporary, { force: true }); }
  return result;
}

async function main() {
  if (process.argv[2] === '--activate') {
    // This prepares a reviewed catalog change; it never publishes npm packages or pushes Git.
    await activateCatalog();
    console.log('Prepared published catalog update. Review and commit it with the C1 Host delivery; no npm publication or Git push was performed.');
  } else if (process.argv[2] === '--check-activation') {
    const candidate = JSON.parse(await readFile(join(repoRoot, 'catalog/candidate.json'), 'utf8'));
    const live = JSON.parse(await readFile(join(repoRoot, 'catalog/catalog.json'), 'utf8'));
    assertInitialPluginSelectionAvailable(
      JSON.parse(await readFile(join(repoRoot, 'catalog/initial-plugins.json'), 'utf8')), live);
    assertCatalogActivated(candidate, live);
    const count = await assertCatalogAvailable(candidate);
    console.log(`Catalog activation complete: ${count} current plugin identities are live and their published archives verified.`);
  } else {
    assert.equal(process.argv[2], undefined, 'Use no argument, --check-activation, or --activate');
    const path = 'catalog/catalog.json';
    const live = JSON.parse(await readFile(join(repoRoot, path), 'utf8'));
    assertInitialPluginSelectionAvailable(
      JSON.parse(await readFile(join(repoRoot, 'catalog/initial-plugins.json'), 'utf8')), live);
    const count = await assertCatalogAvailable(live);
    console.log(`${path}: ${count} published archive identities and bytes verified`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
