import assert from 'node:assert/strict';
import test from 'node:test';
import { preparePrWait, prepareIssueWait, installPreparedWait, registerPrWait } from './typed-wait-registration.js';
import { GitHubWaitStorage } from './typed-wait-storage.js';
import type { PluginStorageHost } from '@clowder-ai/plugin-sdk';
import type { TaskItem, PrAutomationState } from './business/model/index.js';

function dependencies() {
  let baselines = 0;
  const calls: number[] = [];
  return {
    calls, count: () => baselines,
    now: () => 1000,
    identity: async () => ({ selfLogin: 'author', subjectAuthorLogin: 'Author' }),
    baseline: async () => {
      baselines++;
      return { baseline: { capturedAt: 1000, headSha: 'aaa' }, collectorState: { ci: { headSha: 'aaa' } } };
    },
    coverage: async (_repo: string, _number: number, comment: number) => { calls.push(comment); return { covered: true }; },
  };
}

test('normal PR registration expands the existing author audience and returns honest coverage', async () => {
  const deps = dependencies();
  const result = await preparePrWait({ registrationId: 'request-1', repoFullName: 'Owner/Repo', prNumber: 7 }, deps);
  assert.equal(result.subjectKey, 'pr:owner/repo#7');
  assert.equal(result.notification.perspective.role, 'subject_author');
  assert.equal(result.state.await?.continuation.when.some(p => p.kind === 'pr_head_changed'), false);
  assert.deepEqual(result.state.await?.continuation.when.filter(p => p.kind.endsWith('comment_added')), [
    { kind: 'pr_conversation_comment_added', audience: { mode: 'everyone_but_self', selfLogin: 'author' } },
    { kind: 'pr_inline_comment_added', audience: { mode: 'everyone_but_self', selfLogin: 'author' } },
  ]);
  assert.equal(result.state.await?.expiresAt, undefined);
  assert.equal(deps.count(), 1);
});

test('precise trigger coverage stays plugin-internal and rejects uncovered or unavailable evidence', async () => {
  const deps = dependencies();
  const input = { registrationId: 'request-1', repoFullName: 'owner/repo', prNumber: 7,
    when: [{ kind: 'pr_review_result_available', triggerCommentId: 42 }] };
  await preparePrWait(input, deps); assert.deepEqual(deps.calls, [42]);
  await assert.rejects(preparePrWait(input, { ...deps, coverage: async () => ({ covered: false, reason: 'no EYES' }) }),
    { status: 422 });
  await assert.rejects(preparePrWait(input, { ...deps, coverage: async () => { throw new Error('page failed'); } }), /page failed/);
});

test('invalid registration is refused before baseline lookup; context cannot be supplied by tool input', async () => {
  const deps = dependencies();
  for (const extra of [
    { when: [{ kind: 'pr_head_changed' }], goal: { kind: 'await_reply_from', authorLogins: ['alice'] } },
    { expiresAt: 1000 }, { threadId: 'forged' },
    { when: [{ kind: 'pr_head_changed' }, { kind: 'pr_head_changed' }] },
  ]) await assert.rejects(preparePrWait({ registrationId: 'request-1', repoFullName: 'owner/repo', prNumber: 7, ...extra }, deps));
  assert.equal(deps.count(), 0);
});

test('normal issue registration arms everyone but self without requiring PR reviewer grounds', async () => {
  const result = await prepareIssueWait({ registrationId: 'request-1', repoFullName: 'Owner/Repo', issueNumber: 8 }, {
    now: () => 1000, identity: async () => ({ selfLogin: 'self' }),
    baseline: async () => ({ baseline: { capturedAt: 1000, issue: { lastCommentCursor: 4, state: 'open' } }, collectorState: {} }),
  });
  assert.equal(result.notification.perspective.role, 'issue_participant');
  assert.deepEqual(result.state.await?.continuation.when, [
    { kind: 'issue_comment_added', audience: { mode: 'everyone_but_self', selfLogin: 'self' } },
  ]);
});

test('identity lookup failure preserves the original explicit unresolved audience', async () => {
  const result = await preparePrWait({ registrationId: 'request-1', repoFullName: 'owner/repo', prNumber: 7 }, {
    ...dependencies(), identity: async () => { throw new Error('identity unavailable'); },
  });
  assert.equal(result.notification.perspective.role, 'unresolved');
  assert.ok(result.notification.commentFilters.every(text => text.includes('normal coverage is NOT established')));
});

test('registration preserves a pending delivery across a new generation and refuses owner changes', async () => {
  let revision = 0;
  const rows = new Map<string, { revision: number; value: unknown }>();
  const storage = {
    async get(k: string) { return structuredClone(rows.get(k)); },
    async compareAndSet(k: string, expected: number | null, value: unknown) {
      if ((rows.get(k)?.revision ?? null) !== expected) return { applied: false };
      rows.set(k, { revision: ++revision, value: structuredClone(value) }); return { applied: true, revision };
    },
  } as PluginStorageHost;
  const store = new GitHubWaitStorage(storage, () => 1000);
  const plan = await preparePrWait({ registrationId: 'request-1', repoFullName: 'owner/repo', prNumber: 7 }, dependencies());
  const task: TaskItem = { id: 'task', kind: 'pr_tracking', subjectKey: plan.subjectKey, ownerCatId: 'astra',
    userId: 'owner', threadId: 'thread', createdAt: 1, updatedAt: 1, title: 'PR', why: '', status: 'doing', createdBy: 'astra' };
  const first = await installPreparedWait(store, task, { ...plan, registrationId: 'first' });
  await store.replaceAutomationStateIfGeneration(task.id, {
    expectedGeneration: 1, expectedUpdatedAt: first.updatedAt, status: 'doing',
    automationState: { ...first.automationState, waitOutcome: { v: 1,
      outcomeId: 'wait:pr:owner/repo#7:g1:matched', generation: 1, subjectRef: 'pr:owner/repo#7',
      ownerFence: { kind: 'containing_task', generation: 1 }, reason: 'matched', at: 999, delivery: 'pending' } },
  });
  const second = await installPreparedWait(store, task, { ...plan, registrationId: 'second' });
  assert.equal(second.automationState?.await?.generation, 2);
  assert.equal(second.automationState?.waitOutcome?.delivery, 'pending');
  const before = await store.get(task.id);
  await assert.rejects(installPreparedWait(store, { ...task, ownerCatId: 'other' }, { ...plan, registrationId: 'second' }), { status: 409 });
  assert.deepEqual(await store.get(task.id), before);
});

test('PR nextStep trims content and refuses whitespace before fetching a baseline', async () => {
  const deps = dependencies();
  await assert.rejects(preparePrWait({ registrationId: 'request-1', repoFullName: 'owner/repo', prNumber: 7, nextStep: '   ' }, deps));
  assert.equal(deps.count(), 0);
  const plan = await preparePrWait({ registrationId: 'request-1', repoFullName: 'owner/repo', prNumber: 7, nextStep: '  Review it.  ' }, deps);
  assert.equal(plan.state.await?.continuation.then, 'Review it.');
});

function replayFixture() {
  let revision = 0;
  const rows = new Map<string, { revision: number; value: unknown }>();
  const storage = {
    async get(k: string) { return structuredClone(rows.get(k)); },
    async compareAndSet(k: string, expected: number | null, value: unknown) {
      if ((rows.get(k)?.revision ?? null) !== expected) return { applied: false };
      rows.set(k, { revision: ++revision, value: structuredClone(value) }); return { applied: true, revision };
    },
  } as PluginStorageHost;
  const task: TaskItem = { id: 'task', kind: 'pr_tracking', subjectKey: 'pr:owner/repo#7', ownerCatId: 'astra',
    userId: 'owner', threadId: 'thread', createdAt: 1, updatedAt: 1, title: 'PR', why: '', status: 'doing', createdBy: 'astra' };
  return { storage, task, store: new GitHubWaitStorage(storage, () => 1000) };
}

test('response-unknown replay returns the original result after restart without replacing the baseline', async () => {
  const f = replayFixture();
  const input = { registrationId: 'request-1', repoFullName: 'owner/repo', prNumber: 7 };
  const plan = await preparePrWait(input, dependencies());
  const first = await installPreparedWait(f.store, f.task, plan);
  const changed = await preparePrWait(input, { ...dependencies(), baseline: async () => ({
    baseline: { capturedAt: 2000, headSha: 'bbb' }, collectorState: { ci: { headSha: 'bbb' } },
  }) });
  const restarted = new GitHubWaitStorage(f.storage, () => 2000);
  assert.deepEqual(await installPreparedWait(restarted, f.task, changed), first);
  assert.deepEqual(await restarted.get(f.task.id), first);
  const next = await installPreparedWait(restarted, f.task, { ...changed, registrationId: 'request-2' });
  assert.equal(next.automationState?.await?.generation, 2);
  assert.deepEqual(await installPreparedWait(restarted, f.task, plan), first);
  assert.deepEqual(await restarted.get(f.task.id), next);
  const conflicting = await preparePrWait({ ...input, nextStep: 'Different intent' }, dependencies());
  await assert.rejects(installPreparedWait(restarted, f.task, conflicting), /reused/);
});

test('simultaneous exact replays share one committed registration', async () => {
  const f = replayFixture();
  const plan = await preparePrWait({ registrationId: 'request-1', repoFullName: 'owner/repo', prNumber: 7 }, dependencies());
  const results = await Promise.all([
    installPreparedWait(f.store, f.task, plan),
    installPreparedWait(new GitHubWaitStorage(f.storage), f.task, plan),
  ]);
  assert.deepEqual(results[0], results[1]);
  assert.equal((await f.store.get(f.task.id))?.automationState?.await?.generation, 1);
});

test('pending outcome and superseded lifecycle event persist together through collector writes and restart', async () => {
  const f = replayFixture();
  const plan = await preparePrWait({ registrationId: 'request-1', repoFullName: 'owner/repo', prNumber: 7 }, dependencies());
  const first = await installPreparedWait(f.store, f.task, { ...plan, registrationId: 'first' });
  const pending = { v: 1 as const, outcomeId: 'older-pending', generation: 1, subjectRef: 'pr:owner/repo#7' as const,
    ownerFence: { kind: 'containing_task' as const, generation: 1 }, reason: 'matched' as const, at: 900, delivery: 'pending' as const };
  await f.store.replaceAutomationStateIfGeneration(f.task.id, {
    expectedGeneration: 1, expectedUpdatedAt: first.updatedAt, status: 'doing',
    automationState: { ...(first.automationState as PrAutomationState), await: { ...(first.automationState as PrAutomationState).await!, generation: 2,
      ownerFence: { kind: 'containing_task', generation: 2 } }, waitOutcome: pending },
  });
  const third = await installPreparedWait(f.store, f.task, { ...plan, registrationId: 'third' });
  assert.equal(third.automationState?.await?.generation, 3);
  assert.deepEqual(third.automationState?.waitOutcome, pending);
  await f.store.patchAutomationState(f.task.id, { review: { lastInlineCommentCursor: 40 } });
  const restarted = new GitHubWaitStorage(f.storage);
  const events = await restarted.lifecycleEvents(f.task.id);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.generation, 2);
  assert.equal(events[0]?.reason, 'superseded');
  await installPreparedWait(restarted, f.task, { ...plan, registrationId: 'third' });
  assert.deepEqual(await restarted.lifecycleEvents(f.task.id), events);
});

test('committed MCP registration replay needs no new provider lookup', async () => {
  const f = replayFixture();
  const input = { registrationId: 'lost-response', repoFullName: 'owner/repo', prNumber: 7 };
  const first = await registerPrWait(f.store, f.task, input, dependencies());
  const failedProvider = { ...dependencies(), baseline: async () => { throw new Error('provider unavailable'); } };
  assert.deepEqual(await registerPrWait(new GitHubWaitStorage(f.storage), f.task, input, failedProvider), first);
  await assert.rejects(registerPrWait(f.store, { ...f.task, ownerCatId: 'other' }, input, failedProvider), { status: 409 });
});

test('simultaneous registrations from different owners cannot consume each other’s replay', async () => {
  const f = replayFixture();
  const plan = await preparePrWait({ registrationId: 'shared-id', repoFullName: 'owner/repo', prNumber: 7 }, dependencies());
  const results = await Promise.allSettled([
    installPreparedWait(f.store, f.task, plan),
    installPreparedWait(new GitHubWaitStorage(f.storage), { ...f.task, ownerCatId: 'other' }, plan),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected').length, 1);
});
