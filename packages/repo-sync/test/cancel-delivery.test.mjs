import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatch } from '../src/actions.mjs';
import { synchronize } from '../src/automation.mjs';
import { Receiver } from '../src/engine.mjs';
import { setIssueToken } from '../src/issue-auth.mjs';
import { git } from '../src/process.mjs';
import { codehubPlatform } from './codehub-fixture.mjs';
import { repositories } from './fixtures.mjs';

async function fixture(t, lost) {
  const f = await repositories(), platform = await codehubPlatform(f, { lost });
  t.after(platform.close);
  const adapter = { mode: 'gitlab', apiUrl: platform.api, projectId: 'team/core', authMode: 'session' };
  const config = { ...f.config, sourceUrl: 'https://github.com/demo/core.git', internalWebUrl: platform.web,
    issues: adapter, pullRequests: { ...adapter }, commitStrategy: 'rewrite' };
  const receiver = new Receiver(config);
  receiver.git.config = { ...receiver.config, sourceUrl: f.source };
  setIssueToken(receiver.config, platform.token, 'test');
  await receiver.adopt(f.u0, f.i0);
  await receiver.setQueue(f.plans);
  const provider = {
    api: async (path) => {
      if (path === 'repos/demo/core') return { node_id: 'repo-1' };
      const number = path.includes(f.u1) || path.includes('/pulls/1') ? 1 : 2;
      const pr = { node_id: `pr-${number}`, number, title: `PR ${number}`, html_url: `https://github.com/demo/core/pull/${number}`,
        merged: true, merged_at: '2026-10-16', merge_commit_sha: number === 1 ? f.u1 : f.u2, base: { ref: 'main' }, commits: 1 };
      return path.includes('/commits/') ? [pr] : pr;
    },
    collectIssues: async (_, pr) => f.plans[pr.number - 1].issues,
  };
  await synchronize(receiver, { action: 'synchronize', requestId: 'a'.repeat(32), continuation: 'after-each' }, { sourceProvider: provider });
  return { ...f, receiver, config, platform, provider };
}
const cancel = (receiver, d) => dispatch(receiver, {
  action: 'cancel-delivery', deliveryId: d.id, previousUrl: d.prUrl ?? '', confirmed: true,
});

test('published unmerged PR can be closed and explicitly retried with a new branch, preserving Issue and history', async (t) => {
  const f = await fixture(t), old = (await f.receiver.status()).active;
  await cancel(f.receiver, old);
  let state = await f.receiver.status();
  assert.equal(state.active, undefined);
  assert.equal(state.deliveries[0].status, 'CANCELLED');
  assert.equal(f.platform.state.prCloses, 1);
  assert.equal(f.platform.state.mrs[0].state, 'closed');
  assert.equal(state.accepted.upstream, f.u0);
  assert.equal(state.accepted.internal, f.i0);
  assert.equal(state.automation.status, 'PAUSED');
  assert.equal(state.queue.length, 0);
  assert.equal(f.platform.state.creates.prs, 1);
  await synchronize(f.receiver, { action: 'resume-sync', runId: state.automation.id, observeOnly: true });
  assert.equal(f.platform.state.creates.prs, 1, 'background observation cannot retry');
  await synchronize(f.receiver, { action: 'resume-sync', runId: state.automation.id }, { sourceProvider: f.provider });
  state = await f.receiver.status();
  assert.notEqual(state.active.id, old.id);
  assert.notEqual(state.active.branch, old.branch);
  assert.equal(state.active.supersedes, old.id);
  assert.equal(f.platform.state.creates.prs, 2);
  assert.equal(f.platform.state.creates.issues, 1);
  assert.equal(await git(f.internal, ['rev-parse', 'main']), f.i0);
  assert.equal(await f.receiver.git.remoteBranch(old.branch), old.candidate);
});

test('lost PR close response holds cancellation across restart and never resumes ordinary synchronization', async (t) => {
  const f = await fixture(t, 'pr-close'), old = (await f.receiver.status()).active;
  await assert.rejects(() => cancel(f.receiver, old), { code: 'PR_API_UNAVAILABLE' });
  assert.equal(f.platform.state.prCloses, 1);
  const receiver = new Receiver(f.config);
  receiver.git.config = { ...receiver.config, sourceUrl: f.source };
  await assert.rejects(() => receiver.prepare(), { code: 'CANCELLATION_PENDING' });
  await assert.rejects(() => receiver.recover(), { code: 'CANCELLATION_PENDING' });
  assert.equal((await receiver.status()).automation.status, 'PAUSED');
  await cancel(receiver, old);
  assert.equal((await receiver.status()).deliveries[0].status, 'CANCELLED');
  assert.equal(f.platform.state.prCloses, 1);
});

test('merged PRs, changed candidates, stale forms and missing confirmation cannot cancel or rewind main', async (t) => {
  const f = await fixture(t), d = (await f.receiver.status()).active;
  await assert.rejects(() => dispatch(f.receiver, { action: 'cancel-delivery', deliveryId: d.id, previousUrl: d.prUrl }), { code: 'CANCEL_CONFIRMATION_REQUIRED' });
  await assert.rejects(() => cancel(f.receiver, { ...d, id: 'f'.repeat(24) }), { code: 'DELIVERY_CHANGED' });
  await assert.rejects(() => cancel(f.receiver, { ...d, prUrl: `${f.platform.web}/merge_requests/999` }), { code: 'PR_MAPPING_CHANGED' });
  f.platform.state.mrs[0].state = 'merged';
  await assert.rejects(() => cancel(f.receiver, d), { code: 'PR_ALREADY_MERGED' });
  f.platform.state.mrs[0].state = 'opened';
  await f.merge(d);
  await assert.rejects(() => cancel(f.receiver, d), { code: 'PR_ALREADY_MERGED' });
  assert.equal(f.platform.state.prCloses, 0);
  assert.notEqual(await git(f.internal, ['rev-parse', 'main']), f.i0);
});
