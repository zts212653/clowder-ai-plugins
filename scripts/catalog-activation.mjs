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

function resolveSelectedPluginIds(candidate, pluginIds) {
  if (pluginIds === undefined) return new Set(candidate.plugins.map(plugin => plugin.pluginId));
  assert.ok(Array.isArray(pluginIds) && pluginIds.length > 0,
    'Scoped catalog activation requires at least one plugin id');
  const selected = new Set();
  for (const pluginId of pluginIds) {
    assert.equal(typeof pluginId, 'string', 'Selected plugin id must be a string');
    assert.ok(!selected.has(pluginId), `Duplicate selected plugin: ${pluginId}`);
    assert.ok(candidate.plugins.some(plugin => plugin.pluginId === pluginId),
      `Selected plugin is absent from candidate: ${pluginId}`);
    selected.add(pluginId);
  }
  return selected;
}

function catalogForSelectedPlugins(candidate, selected) {
  return {
    ...candidate,
    plugins: candidate.plugins.filter(plugin => selected.has(plugin.pluginId)),
  };
}

function mergeSelectedPlugins(candidate, live, selected) {
  assert.equal(candidate.schemaVersion, live.schemaVersion,
    'Candidate and live catalog schema versions differ');
  const liveById = new Map(live.plugins.map(plugin => [plugin.pluginId, plugin]));
  return {
    ...live,
    plugins: candidate.plugins.flatMap(plugin => {
      if (selected.has(plugin.pluginId)) return [plugin];
      const existing = liveById.get(plugin.pluginId);
      return existing === undefined ? [] : [existing];
    }),
  };
}

export function parsePluginSelectorArgument(args, usage) {
  const values = args[0] === '--' ? args.slice(1) : args;
  assert.equal(values.length, 1, usage);
  return values[0];
}

export function assertCatalogActivated(candidate, live, pluginIds) {
  validate(candidate); validate(live);
  const selected = resolveSelectedPluginIds(candidate, pluginIds);
  const pending = [];
  for (const plugin of candidate.plugins.filter(entry => selected.has(entry.pluginId))) {
    const expected = getCatalogPlugin(candidate, plugin.pluginId);
    try { assert.deepEqual(getCatalogPlugin(live, plugin.pluginId), expected); }
    catch { pending.push(`${plugin.pluginId}@${expected.version}`); }
  }
  const activationCommand = pluginIds === undefined
    ? 'pnpm catalog:activate'
    : 'pnpm catalog:activate:plugin -- <pluginId>';
  assert.deepEqual(pending, [],
    `Catalog activation pending: ${pending.join(', ')}. The publication owner must run ${activationCommand} and deliver the reviewed catalog PR; npm publication alone is not completion.`);
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
  readArchive = readPublishedArchive, packCurrentPackage, pluginIds,
} = {}) {
  const candidatePath = join(root, 'catalog/candidate.json');
  const livePath = join(root, 'catalog/catalog.json');
  const selectionPath = join(root, 'catalog/initial-plugins.json');
  const candidateBytes = await readFile(candidatePath, 'utf8');
  const liveBytes = await readFile(livePath, 'utf8');
  const selectionBytes = await readFile(selectionPath, 'utf8');
  const candidate = JSON.parse(candidateBytes), live = JSON.parse(liveBytes);
  validate(candidate); validate(live);
  const selected = resolveSelectedPluginIds(candidate, pluginIds);
  const target = pluginIds === undefined
    ? candidate
    : mergeSelectedPlugins(candidate, live, selected);
  validate(target);
  assertInitialPluginSelectionAvailable(JSON.parse(selectionBytes), target);
  for (const plugin of live.plugins) for (const version of plugin.versions) {
    const retained = candidate.plugins.find(p => p.pluginId === plugin.pluginId)?.versions
      .find(v => v.version === version.version);
    assert.deepEqual(retained, version, `${plugin.pluginId}@${version.version}: cannot remove or rewrite an active release`);
  }
  let result;
  if (pluginIds === undefined) {
    const artifacts = [];
    result = await assertRegistryCompatibility({
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
  } else {
    const scoped = catalogForSelectedPlugins(candidate, selected);
    const count = await assertCatalogAvailable(scoped, { registryIntegrity, readArchive });
    result = {
      claims: count,
      published: scoped.plugins.map(plugin => {
        const artifact = getCatalogPlugin(scoped, plugin.pluginId).artifact;
        return `${artifact.packageName}@${artifact.version}`;
      }).sort(),
      unpublished: [],
    };
  }
  assert.equal(await readFile(candidatePath, 'utf8'), candidateBytes, 'Candidate changed during verification');
  assert.equal(await readFile(livePath, 'utf8'), liveBytes, 'Live catalog changed during verification');
  assert.equal(await readFile(selectionPath, 'utf8'), selectionBytes, 'Initial selection changed during verification');
  const targetBytes = pluginIds === undefined
    ? candidateBytes
    : `${JSON.stringify(target, null, 2)}\n`;
  const temporary = `${livePath}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, targetBytes, { flag: 'wx' }); await rename(temporary, livePath); }
  finally { await rm(temporary, { force: true }); }
  return result;
}

async function main() {
  if (process.argv[2] === '--activate') {
    // This prepares a reviewed catalog change; it never publishes npm packages or pushes Git.
    await activateCatalog();
    console.log('Prepared published catalog update. Review and commit it with the C1 Host delivery; no npm publication or Git push was performed.');
  } else if (process.argv[2] === '--activate-plugin') {
    const pluginId = parsePluginSelectorArgument(
      process.argv.slice(3),
      'Use --activate-plugin <pluginId>',
    );
    await activateCatalog({ pluginIds: [pluginId] });
    console.log(`Prepared published catalog update for ${pluginId}. Review and commit it; no npm publication or Git push was performed.`);
  } else if (process.argv[2] === '--check-activation') {
    const candidate = JSON.parse(await readFile(join(repoRoot, 'catalog/candidate.json'), 'utf8'));
    const live = JSON.parse(await readFile(join(repoRoot, 'catalog/catalog.json'), 'utf8'));
    assertInitialPluginSelectionAvailable(
      JSON.parse(await readFile(join(repoRoot, 'catalog/initial-plugins.json'), 'utf8')), live);
    assertCatalogActivated(candidate, live);
    const count = await assertCatalogAvailable(candidate);
    console.log(`Catalog activation complete: ${count} current plugin identities are live and their published archives verified.`);
  } else if (process.argv[2] === '--check-plugin-activation') {
    const pluginId = parsePluginSelectorArgument(
      process.argv.slice(3),
      'Use --check-plugin-activation <pluginId>',
    );
    const candidate = JSON.parse(await readFile(join(repoRoot, 'catalog/candidate.json'), 'utf8'));
    const live = JSON.parse(await readFile(join(repoRoot, 'catalog/catalog.json'), 'utf8'));
    assertInitialPluginSelectionAvailable(
      JSON.parse(await readFile(join(repoRoot, 'catalog/initial-plugins.json'), 'utf8')), live);
    assertCatalogActivated(candidate, live, [pluginId]);
    const selected = catalogForSelectedPlugins(candidate, resolveSelectedPluginIds(candidate, [pluginId]));
    await assertCatalogAvailable(selected);
    console.log(`Catalog activation complete for ${pluginId}; its published archive and live identity are verified.`);
  } else {
    assert.equal(process.argv[2], undefined,
      'Use no argument, --check-activation, --check-plugin-activation, --activate, or --activate-plugin');
    const path = 'catalog/catalog.json';
    const live = JSON.parse(await readFile(join(repoRoot, path), 'utf8'));
    assertInitialPluginSelectionAvailable(
      JSON.parse(await readFile(join(repoRoot, 'catalog/initial-plugins.json'), 'utf8')), live);
    const count = await assertCatalogAvailable(live);
    console.log(`${path}: ${count} published archive identities and bytes verified`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
