import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  getCatalogPlugin,
  listCatalogPlugins,
  searchCatalogPlugins,
  validateManifest,
  validatePluginCatalog,
} from '../packages/plugin-contract/dist/index.js';
import { parse } from 'yaml';

const catalog = JSON.parse(await readFile(new URL('../catalog/catalog.json', import.meta.url), 'utf8'));
const validation = validatePluginCatalog(catalog);
assert.equal(validation.valid, true, validation.valid ? undefined : JSON.stringify(validation.errors));
if (!validation.valid) process.exit(1);

assert.deepEqual(
  listCatalogPlugins(validation.catalog).map((entry) => entry.pluginId),
  ['dev.clowder.genoffice-docx', 'dev.clowder.video-analysis'],
);
assert.deepEqual(
  searchCatalogPlugins(validation.catalog, 'zhipu').map((entry) => entry.pluginId),
  ['dev.clowder.video-analysis'],
);
assert.equal(
  getCatalogPlugin(validation.catalog, 'dev.clowder.video-analysis')?.artifact.packageName,
  '@clowder-ai/video-analysis',
);

async function verifyCatalogEntry(catalogEntry) {
  const version = getCatalogPlugin(validation.catalog, catalogEntry.pluginId);
  assert.ok(version);
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'clowder-catalog-pack-'));
  try {
    const packed = spawnSync(
      process.execPath,
      ['scripts/pack-publish-artifact.mjs', version.artifact.provenance.sourceDirectory, temporaryDirectory],
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

    const unpackedDirectory = join(temporaryDirectory, 'unpacked');
    await mkdir(unpackedDirectory);
    const unpacked = spawnSync(
      'tar',
      ['-xzf', join(temporaryDirectory, artifact.filename), '-C', unpackedDirectory],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    );
    assert.equal(unpacked.status, 0, [unpacked.stdout, unpacked.stderr].filter(Boolean).join('\n'));
    const manifest = parse(
      await readFile(join(unpackedDirectory, 'package', version.manifestPath), 'utf8'),
    );
    const manifestValidation = validateManifest(manifest);
    assert.equal(
      manifestValidation.valid,
      true,
      manifestValidation.valid ? undefined : JSON.stringify(manifestValidation.errors),
    );
    if (!manifestValidation.valid) process.exit(1);
    assert.equal(manifestValidation.manifest.pluginId, catalogEntry.pluginId);
    assert.equal(manifestValidation.manifest.version, version.version);
    assert.equal(manifestValidation.manifest.contractVersion, version.contractVersion);
    assert.equal(manifestValidation.manifest.name, catalogEntry.name);
    assert.deepEqual(manifestValidation.manifest.description, catalogEntry.description);
    assert.deepEqual(manifestValidation.manifest.icon, catalogEntry.icon);

    const contributions = manifestValidation.manifest.contributions ?? [];
    const staticEditors = contributions.length > 0 &&
      contributions.every(entry => entry.type === 'content-editor-provider');
    if (!staticEditors) {
      assert.ok(
        artifact.files.some((file) => file.path === 'npm-shrinkwrap.json'),
        'packed artifact is missing npm-shrinkwrap.json',
      );
      const packageJson = JSON.parse(
        await readFile(join(unpackedDirectory, 'package', 'package.json'), 'utf8'),
      );
      assert.doesNotMatch(JSON.stringify(packageJson), /"workspace:/u);
      const shrinkwrap = JSON.parse(
        await readFile(join(unpackedDirectory, 'package', 'npm-shrinkwrap.json'), 'utf8'),
      );
      assert.ok(shrinkwrap.lockfileVersion === 2 || shrinkwrap.lockfileVersion === 3);
      assert.equal(shrinkwrap.name, packageJson.name);
      assert.equal(shrinkwrap.version, packageJson.version);
      assert.deepEqual(shrinkwrap.packages?.['']?.dependencies ?? {}, packageJson.dependencies ?? {});
      assert.deepEqual(
        shrinkwrap.packages?.['']?.optionalDependencies ?? {},
        packageJson.optionalDependencies ?? {},
      );
      for (const [packagePath, entry] of Object.entries(shrinkwrap.packages ?? {})) {
        if (packagePath.length === 0) continue;
        assert.match(packagePath, /^node_modules\//u);
        assert.notEqual(entry.link, true);
        assert.match(
          entry.version,
          /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u,
        );
        assert.match(entry.resolved, /^https:\/\/registry\.npmjs\.org\//u);
        assert.match(entry.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/u);
        const encoded = entry.integrity.slice('sha512-'.length);
        const decoded = Buffer.from(encoded, 'base64');
        assert.equal(decoded.byteLength, 64);
        assert.equal(decoded.toString('base64'), encoded);
      }

    } else {
      assert.equal(manifestValidation.manifest.runtime.transport, 'builtin');
      for (const entry of contributions) {
        const bytes = await readFile(join(unpackedDirectory, 'package', entry.surface.entrypoint));
        assert.equal(entry.surface.integrity, 'sha256-' + createHash('sha256').update(bytes).digest('base64'));
      }
    }

    if (typeof catalogEntry.icon !== 'string') {
      assert.ok(
        artifact.files.some((file) => file.path === catalogEntry.icon.src),
        `packed artifact is missing declared icon ${catalogEntry.icon.src}`,
      );
      const icon = await readFile(
        join(unpackedDirectory, 'package', catalogEntry.icon.src),
        'utf8',
      );
      if (catalogEntry.icon.type === 'svg') {
        assert.match(icon, /^<svg\b/);
        assert.doesNotMatch(
          icon,
          /<script\b|<foreignObject\b|\bon[a-z]+\s*=|(?:href|src)\s*=\s*["']https?:/i,
        );
      }
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }

}

for (const entry of listCatalogPlugins(validation.catalog)) await verifyCatalogEntry(entry);

console.log('catalog validation, list/search/get, and exact packed artifact: ok');
