import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { dirname, join } from 'node:path';
import { scanStorage, type Sources } from '../src/scan.js';

async function fixture(t: TestContext, files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'storage-attribution-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  return root;
}

function scan(sources: Sources) {
  return scanStorage(sources, new AbortController().signal);
}

test('attributes Codex native and archived sessions by their native session id', async (t) => {
  const native = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const root = await fixture(t, {
    [`sessions/2026/11/25/rollout-2026-11-25T10-00-00-${native}.jsonl.zst`]: 'native',
    [`archived_sessions/rollout-2026-11-24T09-00-00-${native}.jsonl`]: 'archived',
  });
  const result = await scan({
    threads: [{ id: 'thread-a', title: 'A' }],
    roots: [
      { path: join(root, 'sessions'), category: 'native-session' },
      { path: join(root, 'archived_sessions'), category: 'native-session' },
    ],
    files: [],
    nativeSessions: [{ id: native, threadId: 'thread-a' }],
    omissions: [],
  });
  assert.equal(result.files.length, 2);
  for (const row of result.files) assert.deepEqual(row.threadIds, ['thread-a']);
});

test('attributes Claude project files and DSH session directories', async (t) => {
  const claude = 'cccccccc-dddd-4eee-8fff-111111111111';
  const dsh = 'dddddddd-eeee-4fff-8aaa-222222222222';
  const root = await fixture(t, {
    [`claude/projects/--C-project--/${claude}.jsonl`]: 'claude',
    [`dsh/sessions/${dsh}/session.v4.jsonl.zst`]: 'dsh',
  });
  const result = await scan({
    threads: [
      { id: 'thread-claude', title: 'Claude' },
      { id: 'thread-dsh', title: 'DSH' },
    ],
    roots: [
      { path: join(root, 'claude/projects'), category: 'native-session' },
      { path: join(root, 'dsh/sessions'), category: 'native-session' },
    ],
    files: [],
    nativeSessions: [
      { id: claude, threadId: 'thread-claude' },
      { id: dsh, threadId: 'thread-dsh' },
    ],
    omissions: [],
  });
  const byThread = new Map(result.files.map((row) => [row.threadIds[0], row]));
  assert.equal(byThread.get('thread-claude')?.category, 'native-session');
  assert.equal(byThread.get('thread-dsh')?.category, 'native-session');
});

test('attributes Kimi session_ directories and Pi timestamped sessions', async (t) => {
  const kimi = 'eeeeeeee-ffff-4aaa-8bbb-333333333333';
  const pi = 'ffffffff-aaaa-4bbb-8ccc-444444444444';
  const root = await fixture(t, {
    [`kimi/sessions/wd_project/session_${kimi}/agents/main/wire.jsonl`]: 'kimi',
    [`pi/sessions/--G--project--/2026-11-25T10-00-00-000Z_${pi}.jsonl`]: 'pi',
  });
  const result = await scan({
    threads: [
      { id: 'thread-kimi', title: 'Kimi' },
      { id: 'thread-pi', title: 'Pi' },
    ],
    roots: [
      { path: join(root, 'kimi/sessions'), category: 'native-session' },
      { path: join(root, 'pi/sessions'), category: 'native-session' },
    ],
    files: [],
    nativeSessions: [
      { id: kimi, threadId: 'thread-kimi' },
      { id: pi, threadId: 'thread-pi' },
    ],
    omissions: [],
  });
  const byThread = new Map(result.files.map((row) => [row.threadIds[0], row]));
  assert.equal(byThread.get('thread-kimi')?.category, 'native-session');
  assert.equal(byThread.get('thread-pi')?.category, 'native-session');
});

test('keeps an unregistered historical session as unassigned instead of inventing a thread', async (t) => {
  const root = await fixture(t, {
    'archived_sessions/rollout-2026-11-20T09-00-00-bbbbbbbb-cccc-4ddd-8eee-ffffffffffff.jsonl': 'old',
  });
  const result = await scan({
    threads: [{ id: 'thread-a', title: 'A' }],
    roots: [{ path: join(root, 'archived_sessions'), category: 'native-session' }],
    files: [],
    nativeSessions: [],
    omissions: [],
  });
  assert.equal(result.files.length, 1);
  assert.deepEqual(result.files[0]?.threadIds, []);
});

test('inherits attachments and works from exact sources and worktree roots', async (t) => {
  const root = await fixture(t, {
    'uploads/note.png': 'attachment',
    'works/fixed-version.bin': 'work',
    'worktrees/pr-2065/src/index.ts': 'source',
  });
  const result = await scan({
    threads: [{ id: 'thread-b', title: 'B' }],
    roots: [
      { path: join(root, 'uploads'), category: 'attachment' },
      { path: join(root, 'works'), category: 'work' },
      { path: join(root, 'worktrees/pr-2065'), category: 'worktree', threadId: 'thread-b' },
    ],
    files: [
      { path: join(root, 'uploads/note.png'), category: 'attachment', threadId: 'thread-b' },
      { path: join(root, 'works/fixed-version.bin'), category: 'work', threadId: 'thread-b' },
    ],
    nativeSessions: [],
    omissions: [],
  });
  const byName = new Map(result.files.map((row) => [row.path.split(/[\\/]/).pop(), row]));
  assert.deepEqual(byName.get('note.png')?.threadIds, ['thread-b']);
  assert.deepEqual(byName.get('fixed-version.bin')?.threadIds, ['thread-b']);
  assert.deepEqual(byName.get('index.ts')?.threadIds, ['thread-b']);
});

test('keeps git objects shared when no conversation claims them', async (t) => {
  const root = await fixture(t, {
    '.git/objects/aa/hash': 'git',
  });
  const result = await scan({
    threads: [{ id: 'thread-c', title: 'C' }],
    roots: [{ path: join(root, '.git/objects'), category: 'git' }],
    files: [],
    nativeSessions: [],
    omissions: [],
  });
  assert.equal(result.files.length, 1);
  assert.deepEqual(result.files[0]?.threadIds, []);
});
