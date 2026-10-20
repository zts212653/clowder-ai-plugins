import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { dispatch } from '../src/actions.mjs';
import { Receiver } from '../src/engine.mjs';
import { git } from '../src/process.mjs';
import { recoveryFixture } from './candidate-recovery-fixture.mjs';
import { setIssueToken } from '../src/issue-auth.mjs';

const act = (r, action, fields = {}) => r.status().then((s) => dispatch(r, {
  action, deliveryId: s.active.id, previousUrl: s.active.prUrl ?? '', ...fields,
}));

test('a published manual old candidate exits after explicit closure confirmation and retries with original Issue', async (t) => {
  const f = await recoveryFixture(t, { manual: true });
  await act(f.receiver, 'inspect-exit');
  let s = await f.receiver.status();
  assert.equal(s.active.exitInspection.kind, 'MANUAL_REQUIRED');
  await assert.rejects(() => act(f.receiver, 'cancel-delivery', { confirmed: true }), { code: 'MANUAL_CLOSE_REQUIRED' });
  await act(f.receiver, 'cancel-delivery', { confirmed: true, manualDisposition: 'closed',
    inspectionId: s.active.exitInspection.id });
  const restarted = new Receiver(f.config);
  s = await restarted.status();
  assert.equal(s.active, undefined);
  assert.equal(s.deliveries[0].cancellation.verifiedBy, 'operator');
  assert.equal(s.accepted.internal, f.i0);
  assert.equal(s.issues['issue-71'].receipts.length, 0);
  await restarted.setQueue([f.plan]);
  await restarted.start();
  await restarted.prepare();
  const next = (await restarted.status()).active;
  assert.notEqual(next.branch, f.original.branch);
  assert.equal(next.supersedes, f.original.id);
  assert.equal(await restarted.git.remoteBranch(f.original.branch), f.original.candidate);
});

test('unrelated main advancement and changed diff base do not masquerade as a merged old PR', async (t) => {
  const f = await recoveryFixture(t);
  await writeFile(join(f.review, 'unrelated.txt'), 'independent internal work');
  await git(f.review, ['add', '.']);
  await git(f.review, ['commit', '-m', 'unrelated work']);
  await git(f.review, ['push', 'origin', 'main']);
  const head = await git(f.review, ['rev-parse', 'HEAD']);
  f.platform.state.mrs[0].diff_refs.base_sha = head;
  await act(f.receiver, 'cancel-delivery', { confirmed: true });
  const s = await f.receiver.status();
  assert.equal(s.deliveries[0].status, 'CANCELLED');
  assert.equal(await f.receiver.git.remoteBranch('main'), head);
  assert.equal(s.accepted.internal, f.i0);
  assert.equal(f.platform.state.prCloses, 1);
});

test('a merged wrong candidate gets one resumable repair PR while original mappings and Issue survive', async (t) => {
  const f = await recoveryFixture(t);
  await f.merge(f.original);
  f.platform.state.mrs[0].state = 'merged';
  await act(f.receiver, 'inspect-exit');
  assert.equal((await f.receiver.status()).active.exitInspection.kind, 'MERGED');
  assert.equal((await f.receiver.status()).active.mergeObservation.head, f.original.candidate);
  assert.equal((await f.receiver.status()).active.acceptedInternal, undefined, 'merge observation is not tree acceptance');
  await act(f.receiver, 'preview-repair');
  let s = await f.receiver.status();
  await act(f.receiver, 'prepare-repair', { confirmed: true, planId: s.active.repairPlan.id });
  const repair = (await f.receiver.status()).active.repair.delivery;
  assert.notEqual(repair.branch, f.original.branch);
  assert.equal(f.platform.state.creates.prs, 2);
  assert.equal(f.platform.state.creates.issues, 1);
  const restarted = new Receiver(f.config);
  await act(restarted, 'prepare-repair', { confirmed: true, planId: s.active.repairPlan.id });
  assert.equal(f.platform.state.creates.prs, 2);
  await f.merge(repair);
  f.platform.state.mrs[1].state = 'merged';
  await act(restarted, 'check-repair');
  s = await restarted.status();
  assert.equal(s.deliveries[0].status, 'COMPLETE');
  assert.equal(s.deliveries[0].candidate, f.original.candidate);
  assert.deepEqual(s.deliveries[0].commitMappings, f.original.commitMappings);
  assert.equal(s.deliveries[0].repair.status, 'COMPLETE');
  assert.equal(s.accepted.upstream, f.u1);
  assert.equal(f.platform.state.creates.issues, 1);
  assert.equal(f.platform.state.issues[0].state, 'closed');
  await restarted.git.baseline(f.u1, s.accepted.internal);
});

test('local-only exit never reads upstream or runs old candidate checks, including after a failed check', async (t) => {
  const f = await recoveryFixture(t, { manual: true, local: true });
  f.receiver.git.heads = f.receiver.git.fetch = f.receiver.git.checks = () => { throw Error('must not run'); };
  await act(f.receiver, 'cancel-delivery', { confirmed: true });
  const state = await new Receiver(f.config).status();
  assert.equal(state.deliveries[0].cancellation.verifiedBy, 'git');
  assert.equal(state.accepted.internal, f.i0);
  assert.equal(state.deliveries[0].candidate, f.original.candidate);
  assert.equal(f.platform.state.requests.length, 0);
});

test('a stale manual closure report cannot authorize exiting changed main', async (t) => {
  const f = await recoveryFixture(t, { manual: true });
  await act(f.receiver, 'inspect-exit');
  const id = (await f.receiver.status()).active.exitInspection.id;
  await writeFile(join(f.review, 'new.txt'), 'later work');
  await git(f.review, ['add', '.']);
  await git(f.review, ['commit', '-m', 'advance main']);
  await git(f.review, ['push', 'origin', 'main']);
  await assert.rejects(() => act(f.receiver, 'cancel-delivery', { confirmed: true,
    inspectionId: id, manualDisposition: 'closed' }), { code: 'EXIT_INSPECTION_CHANGED' });
  assert.equal((await f.receiver.status()).active.id, f.original.id);
});

test('a branch without creation intent exits when API proves no PR; unknown creation intent cannot exit', async (t) => {
  const f = await recoveryFixture(t);
  await f.receiver.change((s) => {
    const d = f.receiver.active(s);
    delete d.prUrl; delete d.prCreation; d.status = 'PR_REQUIRED';
  });
  f.platform.state.mrs.length = 0;
  await act(f.receiver, 'inspect-exit');
  assert.equal((await f.receiver.status()).active.exitInspection.kind, 'BRANCH_ONLY');
  await act(f.receiver, 'cancel-delivery', { confirmed: true });
  assert.equal((await f.receiver.status()).active, undefined);
  assert.equal(f.platform.state.prCloses, 0);
  const g = await recoveryFixture(t);
  await g.receiver.change((s) => { const d = g.receiver.active(s); delete d.prUrl; d.status = 'PR_REQUIRED'; });
  g.platform.state.mrs.length = 0;
  await assert.rejects(() => act(g.receiver, 'cancel-delivery', { confirmed: true }), { code: 'PR_CREATE_RESULT_UNKNOWN' });
});

test('lost repair PR creation and expired credentials recover by querying the same object after restart', async (t) => {
  const f = await recoveryFixture(t);
  await f.merge(f.original); f.platform.state.mrs[0].state = 'merged';
  await act(f.receiver, 'preview-repair');
  const planId = (await f.receiver.status()).active.repairPlan.id;
  f.platform.state.lost = 'pr-create';
  await assert.rejects(() => act(f.receiver, 'prepare-repair', { confirmed: true, planId }), { code: 'PR_API_UNAVAILABLE' });
  assert.equal(f.platform.state.creates.prs, 2, 'platform created the repair but response was lost');
  f.platform.state.denied = true;
  const restarted = new Receiver(f.config);
  await assert.rejects(() => act(restarted, 'prepare-repair', { confirmed: true, planId }), { code: 'PR_API_REJECTED' });
  f.platform.state.denied = false;
  setIssueToken(restarted.config, f.platform.token, 'test');
  await act(restarted, 'prepare-repair', { confirmed: true, planId });
  assert.equal(f.platform.state.creates.prs, 2);
  await assert.rejects(() => restarted.prepare(), { code: 'REPAIR_PENDING' });
  await assert.rejects(() => act(restarted, 'check-repair'), { code: 'REPAIR_NOT_MERGED' });
  assert.equal((await restarted.status()).accepted.internal, f.i0);
});

test('repair preview refuses to overwrite later valid core work and retains original records', async (t) => {
  const f = await recoveryFixture(t);
  await f.merge(f.original); f.platform.state.mrs[0].state = 'merged';
  await writeFile(join(f.review, 'core.txt'), 'valid subsequent change');
  await git(f.review, ['add', '.']); await git(f.review, ['commit', '-m', 'later core change']);
  await git(f.review, ['push', 'origin', 'main']);
  await assert.rejects(() => act(f.receiver, 'preview-repair'), { code: 'REPAIR_BASE_CHANGED' });
  const s = await f.receiver.status();
  assert.equal(s.active.candidate, f.original.candidate);
  assert.equal(s.accepted.internal, f.i0);
  assert.equal(f.platform.state.creates.prs, 1);
});

test('an unmerged repair can exit after main advances, retain its history, then replan without another Issue', async (t) => {
  const f = await recoveryFixture(t, { internalPaths: ['README.md'] });
  await f.merge(f.original); f.platform.state.mrs[0].state = 'merged';
  await act(f.receiver, 'preview-repair');
  const planId = (await f.receiver.status()).active.repairPlan.id;
  await act(f.receiver, 'prepare-repair', { confirmed: true, planId });
  const old = (await f.receiver.status()).active.repair.delivery;
  await writeFile(join(f.review, 'README.md'), 'internal documentation');
  await git(f.review, ['add', '.']); await git(f.review, ['commit', '-m', 'internal docs']);
  await git(f.review, ['push', 'origin', 'main']);
  await assert.rejects(() => act(f.receiver, 'prepare-repair', { confirmed: true, planId }), { code: 'REPAIR_BASE_CHANGED' });
  f.platform.state.lost = 'pr-close';
  const retire = (r) => act(r, 'retire-repair', { planId, previousUrl: old.prUrl, confirmed: true });
  await assert.rejects(() => retire(f.receiver), { code: 'PR_API_UNAVAILABLE' });
  const restarted = new Receiver(f.config);
  await assert.rejects(() => act(restarted, 'prepare-repair', { confirmed: true, planId }), { code: 'CANCELLATION_PENDING' });
  await retire(restarted);
  assert.equal(f.platform.state.prCloses, 1);
  await act(restarted, 'preview-repair');
  const newPlan = (await restarted.status()).active.repairPlan.id;
  await act(restarted, 'prepare-repair', { confirmed: true, planId: newPlan });
  const repair = (await restarted.status()).active.repair.delivery;
  assert.notEqual(repair.branch, old.branch);
  await f.merge(repair);
  await act(restarted, 'check-repair');
  const s = await restarted.status();
  assert.equal(s.deliveries[0].repairHistory[0].delivery.candidate, old.candidate);
  assert.equal(s.deliveries[0].repairHistory[0].status, 'CANCELLED');
  assert.equal(f.platform.state.creates.issues, 1);
  assert.equal(await git(f.internal, ['show', 'main:README.md']), 'internal documentation');
});

test('failed preview object creation leaves a readable ledger and can be retried after restart', async (t) => {
  const f = await recoveryFixture(t);
  await f.merge(f.original); f.platform.state.mrs[0].state = 'merged';
  f.receiver.git.mergeNode = () => { throw Error('synthetic object write failure'); };
  await assert.rejects(() => act(f.receiver, 'preview-repair'), /synthetic object write failure/);
  const restarted = new Receiver(f.config);
  assert.equal((await restarted.status()).active.repairPlan, undefined);
  await act(restarted, 'preview-repair');
  assert.ok((await restarted.status()).active.repairPlan.previewCommit);
  assert.equal(f.platform.state.creates.prs, 1);
});
