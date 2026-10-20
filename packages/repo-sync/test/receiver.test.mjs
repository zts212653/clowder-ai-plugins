import assert from 'node:assert/strict';
import test from 'node:test';
import { Receiver } from '../src/engine.mjs';
import { git } from '../src/process.mjs';
import { repositories } from './fixtures.mjs';

test('real Git: snapshot adoption, shared Issue, U1/U2 and additional receiving merges', async () => {
  const f = await repositories();
  let receiver = new Receiver(f.config);
  await receiver.adopt(f.u0, f.i0);
  await receiver.setQueue(f.plans);
  for (let i = 0; i < 2; i++) {
    await receiver.start();
    await receiver.linkIssue('issue-71', '318', 'https://codehub.example/core/issues/318');
    await receiver.prepare();
    let status = await receiver.status();
    const delivery = status.active;
    assert.equal(await receiver.git.sha(`refs/sync/deliveries/${delivery.id}`), delivery.candidate);
    assert.equal(
      await git(f.review, ['ls-remote', 'origin', 'refs/heads/main']).then((value) => value.split(/\s/)[0]),
      status.accepted.internal,
    );
    await receiver.linkPr(`https://codehub.example/core/pull/${i + 1}`);
    const internalSha = await f.merge(delivery);
    receiver = new Receiver(f.config); // Process interruption: main advanced but ledger still has the old cursor.
    await assert.rejects(() => receiver.start(), { code: 'RECOVERY_FIRST' });
    await receiver.recover();
    status = await receiver.status();
    assert.equal(status.accepted.internal, internalSha);
    assert.equal(status.accepted.upstream, i ? f.u2 : f.u1);
    assert.notEqual(status.accepted.internal, status.accepted.upstream);
    assert.ok(await receiver.git.isAncestor(status.accepted.upstream, internalSha));
    assert.ok(await receiver.git.isAncestor(f.i0, internalSha));
    await assert.rejects(() => receiver.setQueue([]), { code: 'RECOVERY_FIRST' });
    if (!i)
      await assert.rejects(() => receiver.receipts([{ sourceId: 'issue-71', internalId: '318', state: 'closed' }]), {
        code: 'ISSUE_CLOSED_EARLY',
      });
    await receiver.receipts([{ sourceId: 'issue-71', internalId: '318', state: i ? 'closed' : 'open' }]);
    status = await receiver.status();
    assert.equal(status.active, undefined);
    assert.equal(status.deliveries[i].status, 'COMPLETE');
  }
  const status = await receiver.status();
  assert.equal(status.issues['issue-71'].receipts.length, 2);
});
test('Git graph: an identical tree with rewritten source commits is rejected', async () => {
  const f = await repositories();
  const receiver = new Receiver(f.config);
  await receiver.adopt(f.u0, f.i0);
  await receiver.setQueue(f.plans);
  await receiver.start();
  await receiver.linkIssue('issue-71', '318', 'https://codehub.example/core/issues/318');
  await receiver.prepare();
  const delivery = (await receiver.status()).active;
  const rewritten = await receiver.git.mergeNode(await receiver.git.tree(f.u1), [f.i0], 'rewritten source');
  await assert.rejects(() => receiver.git.verify(delivery, rewritten), { code: 'HISTORY_REWRITTEN' });
});
test('a remote candidate created before an interrupted receipt is reused, never overwritten', async () => {
  const f = await repositories();
  const receiver = new Receiver(f.config);
  await receiver.adopt(f.u0, f.i0);
  await receiver.setQueue(f.plans);
  await receiver.start();
  await receiver.linkIssue('issue-71', '318', 'https://codehub.example/core/issues/318');
  await receiver.prepare();
  const state = await receiver.read();
  const delivery = state.deliveries[0];
  delivery.status = 'PUSH_RESULT_UNKNOWN';
  await receiver.store.save(state);
  await new Receiver(f.config).recover();
  assert.equal((await receiver.status()).active.status, 'PR_REQUIRED');
  assert.equal(await receiver.git.remoteBranch(delivery.branch), delivery.candidate);
});
test('unverified platform closure behavior blocks all internal pushes', async () => {
  const f = await repositories();
  const receiver = new Receiver({ ...f.config, commitClosureVerified: false });
  await receiver.adopt(f.u0, f.i0);
  await receiver.setQueue(f.plans);
  await receiver.start();
  await receiver.linkIssue('issue-71', '318', 'https://codehub.example/core/issues/318');
  await assert.rejects(() => receiver.prepare(), { code: 'PLATFORM_CLOSURE_UNVERIFIED' });
  assert.equal(await receiver.git.remoteBranch((await receiver.status()).active.branch), null);
});
test('a candidate branch created by another writer during push is never replaced', async () => {
  const f = await repositories();
  const receiver = new Receiver(f.config);
  await receiver.adopt(f.u0, f.i0);
  await receiver.setQueue(f.plans);
  await receiver.start();
  const state = await receiver.read();
  const delivery = state.deliveries[0];
  delivery.candidate = await receiver.git.candidate(delivery.base, delivery.target, delivery.id);
  const original = receiver.git.remoteBranch.bind(receiver.git);
  let first = true;
  receiver.git.remoteBranch = async (branch) => {
    if (first) {
      first = false;
      await git(f.internal, ['update-ref', `refs/heads/${branch}`, f.i0]);
      return null;
    }
    return original(branch);
  };
  await assert.rejects(() => receiver.git.publish(delivery));
  assert.equal(await original(delivery.branch), f.i0);
});
test('a failed push with no remote ref offers a retry of the same frozen candidate', async () => {
  const f = await repositories();
  const receiver = new Receiver(f.config);
  await receiver.adopt(f.u0, f.i0);
  await receiver.setQueue(f.plans);
  await receiver.start();
  const state = await receiver.read();
  const delivery = state.deliveries[0];
  delivery.candidate = await receiver.git.candidate(delivery.base, delivery.target, delivery.id);
  delivery.status = 'PUSH_RESULT_UNKNOWN';
  await receiver.store.save(state);
  await receiver.recover();
  assert.equal((await receiver.status()).active.status, 'ISSUES_REQUIRED');
  assert.equal((await receiver.status()).active.candidate, delivery.candidate);
});
