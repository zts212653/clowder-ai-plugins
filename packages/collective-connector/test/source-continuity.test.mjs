import assert from 'node:assert/strict';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import * as entrypoint from '../dist/index.js';
import { loadCollectiveClient } from '../dist/client-assets.js';

const assets = new URL('../assets/client/', import.meta.url);

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

test('the runtime refuses altered client bytes instead of serving them', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'collective-asset-integrity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(assets, directory, { recursive: true });
  await writeFile(join(directory, 'index.html'), 'altered client');
  await assert.rejects(loadCollectiveClient(pathToFileURL(directory + '/')), /digest mismatch/);
});
