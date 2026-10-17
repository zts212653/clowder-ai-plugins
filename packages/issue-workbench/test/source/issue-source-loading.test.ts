import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FileIssueSourceStore } from '../../src/source/FileIssueSourceStore.js';
import { createGhIssueSourceReader } from '../../src/source/GhIssueSourceReader.js';
import { IssueSourceService } from '../../src/source/IssueSourceService.js';

const date = '2026-10-12T00:00:00Z';
const fact = {
  number: 1,
  title: 'one',
  url: 'https://github.com/test/repo/issues/1',
  state: 'OPEN',
  labels: [],
  updatedAt: date,
  fetchedAt: date,
  body: 'original evidence',
  bodyHTML: '<p>original evidence</p>',
  comments: [],
  commentCount: 0,
};
const snapshot = {
  repo: 'test/repo',
  revision: 1,
  fetchedAt: date,
  issues: [fact],
  failures: [],
  summary: { added: 0, changed: 0, closed: 0, reopened: 0 },
};
test('catalog excludes prose; exact archive survives later edits and restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'source-loading-'));
  try {
    const store = new FileIssueSourceStore(dir);
    await store.write(snapshot);
    const catalog = await store.read('test/repo');
    assert.equal(catalog!.issues[0].body, undefined);
    assert.equal(catalog!.issues[0].comments, undefined);
    const first = await store.readDetail('test/repo', 1);
    assert.equal(first!.body, 'original evidence');
    await store.write({ ...snapshot, revision: 2, issues: [{ ...fact, body: 'edited evidence' }] });
    const reopened = new FileIssueSourceStore(dir);
    assert.equal((await reopened.readDetail('test/repo', 1, first!.detailVersion))!.body, 'original evidence');
    assert.equal((await reopened.readDetail('test/repo', 1))!.body, 'edited evidence');
    assert.equal((await reopened.readDetail('test/repo', 1))!.bodyHTML, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('catalog query omits prose and comment nodes but preserves counts', async () => {
  const reader = createGhIssueSourceReader(async (query) => {
    assert.doesNotMatch(query, /body|bodyHTML|lastEditedAt/);
    return {
      repository: {
        issues: {
          nodes: [
            {
              ...fact,
              author: { login: 'a' },
              labels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
              comments: { totalCount: 22 },
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    } as never;
  });
  const result = await reader('test/repo', undefined, undefined, 'catalog');
  assert.equal(result.complete, true);
  assert.equal(result.issues[0].commentCount, 22);
  assert.equal(result.issues[0].comments, undefined);
});
test('failed detail refresh retains complete source and its checked time', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'source-loading-'));
  try {
    const store = new FileIssueSourceStore(dir);
    await store.write(snapshot);
    const service = new IssueSourceService(store, async () => ({
      issues: [],
      complete: false,
      failures: [{ kind: 'network', message: 'offline' }],
    }));
    const result = await service.refreshDetail('test/repo', 1);
    assert.equal(result.detail!.body, 'original evidence');
    assert.equal(result.detail!.fetchedAt, date);
    assert.equal(result.failures.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('legacy migration retains original file and deduplicates identical source versions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'source-loading-'));
  try {
    const { createHash } = await import('node:crypto');
    const { writeFile, readFile, readdir } = await import('node:fs/promises');
    const key = createHash('sha256').update('test/repo').digest('hex');
    const raw = JSON.stringify(snapshot);
    await writeFile(join(dir, `${key}.json`), raw);
    const store = new FileIssueSourceStore(dir);
    await store.read('test/repo');
    await store.write({ ...snapshot, revision: 2 });
    assert.equal(await readFile(join(dir, `${key}.json`), 'utf8'), raw);
    const files = await readdir(join(dir, key, '1'));
    assert.equal(files.length, 1);
    assert.match(files[0], /\.json\.gz$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('detail-only query omits list and rendered HTML and checks the whole selected discussion', async () => {
  const reader = createGhIssueSourceReader(async (query) => {
    assert.doesNotMatch(query, /issues\(first|bodyHTML|\$cursor/);
    assert.match(query, /focus:issue\(number:1\)/);
    return {
      repository: {
        focus: {
          ...fact,
          author: { login: 'a' },
          labels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          comments: { nodes: [], totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null } },
        },
      },
    } as never;
  });
  const result = await reader('test/repo', undefined, 1, 'detail');
  assert.equal(result.complete, true);
  assert.equal(result.issues[0].body, fact.body);
});
test('a late legacy migration cannot replace a newer catalog', async () => {
  const { createHash } = await import('node:crypto');
  const { writeFile } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'source-loading-'));
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((r) => {
    enter = r;
  });
  const blocked = new Promise<void>((r) => {
    release = r;
  });
  class DelayedStore extends FileIssueSourceStore {
    calls = 0;
    override async write(value: typeof snapshot, onlyIfMissing = false) {
      if (++this.calls === 1) {
        enter();
        await blocked;
      }
      await super.write(value, onlyIfMissing);
    }
  }
  try {
    const key = createHash('sha256').update('test/repo').digest('hex');
    await writeFile(join(dir, `${key}.json`), JSON.stringify(snapshot));
    const store = new DelayedStore(dir);
    const first = store.read('test/repo');
    await entered;
    await store.read('test/repo');
    await store.write({ ...snapshot, revision: 9, issues: [{ ...fact, body: 'newer source' }] });
    release();
    await first;
    assert.equal((await store.read('test/repo'))?.revision, 9);
    assert.equal((await store.readDetail('test/repo', 1))?.body, 'newer source');
  } finally {
    release();
    await rm(dir, { recursive: true, force: true });
  }
});
