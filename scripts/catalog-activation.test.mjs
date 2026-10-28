import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parse } from 'yaml';
import { activateCatalog, assertCatalogActivated, assertCatalogAvailable, assertInitialPluginSelectionAvailable, assertPublishedArchive } from './catalog-activation.mjs';

test('the default initial selection contains only installable live catalog identities', async () => {
  const selection = JSON.parse(await readFile(new URL('../catalog/initial-plugins.json', import.meta.url), 'utf8'));
  const live = JSON.parse(await readFile(new URL('../catalog/catalog.json', import.meta.url), 'utf8'));
  assert.equal(assertInitialPluginSelectionAvailable(selection, live), selection.plugins.length);
});

test('repository candidate retains live release identities before any activation provider work', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const livePath = join(root, 'catalog/catalog.json');
  const candidatePath = join(root, 'catalog/candidate.json');
  const liveBefore = await readFile(livePath, 'utf8'), candidateBefore = await readFile(candidatePath, 'utf8');
  const reachedProvider = new Error('Offline activation boundary reached');
  await assert.rejects(activateCatalog({ root,
    registryIntegrity: async () => { throw reachedProvider; },
    readArchive: async () => { assert.fail('Must stop before downloading or writing a live catalog'); },
  }), error => error === reachedProvider);
  assert.equal(await readFile(livePath, 'utf8'), liveBefore);
  assert.equal(await readFile(candidatePath, 'utf8'), candidateBefore);
});

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'catalog-activation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'catalog'), { recursive: true });
  await mkdir(join(directory, '.github/workflows'), { recursive: true });
  await mkdir(join(directory, 'package'));
  const archives = new Map(), published = new Map();
  async function archive(name, version) {
    await writeFile(join(directory, 'package/package.json'), JSON.stringify({ name, version }));
    const tar = spawnSync('tar', ['-czf', '-', '-C', directory, 'package']);
    assert.equal(tar.status, 0);
    const bytes = tar.stdout;
    const artifact = { kind: 'npm', packageName: name, version,
      tarballUrl: `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${version}.tgz`,
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
      shasum: createHash('sha1').update(bytes).digest('hex'),
      provenance: { repository: 'https://github.com/example/plugins', sourceDirectory: 'packages/example' } };
    archives.set(artifact.tarballUrl, bytes);
    published.set(`${name}@${version}`, artifact.integrity);
    return artifact;
  }
  const previous = await archive('@clowder-ai/example', '0.1.0-alpha.1');
  const next = await archive('@clowder-ai/example', '0.1.0-alpha.2');
  const core = await archive('@clowder-ai/plugin-contract', '0.1.0-beta.37');
  const sdk = await archive('@clowder-ai/plugin-sdk', '0.2.0-beta.23');
  const row = artifact => ({ version: artifact.version, contractVersion: '0.1.0', manifestPath: 'plugin.yaml', artifact });
  const entry = (pluginId, versions) => ({ pluginId, name: pluginId, description: pluginId,
    icon: { type: 'svg', src: 'assets/icon.svg' }, publisher: { id: 'example', name: 'Example' }, versions: versions.map(row) });
  const live = { schemaVersion: '1', plugins: [entry('official.example', [previous])] };
  const candidate = { schemaVersion: '1', plugins: [entry('official.example', [next, previous])] };
  const livePath = join(directory, 'catalog/catalog.json');
  await writeFile(livePath, JSON.stringify(live));
  await writeFile(join(directory, 'catalog/candidate.json'), JSON.stringify(candidate));
  await writeFile(join(directory, 'catalog/initial-plugins.json'), JSON.stringify({
    schemaVersion: 1, plugins: [{ pluginId: 'official.example', enabled: true }],
  }));
  await writeFile(join(directory, '.github/workflows/contract-ci.yml'), `jobs:
  publish:
    steps:
      - uses: ./.github/actions/publish-prerelease
        with:
          package-directory: packages/plugin-contract
      - uses: ./.github/actions/publish-prerelease
        with:
          package-directory: packages/plugin-sdk
      - uses: ./.github/actions/publish-prerelease
        with:
          package-directory: packages/example
`);
  const options = { root: directory,
    registryIntegrity: async (name, version) => published.get(`${name}@${version}`),
    readArchive: async url => { assert.ok(archives.has(url), `archive unavailable: ${url}`); return archives.get(url); },
    packCurrentPackage: async path => {
      const artifact = path.endsWith('plugin-contract') ? core : path.endsWith('plugin-sdk') ? sdk : next;
      return { name: artifact.packageName, version: artifact.version, integrity: artifact.integrity };
    } };
  return {
    directory, livePath, live, candidate, previous, next, core, sdk,
    archives, published, options, archive, entry,
  };
}

async function addPendingSibling(f) {
  const previous = await f.archive('@clowder-ai/sibling', '0.1.0-alpha.1');
  const next = await f.archive('@clowder-ai/sibling', '0.1.0-alpha.2');
  f.live.plugins.push(f.entry('official.sibling', [previous]));
  f.candidate.plugins.push(f.entry('official.sibling', [next, previous]));
  await writeFile(f.livePath, JSON.stringify(f.live));
  await writeFile(join(f.directory, 'catalog/candidate.json'), JSON.stringify(f.candidate));
  return { previous, next };
}

for (const missing of ['all', 'plugin', 'sdk']) {
  test(`a ${missing === 'all' ? 'paused' : 'partially failed'} publication (${missing}) leaves live discovery unchanged`, async t => {
    const f = await fixture(t), before = await readFile(f.livePath, 'utf8');
    if (missing === 'all') f.published.clear();
    else {
      const artifact = missing === 'sdk' ? f.sdk : f.next;
      f.published.delete(`${artifact.packageName}@${artifact.version}`);
    }
    await assert.rejects(activateCatalog(f.options), /complete publication batch/);
    assert.equal(await readFile(f.livePath, 'utf8'), before);
  });
}

test('metadata without a retrievable archive cannot activate the catalog', async t => {
  const f = await fixture(t), before = await readFile(f.livePath, 'utf8');
  f.archives.delete(f.next.tarballUrl);
  await assert.rejects(activateCatalog(f.options), /archive unavailable/);
  assert.equal(await readFile(f.livePath, 'utf8'), before);
});

test('activation refuses a default identity absent from its candidate without writing discovery', async t => {
  const f = await fixture(t), before = await readFile(f.livePath, 'utf8');
  await writeFile(join(f.directory, 'catalog/initial-plugins.json'), JSON.stringify({
    schemaVersion: 1, plugins: [{ pluginId: 'official.unpublished-meeting', enabled: true }],
  }));
  await assert.rejects(activateCatalog(f.options), /Initial plugin is absent from catalog: official.unpublished-meeting/);
  assert.equal(await readFile(f.livePath, 'utf8'), before);
});

test('disabled defaults still require a release and duplicate identities are rejected', async t => {
  const f = await fixture(t);
  const selection = plugins => ({ schemaVersion: 1, plugins });
  assert.equal(assertInitialPluginSelectionAvailable(selection([
    { pluginId: 'official.example', enabled: false },
  ]), f.live), 1);
  assert.throws(() => assertInitialPluginSelectionAvailable(selection([
    { pluginId: 'official.unpublished-meeting', enabled: false },
  ]), f.live), /Initial plugin is absent from catalog/);
  assert.throws(() => assertInitialPluginSelectionAvailable(selection([
    { pluginId: 'official.example', enabled: true }, { pluginId: 'official.example', enabled: false },
  ]), f.live), /Duplicate initial plugin/);
});

test('a concurrent initial selection edit does not activate stale admission evidence', async t => {
  const f = await fixture(t), before = await readFile(f.livePath, 'utf8');
  let edited = false;
  await assert.rejects(activateCatalog({ ...f.options, readArchive: async url => {
    if (!edited) {
      edited = true;
      await writeFile(join(f.directory, 'catalog/initial-plugins.json'), JSON.stringify({
        schemaVersion: 1, plugins: [{ pluginId: 'official.unpublished-meeting', enabled: true }],
      }));
    }
    return f.options.readArchive(url);
  } }), /Initial selection changed/);
  assert.equal(await readFile(f.livePath, 'utf8'), before);
});

test('a mismatching actual tarball blocks activation even if registry metadata claims the expected digest', async t => {
  const f = await fixture(t), before = await readFile(f.livePath, 'utf8');
  f.archives.set(f.next.tarballUrl, Buffer.from('corrupt archive'));
  await assert.rejects(activateCatalog(f.options), /archive integrity mismatch/);
  assert.equal(await readFile(f.livePath, 'utf8'), before);
});

test('a core dependency with missing bytes blocks activation after plugins have published', async t => {
  const f = await fixture(t), before = await readFile(f.livePath, 'utf8');
  f.archives.delete(f.core.tarballUrl);
  await assert.rejects(activateCatalog(f.options), /archive unavailable/);
  assert.equal(await readFile(f.livePath, 'utf8'), before);
});

test('a complete published batch updates discovery without changing staged source', async t => {
  const f = await fixture(t);
  const staged = await readFile(join(f.directory, 'catalog/candidate.json'), 'utf8');
  await activateCatalog(f.options);
  assert.deepEqual(JSON.parse(await readFile(f.livePath, 'utf8')), f.candidate);
  assert.equal(await readFile(join(f.directory, 'catalog/candidate.json'), 'utf8'), staged);
  await activateCatalog(f.options); // Retry is idempotent without publishing or replacing archives.
  assert.equal(await assertCatalogAvailable(f.candidate, f.options), 1);
});

test('scoped activation advances only the selected plugin and keeps other pending work staged', async t => {
  const f = await fixture(t);
  await addPendingSibling(f);
  const siblingBefore = structuredClone(f.live.plugins[1]);

  await activateCatalog({ ...f.options, pluginIds: ['official.example'] });

  const activated = JSON.parse(await readFile(f.livePath, 'utf8'));
  assert.deepEqual(activated.plugins[0], f.candidate.plugins[0]);
  assert.deepEqual(activated.plugins[1], siblingBefore);
  assertCatalogActivated(f.candidate, activated, ['official.example']);
  assert.throws(
    () => assertCatalogActivated(f.candidate, activated),
    /official\.sibling@0\.1\.0-alpha\.2/u,
  );
});

test('an unpublished unselected candidate does not block scoped activation', async t => {
  const f = await fixture(t);
  const sibling = await addPendingSibling(f);
  f.published.delete(`${sibling.next.packageName}@${sibling.next.version}`);
  f.archives.delete(sibling.next.tarballUrl);

  await activateCatalog({ ...f.options, pluginIds: ['official.example'] });

  const activated = JSON.parse(await readFile(f.livePath, 'utf8'));
  assert.equal(activated.plugins[0].versions[0].version, f.next.version);
  assert.equal(activated.plugins[1].versions[0].version, sibling.previous.version);
});

test('an unpublished selected plugin blocks scoped activation without writing', async t => {
  const f = await fixture(t), before = await readFile(f.livePath, 'utf8');
  f.published.delete(`${f.next.packageName}@${f.next.version}`);

  await assert.rejects(
    activateCatalog({ ...f.options, pluginIds: ['official.example'] }),
    /live catalog requires a published immutable identity/u,
  );
  assert.equal(await readFile(f.livePath, 'utf8'), before);
});

test('mismatching selected archive bytes block scoped activation without writing', async t => {
  const f = await fixture(t), before = await readFile(f.livePath, 'utf8');
  f.archives.set(f.next.tarballUrl, Buffer.from('corrupt archive'));

  await assert.rejects(
    activateCatalog({ ...f.options, pluginIds: ['official.example'] }),
    /archive integrity mismatch/u,
  );
  assert.equal(await readFile(f.livePath, 'utf8'), before);
});

test('an empty scoped selector is rejected without writing', async t => {
  const f = await fixture(t), before = await readFile(f.livePath, 'utf8');

  await assert.rejects(
    activateCatalog({ ...f.options, pluginIds: [] }),
    /at least one plugin id/u,
  );
  assert.equal(await readFile(f.livePath, 'utf8'), before);
});

test('scoped activation adds a selected candidate-only plugin in candidate order', async t => {
  const f = await fixture(t);
  const added = await f.archive('@clowder-ai/new-plugin', '0.1.0-alpha.1');
  f.candidate.plugins.push(f.entry('official.new-plugin', [added]));
  await writeFile(
    join(f.directory, 'catalog/candidate.json'),
    JSON.stringify(f.candidate),
  );

  await activateCatalog({ ...f.options, pluginIds: ['official.new-plugin'] });

  const activated = JSON.parse(await readFile(f.livePath, 'utf8'));
  assert.deepEqual(
    activated.plugins.map(plugin => plugin.pluginId),
    ['official.example', 'official.new-plugin'],
  );
  assert.deepEqual(activated.plugins[0], f.live.plugins[0]);
  assert.deepEqual(activated.plugins[1], f.candidate.plugins[1]);
});

test('scoped activation rejects missing and duplicate plugin selectors without writing', async t => {
  const f = await fixture(t);
  const before = await readFile(f.livePath, 'utf8');
  await assert.rejects(
    activateCatalog({ ...f.options, pluginIds: ['official.missing'] }),
    /Selected plugin is absent from candidate: official\.missing/u,
  );
  await assert.rejects(
    activateCatalog({ ...f.options, pluginIds: ['official.example', 'official.example'] }),
    /Duplicate selected plugin: official\.example/u,
  );
  assert.equal(await readFile(f.livePath, 'utf8'), before);
});

test('scoped activation preserves a concurrent live edit instead of overwriting it', async t => {
  const f = await fixture(t);
  await addPendingSibling(f);
  const concurrent = JSON.stringify({ ...f.live, plugins: [f.live.plugins[1]] });
  let edited = false;
  await assert.rejects(activateCatalog({
    ...f.options,
    pluginIds: ['official.example'],
    readArchive: async url => {
      if (!edited) {
        edited = true;
        await writeFile(f.livePath, concurrent);
      }
      return f.options.readArchive(url);
    },
  }), /Live catalog changed/u);
  assert.equal(await readFile(f.livePath, 'utf8'), concurrent);
});

test('publication alone does not satisfy the activation completion check', async t => {
  const f = await fixture(t);
  assert.throws(() => assertCatalogActivated(f.candidate, f.live), /official.example@0.1.0-alpha.2/);
  await activateCatalog(f.options);
  assertCatalogActivated(f.candidate, JSON.parse(await readFile(f.livePath, 'utf8')));
});

test('completion detects missing plugins and rewritten selected identities', async t => {
  const f = await fixture(t);
  assert.throws(() => assertCatalogActivated(f.candidate, { ...f.live, plugins: [] }), /official.example/);
  const changed = structuredClone(f.candidate);
  changed.plugins[0].versions[0].artifact.shasum = '0'.repeat(40);
  assert.throws(() => assertCatalogActivated(f.candidate, changed), /official.example/);
});

test('candidate-only history does not create a false activation obligation', async t => {
  const f = await fixture(t);
  const live = structuredClone(f.candidate);
  live.plugins[0].versions.pop();
  assertCatalogActivated(f.candidate, live);
});

test('inactive historical rows do not require publishing old candidates or change the offered current version', async t => {
  const f = await fixture(t);
  f.published.delete(`${f.previous.packageName}@${f.previous.version}`);
  f.archives.delete(f.previous.tarballUrl);
  await activateCatalog(f.options);
  assert.equal(await assertCatalogAvailable(f.candidate, f.options), 1);
  assert.deepEqual(JSON.parse(await readFile(f.livePath, 'utf8')).plugins[0].versions[1],
    f.live.plugins[0].versions[0]);
});

test('activation cannot delete or rewrite an existing immutable release', async t => {
  const f = await fixture(t), before = await readFile(f.livePath, 'utf8');
  f.candidate.plugins[0].versions.pop();
  await writeFile(join(f.directory, 'catalog/candidate.json'), JSON.stringify(f.candidate));
  await assert.rejects(activateCatalog(f.options), /cannot remove or rewrite/);
  assert.equal(await readFile(f.livePath, 'utf8'), before);
});

test('digest verification also checks the tarball package identity', async t => {
  const f = await fixture(t);
  assert.throws(() => assertPublishedArchive(f.archives.get(f.next.tarballUrl),
    { ...f.next, packageName: '@clowder-ai/other' }), /package name mismatch/);
});

test('candidate changes during verification do not overwrite the active catalog', async t => {
  const f = await fixture(t), before = await readFile(f.livePath, 'utf8');
  let changed = false;
  await assert.rejects(activateCatalog({ ...f.options, readArchive: async url => {
    if (!changed) { changed = true; await writeFile(join(f.directory, 'catalog/candidate.json'), '{}'); }
    return f.options.readArchive(url);
  } }), /Candidate changed/);
  assert.equal(await readFile(f.livePath, 'utf8'), before);
});

test('a concurrent catalog edit is preserved instead of being overwritten by activation', async t => {
  const f = await fixture(t);
  const changed = JSON.stringify({ ...f.live, plugins: [] });
  let edited = false;
  await assert.rejects(activateCatalog({ ...f.options, readArchive: async url => {
    if (!edited) { edited = true; await writeFile(f.livePath, changed); }
    return f.options.readArchive(url);
  } }), /Live catalog changed/);
  assert.equal(await readFile(f.livePath, 'utf8'), changed);
});

test('the ordinary npm publication job never activates live discovery', async () => {
  const workflow = parse(await readFile(new URL('../.github/workflows/contract-ci.yml', import.meta.url), 'utf8'));
  for (const step of workflow.jobs.publish.steps) {
    assert.doesNotMatch(step.run ?? '', /catalog:activate|catalog-activation\.mjs\s+--activate/);
  }
  assert.equal(workflow.jobs.publish.steps.at(-1).run, 'pnpm catalog:activation-check');
});

test('manual npm publication is covered by a scheduled read-only activation audit', async () => {
  const audit = parse(await readFile(new URL('../.github/workflows/catalog-activation.yml', import.meta.url), 'utf8'));
  assert.ok(audit.on.workflow_dispatch);
  assert.ok(audit.on.schedule.length > 0);
  assert.deepEqual(audit.permissions, { contents: 'read' });
  assert.equal(audit.jobs.activation.steps.at(-1).run, 'pnpm catalog:activation-check');
});
