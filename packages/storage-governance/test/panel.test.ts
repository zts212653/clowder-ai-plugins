import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import plugin from '../dist/index.js';

const owner = (operation: 'read' | 'write') => ({
  kind: 'owner-http-request' as const,
  userId: 'owner',
  pluginInstanceId: 'fixture',
  operation,
  assertCurrent: async () => {},
});

async function start() {
  return plugin.create().start({ pluginInstanceId: 'fixture', log: () => {} });
}

test('serves the built read-only page only to its owner', async () => {
  const active = await start();
  const page = await active.actions['storage-governance.panel'](
    { request: { method: 'GET', path: 'panel' } },
    undefined,
    owner('read'),
  );
  assert.equal(page.status, 200);
  assert.match(page.body, /存储空间治理/u);
  assert.match(page.body, /clowder-plugin-ui\/v1/u);
  assert.doesNotMatch(page.body, /<script[^>]+src=/iu);
  assert.doesNotMatch(page.body, /https?:\/\/(?!127\.0\.0\.1)/iu);

  const rejected = await active.actions['storage-governance.panel'](
    { request: { method: 'GET', path: 'panel' } },
    undefined,
    { ...owner('read'), pluginInstanceId: 'other' },
  );
  assert.equal(rejected.status, 403);
});

test('reports the missing Host capability instead of guessing paths', async () => {
  const active = await start();
  const response = await active.actions['storage-governance.scan'](
    { request: { method: 'POST', path: 'scan', query: {} } },
    undefined,
    owner('write'),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), { state: 'error', error: 'host-capability-unavailable' });
});

test('the built page stays a single self-contained document', async () => {
  const html = await readFile(new URL('../dist/page.html', import.meta.url), 'utf8');
  assert.match(html, /<style>/u);
  assert.match(html, /id="scan-btn"/u);
  assert.match(html, /id="files-table"/u);
});
