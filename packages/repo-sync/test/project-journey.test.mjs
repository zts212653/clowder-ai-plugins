import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createReceiverServer } from '../src/server.mjs';
import { serverScopes } from '../src/server-projects.mjs';
import { projectView } from '../web/project-view.mjs';

globalThis.location = new URL('http://127.0.0.1/?project=default');
const { recordList, historyDateRange } = await import('../web/history.mjs');

test('project overview filters local state and only offers navigation, including stale observation facts', () => {
  const workspace = {
    projects: [
      { id: 'default', name: '运行项目', mode: 'continuous', syncStatus: 'RUNNING', busy: true },
      {
        id: 'waiting',
        name: '审核项目',
        mode: 'version',
        syncStatus: 'WAITING_REVIEW',
        accepted: { tag: 'v1' },
        lastObservedAt: '2026-10-14T10:00:00Z',
      },
      { id: 'ready', name: '空闲项目', mode: 'version', syncStatus: 'READY' },
    ],
  };
  const html = projectView({ workspace, filter: 'attention', overviewOpen: true }, 'default');
  assert.match(html, /data-project-filter="attention"[^>]*aria-pressed="true"/);
  const cards = /<div class="project-cards">([\s\S]*?)<\/details>/.exec(html)?.[1] ?? '';
  assert.match(cards, /data-project-enter="waiting"/);
  assert.doesNotMatch(cards, /data-project-enter="default"|data-project-enter="ready"/);
  assert.match(html, /data-project-enter="default"/);
  assert.match(html, /data-project-enter="ready"/);
  assert.match(html, /最后接收.*v1/);
  assert.match(html, /最后观察/);
  assert.doesNotMatch(html, /data-action=|已是最新|实时健康/);
});

test('empty history distinguishes no reception from no matches and never displays a reversed row range', () => {
  const filters = { q: '', status: 'all', from: '', to: '' };
  const page = { records: [], total: 0, offset: 0, limit: 20 };
  const empty = recordList({ page, selected: 'current', filters }, null);
  assert.match(empty, /尚无同步记录/);
  assert.doesNotMatch(empty, /1–0/);
  assert.match(empty, /data-history-range="7"/);
  const filtered = recordList({ page, selected: 'current', filters: { ...filters, q: 'missing' } }, null);
  assert.match(filtered, /没有符合筛选条件的记录/);
  assert.match(filtered, /data-history-range="all"/);
});

test('date shortcuts use inclusive UTC calendar days and can clear only the date constraints', () => {
  assert.deepEqual(historyDateRange(7, new Date('2026-10-15T22:59:00Z')), { from: '2026-10-09', to: '2026-10-15' });
  assert.deepEqual(historyDateRange(30, new Date('2026-10-15T22:59:00Z')), { from: '2026-09-16', to: '2026-10-15' });
  assert.deepEqual(historyDateRange(7, new Date('2024-03-02T01:00:00Z')), { from: '2024-02-25', to: '2024-03-02' });
  assert.deepEqual(historyDateRange('all'), { from: '', to: '' });
});

test('project API exposes accepted and observed local facts without running a remote scan or exposing authentication', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'repo-sync-summary-'));
  const stamp = '2026-10-14T10:00:00Z';
  const receiver = {
    config: { stateDir, bindingId: 'b'.repeat(24), mode: 'version' },
    status: async () => ({
      accepted: { upstream: 'a'.repeat(40), internal: 'c'.repeat(40), tag: 'v1' },
      scannedAt: stamp,
      queue: [],
      deliveries: [],
      automation: { status: 'PAUSED' },
    }),
    git: new Proxy(
      {},
      {
        get() {
          throw Error('project summary must not access Git');
        },
      },
    ),
  };
  Object.defineProperty(receiver.config, 'authentication', {
    get() {
      throw Error('summary must not read credentials');
    },
  });
  const projects = {
    list: async () => ({
      revision: 'revision',
      projects: [{ id: 'default', name: '本地项目', configured: true, adopted: true, mode: 'version' }],
    }),
    connection: async () => ({ current: async () => receiver, describe: () => ({ revision: 'revision' }) }),
  };
  const server = createReceiverServer(null, { projects, syncInterval: 60000 });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/projects`);
    assert.equal(response.status, 200);
    const item = (await response.json()).workspace.projects[0];
    assert.equal(item.syncStatus, 'PAUSED');
    assert.deepEqual(item.accepted, { upstream: 'a'.repeat(40), internal: 'c'.repeat(40), tag: 'v1' });
    assert.equal(item.lastScannedAt, stamp);
    assert.equal(item.lastObservedAt, null);
    assert.doesNotMatch(JSON.stringify(item), /authentication|token|stateDir|bindingId/);
  } finally {
    await server.shutdown();
  }
});

test('local project status retains interrupted setup and recovers to the original legacy delivery without rewriting facts', async () => {
  let state = null,
    task = { status: 'STOP_UNCONFIRMED' };
  const receiver = { config: {}, status: async () => state };
  const options = {
    syncInterval: 60000,
    projects: {
      list: async () => ({
        projects: [{ id: 'default', name: '旧版项目', activeStatus: state?.active?.status ?? null }],
      }),
      connection: async () => ({ current: async () => receiver }),
    },
  };
  const scopes = serverScopes(null, options);
  const scope = await scopes.scope('/api/status?project=default');
  scope.tasks.latest = async () => task;
  const summary = async () => (await options.projectWorkspace()).projects[0];
  try {
    assert.equal(
      (await summary()).syncStatus,
      'FAILED',
      'unconfirmed setup stop must not look like a fresh baseline step',
    );
    state = {
      accepted: { upstream: 'a'.repeat(40), internal: 'b'.repeat(40) },
      deliveries: [],
      active: { status: 'WAITING_APPROVAL' },
    };
    const before = JSON.stringify(state);
    task = { status: 'FAILED' };
    assert.equal((await summary()).syncStatus, 'FAILED');
    task = { status: 'SUCCEEDED' };
    const restored = await summary();
    assert.equal(restored.syncStatus, 'WAITING_REVIEW');
    assert.equal(restored.activeStatus, 'WAITING_APPROVAL');
    assert.equal(restored.lastAcceptedAt, null);
    assert.equal(restored.lastScannedAt, null);
    assert.equal(restored.lastObservedAt, null);
    assert.deepEqual(restored.accepted, state.accepted);
    assert.equal(JSON.stringify(state), before);
  } finally {
    await scopes.close();
  }
});
