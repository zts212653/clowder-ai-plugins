import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { Receiver } from '../src/engine.mjs';
import { git } from '../src/process.mjs';
import { createReceiverServer } from '../src/server.mjs';
import { versionPreview } from '../web/version.mjs';
import { versionRepositories } from './version-fixtures.mjs';

async function prepared() {
  const f = await versionRepositories();
  const receiver = new Receiver({ ...f.config, internalWebUrl: 'https://codehub.example/core' });
  await receiver.adopt(f.u0, f.i0);
  await receiver.selectTag('v2.0.0');
  await receiver.start();
  await receiver.prepare();
  return { f, receiver };
}
test('wrong PR can be corrected with an expected old link; candidate and audit survive', async () => {
  const { f, receiver } = await prepared();
  await receiver.linkPr('https://codehub.example/core/pull/999');
  const before = (await receiver.status()).active;
  await receiver.linkPr('https://codehub.example/core/pull/501', { previousUrl: before.prUrl });
  const after = (await receiver.status()).active;
  assert.equal(after.prUrl, 'https://codehub.example/core/pull/501');
  assert.equal(after.candidate, before.candidate);
  assert.equal(after.prHistory[0].url, before.prUrl);
  await assert.rejects(() => receiver.linkPr('https://codehub.example/core/pull/502', { previousUrl: before.prUrl }), {
    code: 'PR_MAPPING_CHANGED',
  });
  await f.merge(after);
  await assert.rejects(() => receiver.linkPr('https://codehub.example/core/pull/502', { previousUrl: after.prUrl }), {
    code: 'PR_ALREADY_MERGED',
  });
  await receiver.recover();
  assert.equal((await receiver.status()).accepted.tag, 'v2.0.0');
});
test('a repository homepage or a foreign PR cannot be registered', async () => {
  const { receiver } = await prepared();
  for (const url of ['https://codehub.example/core', 'https://elsewhere.example/core/pull/1'])
    await assert.rejects(() => receiver.linkPr(url), { code: 'PR_URL_MISMATCH' });
  assert.equal((await receiver.status()).active.prUrl, undefined);
});
test('baseline errors identify all differing files instead of truncating to 100', async () => {
  const f = await versionRepositories();
  for (let index = 0; index < 125; index++) await writeFile(join(f.review, `extra-${index}.txt`), 'private');
  await git(f.review, ['add', '.']);
  await git(f.review, ['commit', '-m', 'additional internal files']);
  await git(f.review, ['push', 'origin', 'main']);
  const head = await git(f.review, ['rev-parse', 'HEAD']);
  const receiver = new Receiver(f.config);
  await assert.rejects(
    () => receiver.adopt(f.u0, head),
    (error) => {
      assert.equal(error.code, 'UNAPPROVED_DIFFERENCE');
      assert.equal(error.details.differences.length, 128);
      assert.equal(error.details.differences.filter((item) => item.blocking).length, 125);
      assert.equal(error.details.upstream, f.u0);
      assert.equal(error.details.internal, head);
      return true;
    },
  );
  assert.equal(await receiver.status(), null);
});
test('version change lists start collapsed and use a searchable bounded file tree', () => {
  const changes = Array.from({ length: 250 }, (_, index) => ({
    path: `src/dir-${index}/file.txt`,
    kind: 'modified',
    category: 'upstream',
  }));
  const html = versionPreview(
    {
      source: { tag: 'v2' },
      base: { upstream: 'a', internal: 'b' },
      target: 'c',
      preview: { changes, internalChanges: [] },
    },
    String,
    String,
  );
  assert.doesNotMatch(html, /<details open>/);
  assert.match(html, /data-file-tree/);
  assert.match(html, /搜索文件/);
});
test('production server never serves or executes a demo, even when passed obsolete options', async () => {
  let merged = false;
  const receiver = {
    config: {},
    status: async () => ({ active: { id: 'a'.repeat(24), status: 'WAITING_APPROVAL' } }),
    store: { locked: (fn) => fn() },
  };
  const server = createReceiverServer(receiver, {
    demoMerge: async () => {
      merged = true;
    },
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const status = await fetch(`${base}/api/status`).then((r) => r.json());
    assert.equal((await fetch(`${base}/demo/pr/${'a'.repeat(24)}`)).status, 404);
    const result = await fetch(`${base}/api/action`, {
      method: 'POST',
      headers: { 'X-Repo-Sync-Token': status.token },
      body: JSON.stringify({ action: 'demo-merge', deliveryId: 'a'.repeat(24) }),
    }).then((r) => r.json());
    assert.equal(result.code, 'UNKNOWN_ACTION');
    assert.equal(merged, false);
  } finally {
    await server.shutdown();
  }
});
