import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import * as entrypoint from '../dist/index.js';
import { loadCollectiveClient } from '../dist/client-assets.js';

const assets = new URL('../assets/client/', import.meta.url);
const sha256 = value => createHash('sha256').update(value).digest('hex');

test('public package exports only its module factory and default entrypoint', () => {
  assert.deepEqual(Object.keys(entrypoint).sort(), ['createCollectivePluginModule', 'default']);
  assert.equal(typeof entrypoint.default.create, 'function');
  assert.equal(typeof entrypoint.createCollectivePluginModule, 'function');
});

test('the runtime asset loader verifies the current packaged client', async () => {
  const client = await loadCollectiveClient(assets);
  assert.ok(client.files.has('/index.html'));
  assert.ok(client.files.has('/collective-client/app.js'));
  assert.match(client.files.get('/index.html').bytes.toString('utf8'), /collective-client\/app\.js/);
});

test('the retained client records verifiable source and generated-byte provenance', async () => {
  const source = JSON.parse(await readFile(new URL('source.json', assets), 'utf8'));
  const manifestBytes = await readFile(new URL('manifest.json', assets));
  const buildInputsBytes = await readFile(new URL('build-inputs.json', assets));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const buildInputs = JSON.parse(buildInputsBytes.toString('utf8'));
  const dependencyInputs = buildInputs.inputs.filter(input => input.path.includes('/node_modules/.pnpm/'));
  const sourceInputs = buildInputs.inputs.filter(input => !input.path.includes('/node_modules/.pnpm/'));

  assert.match(source.repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);
  assert.match(source.sourceBaseHead, /^[a-f0-9]{40}$/u);
  assert.equal(source.package, 'packages/collective-client');
  assert.equal(source.buildEntrypoint, 'packages/collective-client/scripts/build.mjs#buildRetainedClient');
  assert.equal(source.manifestSha256, sha256(manifestBytes));
  assert.equal(source.buildInputsSha256, sha256(buildInputsBytes));
  assert.equal(source.sourceCheckedInputCount, sourceInputs.length);
  assert.equal(source.dependencyInputCount, dependencyInputs.length);
  assert.equal(source.totalInputCount, buildInputs.inputs.length);
  assert.equal(source.sourceCheckedInputCount + source.dependencyInputCount, source.totalInputCount);
  const sanitizerInput = dependencyInputs.find(input =>
    input.path.includes('/node_modules/.pnpm/dompurify@') && input.path.includes('/node_modules/dompurify/'),
  );
  assert.ok(sanitizerInput, 'retained Client must record its DOMPurify build input');
  assert.equal(
    sanitizerInput.path.match(/\/\.pnpm\/dompurify@([^/]+)\/node_modules\/dompurify\//u)?.[1],
    source.sourceLockBindings['packages/ui:dompurify'],
    'retained Client sanitizer must match the packages/ui source-lock binding',
  );
  assert.equal(
    source.assetDigest,
    sha256(JSON.stringify(manifest.files.map(({ path, size, sha256: fileSha }) => ({ path, size, sha256: fileSha })))),
  );
  assert.ok(['exact-source-head', 'base-with-recorded-input-overrides'].includes(source.sourceState));
  if (source.sourceState === 'exact-source-head') assert.deepEqual(source.inputOverrides ?? [], []);
  else assert.ok(Array.isArray(source.inputOverrides) && source.inputOverrides.length > 0);
});

test('the runtime refuses altered client bytes instead of serving them', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'collective-asset-integrity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(assets, directory, { recursive: true });
  await writeFile(join(directory, 'index.html'), 'altered client');
  await assert.rejects(loadCollectiveClient(pathToFileURL(`${directory}/`)), /digest mismatch/);
});
