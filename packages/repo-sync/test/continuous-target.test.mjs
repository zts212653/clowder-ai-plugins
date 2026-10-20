import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Receiver } from '../src/engine.mjs';
import { runExecution } from '../src/execution.mjs';
import { discover } from '../src/github.mjs';
import { git } from '../src/process.mjs';
import { repositories } from './fixtures.mjs';

function metadata(f) {
  const prs = f.plans.map((plan) => ({
    node_id: plan.source.id,
    number: plan.source.number,
    html_url: plan.source.url,
    title: plan.source.title,
    merged: true,
    merged_at: '2026-10-14T00:00:00Z',
    merge_commit_sha: plan.target,
    base: { ref: 'main' },
  }));
  return {
    api: async (path) => {
      if (path === 'repos/demo/core') return { node_id: 'repository-1' };
      if (path.includes('/commits/')) return prs.filter((pr) => path.includes(pr.merge_commit_sha));
      return prs.find((pr) => path === `repos/demo/core/pulls/${pr.number}`);
    },
    collectIssues: async (_, pr) => f.plans[pr.number - 1].issues,
  };
}
async function prepare() {
  const f = await repositories();
  const publicSource = 'https://github.com/demo/core.git';
  const receiver = new Receiver({ ...f.config, sourceUrl: publicSource });
  receiver.git.config = { ...receiver.config, sourceUrl: f.source };
  await receiver.adopt(f.u0, f.i0);
  await git(f.source, ['tag', 'v-first', f.u1]);
  return { f, receiver };
}
test('continuous tag freezes a bounded PR queue while retaining the actual newest scanned head', async () => {
  const { f, receiver } = await prepare();
  await discover(receiver, { kind: 'tag', value: 'v-first' }, metadata(f));
  const state = await receiver.status();
  assert.equal(state.queue.length, 1);
  assert.equal(state.queue[0].source.number, 1);
  assert.equal(state.syncTarget.commit, f.u1);
  assert.equal(state.latest, f.u2);
  assert.equal(state.queue[0].syncTarget.frozenTag.name, 'v-first');
  await receiver.start();
  await receiver.linkIssue('issue-71', '318', 'https://codehub.example/core/issues/318');
  await git(f.source, ['tag', '-f', 'v-first', f.u2]);
  await assert.rejects(() => receiver.prepare(), { code: 'TAG_MOVED' });
});
test('continuous SHA uses complete ordered PR boundaries and rejects rollback or active-range replacement', async () => {
  const { f, receiver } = await prepare();
  await discover(receiver, { kind: 'commit', value: f.u2 }, metadata(f));
  assert.deepEqual(
    (await receiver.status()).queue.map((plan) => plan.source.number),
    [1, 2],
  );
  await receiver.start();
  await assert.rejects(() => discover(receiver, { kind: 'commit', value: f.u1 }, metadata(f)), {
    code: 'RECOVERY_FIRST',
  });
});
test('a target inside an unfinished PR cannot produce a truncated synchronization', async () => {
  const { f, receiver } = await prepare();
  const source = metadata(f);
  const original = source.api;
  source.api = async (path) =>
    path.includes('/commits/')
      ? [
          {
            node_id: 'one-rebased-pr',
            number: 1,
            merged_at: '2026-10-14T00:00:00Z',
            merge_commit_sha: f.u2,
            base: { ref: 'main' },
          },
        ]
      : original(path);
  const before = await readFile(receiver.store.path, 'utf8');
  await assert.rejects(() => discover(receiver, { kind: 'commit', value: f.u1 }, source), { code: 'SOURCE_UNPROVEN' });
  assert.equal(await readFile(receiver.store.path, 'utf8'), before);
});

test('a release tag outside main has a failed target substep without scanning PRs or changing the ledger', async () => {
  const { f, receiver } = await prepare();
  await git(f.source, ['switch', '-c', 'release-only', f.u0]);
  await git(f.source, ['commit', '--allow-empty', '-m', 'release-only commit']);
  await git(f.source, ['tag', 'off-branch']);
  const source = metadata(f),
    api = source.api,
    reports = [];
  source.api = (path) => {
    assert.equal(path, 'repos/demo/core', 'invalid target must stop before PR and Issue requests');
    return api(path);
  };
  const before = await readFile(receiver.store.path, 'utf8');
  await assert.rejects(
    () =>
      runExecution({ signal: new AbortController().signal, report: (event) => reports.push(event) }, () =>
        discover(receiver, { kind: 'tag', value: 'off-branch' }, source),
      ),
    { code: 'TARGET_NOT_ON_SOURCE_BRANCH' },
  );
  assert.ok(
    reports.some(
      (event) =>
        event.id === 'target-check' && event.kind === 'failed' && event.error.code === 'TARGET_NOT_ON_SOURCE_BRANCH',
    ),
  );
  assert.equal(await readFile(receiver.store.path, 'utf8'), before);
});
