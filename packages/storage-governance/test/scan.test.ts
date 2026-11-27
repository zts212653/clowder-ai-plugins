import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import plugin from '../src/index.js';
import { indexStorage, pageStorage } from '../src/pages.js';
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
  assert.equal(row?.worktreePath, root);
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

test('shows registered worktree directories with deduplicated totals and lazy file pages', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'storage-worktrees-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const worktree = join(base, 'checkout-a');
  const nested = join(worktree, 'nested');
  const sibling = join(base, 'checkout-ab');
  await Promise.all([mkdir(nested, { recursive: true }), mkdir(sibling, { recursive: true })]);
  const snapshot = join(worktree, 'ram.img');
  const attachment = join(worktree, 'attached.txt');
  const nestedFile = join(nested, 'nested.bin');
  const unownedFile = join(sibling, 'unknown.txt');
  const alias = join(worktree, 'snapshot-alias.img');
  await Promise.all([
    writeFile(snapshot, 'abcdef'),
    writeFile(attachment, 'hi'),
    writeFile(nestedFile, '123'),
    writeFile(unownedFile, 'x'),
    writeFile(join(worktree, '.git'), 'excluded Git link'),
  ]);
  await link(snapshot, alias);
  const result = await scanStorage({
    roots: [
      { path: worktree, category: 'worktree', threadId: 'one' },
      { path: nested, category: 'worktree', threadId: 'nested' },
      { path: sibling, category: 'worktree' },
    ],
    files: [{ path: attachment, category: 'attachment', threadId: 'extra' }],
    threads: [{ id: 'one', title: 'Source' }],
    nativeSessions: [],
    omissions: [],
  }, new AbortController().signal);
  const index = indexStorage(result);
  const all = pageStorage(index, { view: 'worktrees' });
  assert.ok(all && 'worktrees' in all);
  assert.equal(all.total, 3);
  assert.ok('threads' in all && all.threads.length === 1);
  const group = all.worktrees.find((row) => row.path === worktree);
  assert.equal(group?.fileCount, 3);
  assert.equal(group?.uniqueFiles, 2);
  assert.equal(group?.logicalBytes, 8);
  assert.deepEqual(group?.threadIds, ['extra', 'one']);

  const opened = pageStorage(index, { view: 'files', worktreePath: worktree, category: 'worktree', summary: false });
  assert.ok(opened && 'files' in opened);
  assert.ok(!('threads' in opened) && !('categories' in opened) && !('selection' in opened));
  assert.equal(opened.worktree?.path, worktree);
  assert.deepEqual(opened.files.map((row) => row.path).sort(), [alias, attachment, snapshot].sort());
  assert.ok(opened.files.every((row) => row.worktreePath === worktree));
  const search = pageStorage(index, { view: 'worktrees', query: 'checkout-a', offset: 1, limit: 1, summary: false });
  assert.ok(search && 'worktrees' in search);
  assert.equal(search.total, 3);
  assert.equal(search.nextOffset, 2);

  const unassigned = pageStorage(index, { threadId: '__unknown__', category: 'worktree', summary: false });
  assert.ok(unassigned && 'files' in unassigned);
  assert.deepEqual(unassigned.files.map((row) => row.path), [unownedFile]);
  assert.equal(pageStorage(index, { worktreePath: base })?.total, 0);
});

test('separates a real linked checkout nested below a registered repository', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'storage-linked-worktree-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const child = join(root, 'worktrees', 'linked checkout');
  const registration = join(root, '.git', 'worktrees', 'linked-checkout');
  const image = join(child, 'ram.img');
  const main = join(root, 'main.txt');
  await Promise.all([mkdir(registration, { recursive: true }), mkdir(child, { recursive: true })]);
  await Promise.all([
    writeFile(join(registration, 'gitdir'), join(child, '.git') + '\n'),
    writeFile(join(child, '.git'), 'gitdir: ' + registration + '\n'),
    writeFile(main, 'main'),
    writeFile(image, 'snapshot'),
  ]);
  const scanned = await scanStorage({
    roots: [{ path: root, category: 'worktree', threadId: 'owner' }],
    files: [],
    threads: [{ id: 'owner', title: null }],
    nativeSessions: [],
    omissions: [],
  }, new AbortController().signal);
  assert.equal(scanned.files.find((row) => row.path === image)?.worktreePath, child);
  assert.equal(scanned.files.find((row) => row.path === main)?.worktreePath, root);
  assert.equal(scanned.files.length, 2);
  assert.deepEqual(indexStorage(scanned).worktrees.map((row) => row.path).sort(), [root, child].sort());
});
