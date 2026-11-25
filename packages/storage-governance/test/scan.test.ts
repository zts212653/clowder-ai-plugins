import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import plugin from '../src/index.js';
import { scanStorage, type Sources } from '../src/scan.js';

test('counts a shared file once while preserving paths, session references, and skipped junctions', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'storage-governance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const threads = join(root, 'threads');
  const session = join(threads, 'one');
  await mkdir(session, { recursive: true });
  const file = join(session, 'events.jsonl');
  const alias = join(root, 'alias.log');
  await writeFile(file, '123456789');
  await link(file, alias);
  await symlink(session, join(root, 'junction'), 'junction');

  const input: Sources = {
    roots: [
      { path: root, category: 'worktree' },
      { path: threads, category: 'transcript' },
      { path: session, category: 'transcript', threadId: 'one' },
    ],
    files: [{ path: file, category: 'transcript', threadId: 'also' }],
    threads: [{ id: 'one', title: 'Conversation' }, { id: 'also', title: null }],
    nativeSessions: [],
    omissions: [],
  };
  const result = await scanStorage(input, new AbortController().signal);
  assert.equal(result.volumes.length, 1);
  assert.equal(result.volumes[0].fileCount, 2);
  assert.equal(result.volumes[0].uniqueFiles, 1);
  assert.equal(result.volumes[0].logicalBytes, 9);
  assert.equal(result.categories.reduce((sum, item) => sum + item.logicalBytes, 0), 9);
  const row = result.files.find((row) => row.path === file);
  assert.deepEqual(row?.threadIds, ['also', 'one']);
  assert.equal(row?.category, 'transcript');
  assert.equal(result.files.filter((row) => row.duplicateOf).length, 1);
  assert.equal(result.omissions.find((row) => row.path.endsWith('junction'))?.reason, 'link-or-mount');
});

test('requires the owning instance and pages an asynchronous scan only for its requester', async () => {
  let finish!: (input: Sources) => void;
  const sources = new Promise<Sources>((resolve) => { finish = resolve; });
  const handle = plugin.create().start({ pluginInstanceId: 'fixture', conversationStorage: {
    startRead: () => sources,
  } });
  const action = handle.actions['storage-governance.scan'];
  const owner = { kind: 'owner-http-request' as const, operation: 'write' as const,
    userId: 'a', pluginInstanceId: 'fixture', async assertCurrent() {} };
  const request = (method: string) => ({ request: { method } });
  assert.equal((await action(request('POST'))).status, 403);
  const start = action(request('POST'), undefined, owner);
  assert.equal(JSON.parse((await action(request('GET'), undefined, { ...owner, userId: 'b', operation: 'read' })).body).state, 'idle');
  finish({ roots: [], files: [], threads: [], omissions: [], nativeSessions: [] });
  assert.equal(JSON.parse((await start).body).state, 'running');
  await new Promise<void>((resolve) => setImmediate(resolve));
  const result = JSON.parse((await action(request('GET'), undefined, { ...owner, operation: 'read' })).body);
  assert.equal(result.state, 'ready');
  assert.equal(result.total, 0);
  handle.stop();
});
