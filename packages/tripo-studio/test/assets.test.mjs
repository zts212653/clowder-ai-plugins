import assert from 'node:assert/strict';
import fs, { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { collectModels, downloadGlb } from '../plugins/tripo-studio/runtime/assets.mjs';
import { exportSelected } from '../plugins/tripo-studio/runtime/export-selected.mjs';

function glb() {
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, meshes: [{ primitives: [] }] }).padEnd(80));
  const b = Buffer.alloc(20 + json.length);
  b.write('glTF');
  b.writeUInt32LE(2, 4);
  b.writeUInt32LE(b.length, 8);
  b.writeUInt32LE(json.length, 12);
  b.writeUInt32LE(0x4e4f534a, 16);
  json.copy(b, 20);
  return b;
}
const asset = 'https://tripo-data-public.rg1.data.tripo3d.com/train.glb?signature=secret';
const focus = { focusedWindowId: 1, activeTabs: [{ windowId: 1, tabId: 2 }] };
const page = 'https://studio.tripo3d.ai/3d-model/train-11111111-1111-4111-8111-111111111111';
const observation = {
  v: 1,
  pageUrl: page,
  title: 'Train',
  resources: [asset],
  before: focus,
  after: focus,
  observedAt: new Date().toISOString(),
};
test('collection binds downloaded bytes and redacts signed queries; selected export verifies digest and never overwrites', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tripo-assets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const report = await collectModels({ observations: [observation] }, root, {
    fetchAsset: async (_url, options) => {
      assert.equal(options.redirect, 'manual');
      assert.equal(options.credentials, 'omit');
      return new Response(glb());
    },
  });
  assert.equal(report.candidates[0].status, 'downloaded');
  assert.ok(!JSON.stringify(report).includes('signature'));
  const receipt = await exportSelected(root, report.batchId, 1, 'chosen.glb');
  assert.deepEqual(await readFile(receipt.file), glb());
  await assert.rejects(exportSelected(root, report.batchId, 1, 'chosen.glb'), { code: 'EEXIST' });
  await assert.rejects(exportSelected(root, report.batchId, 1, '../escape.glb'));
  await writeFile(join(report.directory, report.candidates[0].file), 'changed');
  await assert.rejects(exportSelected(root, report.batchId, 1, 'tampered.glb'), /DIGEST_CHANGED/);
});
test('redirects, HTML, ambiguous models, missing focus and symlink output never become exported models', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tripo-negative-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    downloadGlb(asset, join(root, 'redirect.glb'), {
      fetchAsset: async () => new Response('', { status: 302, headers: { location: 'http://127.0.0.1' } }),
    }),
    /DOWNLOAD_FAILED/,
  );
  await assert.rejects(
    downloadGlb(asset, join(root, 'html.glb'), { fetchAsset: async () => new Response('<html>login</html>') }),
    /INVALID_GLB/,
  );
  await assert.rejects(collectModels({ observations: [{ ...observation, before: null }] }, root), /FOCUS/);
  const report = await collectModels(
    { observations: [{ ...observation, resources: [asset, asset.replace('train', 'other')] }] },
    root,
  );
  assert.equal(report.candidates[0].error, 'AMBIGUOUS_MODEL_RESOURCES');
  await assert.rejects(exportSelected(root, report.batchId, 1, 'unavailable.glb'), /NOT_DOWNLOADED/);
  await symlink(root, join(root, 'link'));
  await assert.rejects(collectModels({ observations: [observation] }, join(root, 'link')), /SYMLINK/);
});

test('export writes the verified snapshot when the source changes immediately after its read', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tripo-export-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const report = await collectModels({ observations: [observation] }, root, {
    fetchAsset: async () => new Response(glb()),
  });
  const source = join(report.directory, report.candidates[0].file);
  const originalRead = fs.readFile;
  const intercepted = t.mock.method(fs, 'readFile', async (path, ...options) => {
    const bytes = await originalRead(path, ...options);
    if (path === source) await writeFile(source, 'changed after validation read');
    return bytes;
  });
  syncBuiltinESMExports();
  t.after(() => {
    intercepted.mock.restore();
    syncBuiltinESMExports();
  });
  const receipt = await exportSelected(root, report.batchId, 1, 'verified-snapshot.glb');
  assert.deepEqual(await readFile(receipt.file), glb());
});
