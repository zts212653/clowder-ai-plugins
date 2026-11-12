import assert from 'node:assert/strict';
import test from 'node:test';
import type { FeatureContext, PluginActionContext } from '@clowder-ai/plugin-sdk';
import { TypedWaitRuntime } from './typed-wait-runtime.js';
import type { GitHubSnapshot, GitHubTrackingProvider } from './tracking-runtime.js';
import { memoryStorage } from '../test/memory-storage.js';
import { GitHubRateLimitError, GitHubRequestDeferredError } from './business/infrastructure/github/request-budget.js';

function fixture() {
  let now = 1000, failure: Error | undefined, reads = 0;
  const storage = memoryStorage(), sent: unknown[] = [], logs: Array<{ message: string; fields?: unknown }> = [];
  let snapshot: GitHubSnapshot = { state: 'open', headSha: 'a'.repeat(40), ci: 'pending', comments: [], reviews: [], commentsComplete: true,
    trackingIdentity: { selfLogin: 'maintainer', subjectAuthorLogin: 'contributor' } };
  const context = { storage, config: { get: async () => undefined }, secrets: { get: async () => undefined },
    threads: { get: async () => ({ id: 'home' }) }, messaging: { send: async (_thread: string, draft: unknown) => {
      sent.push(draft); return { messageId: 'notice', threadId: 'home' }; } }, log(_level: string, message: string, fields?: unknown) { logs.push({ message, fields }); } } as unknown as FeatureContext;
  const caller: PluginActionContext = { userId: 'owner', catId: 'codex61-sol', threadId: 'home', invocationId: 'turn', assertCurrent: async () => {} };
  const provider: GitHubTrackingProvider = { read: async () => { reads++; if (failure) throw failure; return structuredClone(snapshot); } };
  const runtime = () => new TypedWaitRuntime({ context, now: () => now, coverage: async () => ({ covered: true }), provider });
  return { storage, context, caller, sent, logs, runtime, provider, head: (sha: string) => { snapshot = { ...snapshot, headSha: sha }; },
    update: (patch: Partial<GitHubSnapshot>) => { snapshot = { ...snapshot, ...patch }; },
    reads: () => reads, advance: () => { now += 60_001; },
    fail: (error?: Error) => { failure = error; } };
}
const input = { registrationId: 'original-registration', repoFullName: 'owner/repo', prNumber: 1 };

test('a failed optional CI batch does not charge unread PRs a provider failure', async () => {
  const f = fixture(), runtime = f.runtime();
  try {
    const tracked = await runtime.registerPr(input, f.caller);
    await runtime.registerPr({ ...input, prNumber: 2 }, f.caller);
    f.provider.forCiBatch = async () => { throw new Error('batch transport failed'); };
    const before = f.reads(); f.advance(); await runtime.poll('pr');
    assert.equal(f.reads() - before, 2, 'each PR must get its own independent observation');
    assert.equal((await runtime.store.recovery.facts(tracked.id))!.failures, 0);
  } finally { await runtime.stop(); }
});

test('an authorized retry preserves the original baseline and a later pause has a distinct durable notice', async () => {
  const f = fixture(), runtime = f.runtime();
  try {
    const task = await runtime.registerPr({ ...input, autoRenew: false, when: [{ kind: 'pr_head_changed' }] }, f.caller);
    f.fail(new Error('outage'));
    for (let n = 0; n < 6; n++) { f.advance(); await runtime.poll('pr'); }
    const pausedTask = structuredClone(await runtime.store.get(task.id));
    const facts = (await runtime.store.recovery.facts(task.id))!;
    const retry = { taskId: task.id, expectedScope: facts.scope, expectedRecoveryRevision: facts.revision };
    const before = await f.storage.list();
    await assert.rejects(runtime.retry(retry), /Authenticated/);
    await assert.rejects(runtime.retry(retry, { ...f.caller, userId: 'other' }), /different user/);
    await assert.rejects(runtime.retry(retry, { ...f.caller, assertCurrent: async () => { throw new Error('revoked'); } }), /revoked/);
    await assert.rejects(runtime.retry({ ...retry, expectedScope: '0'.repeat(64) }, f.caller), /changed|paused/);
    assert.deepEqual(await f.storage.list(), before, 'rejected retries cannot write anything');
    const reads = f.reads();
    await runtime.retry(retry, { ...f.caller, catId: 'maintenance-cat', threadId: 'maintenance-thread' });
    assert.equal(f.reads(), reads, 'retry schedules the original observer without capturing a new baseline');
    assert.deepEqual(await runtime.store.get(task.id), pausedTask);
    await assert.rejects(runtime.retry(retry, f.caller), /changed|paused/);
    for (let n = 0; n < 6; n++) { f.advance(); await runtime.poll('pr'); }
    assert.equal(f.sent.length, 2);
    const keys = f.sent.map(notice => (notice as { idempotencyKey: string }).idempotencyKey);
    assert.equal(new Set(keys).size, 2);
    assert.equal(Object.keys((await runtime.store.recovery.facts(task.id))!.notices).length, 0);
    const second = (await runtime.store.recovery.facts(task.id))!;
    await runtime.retry({ ...retry, expectedRecoveryRevision: second.revision }, f.caller);
    f.fail(); f.head('b'.repeat(40));
    f.advance(); await runtime.poll('pr');
    assert.equal((await runtime.store.get(task.id))!.automationState!.waitOutcome!.reason, 'matched',
      'a change while paused is still compared with the original baseline');
  } finally { await runtime.stop(); }
});

test('successful observations reset intermittent failures instead of eventually parking a healthy wait', async () => {
  const f = fixture(), runtime = f.runtime();
  try {
    const tracked = await runtime.registerPr(input, f.caller), baselineReads = f.reads();
    for (let n = 0; n < 8; n++) {
      f.fail(new Error('transient provider failure')); f.advance(); await runtime.poll('pr');
      f.fail(); f.advance(); await runtime.poll('pr');
      assert.equal((await runtime.store.recovery.facts(tracked.id))!.failures, 0);
    }
    assert.equal(f.reads() - baselineReads, 16);
    assert.equal((await runtime.store.recovery.facts(tracked.id))!.disposition, undefined);
    assert.equal(f.sent.length, 0);
  } finally { await runtime.stop(); }
});

test('quota deferral and a cold recovery do not erase an unresolved observation failure streak', async () => {
  const f = fixture(); let runtime = f.runtime();
  try {
    const tracked = await runtime.registerPr(input, f.caller);
    f.fail(new Error('provider failure')); f.advance(); await runtime.poll('pr');
    assert.equal((await runtime.store.recovery.facts(tracked.id))!.failures, 1);
    await runtime.stop(); runtime = f.runtime();
    f.advance(); await runtime.recover();
    assert.equal((await runtime.store.recovery.facts(tracked.id))!.failures, 1);
    f.fail(new GitHubRateLimitError(10_000_000)); f.advance(); await runtime.poll('pr');
    assert.equal((await runtime.store.recovery.facts(tracked.id))!.failures, 1);
  } finally { await runtime.stop(); }
});

test('local queue pressure leaves the observation streak and original baseline untouched', async () => {
  const f = fixture(), runtime = f.runtime();
  try {
    const task = await runtime.registerPr(input, f.caller);
    f.fail(new Error('provider failure')); f.advance(); await runtime.poll('pr');
    const before = structuredClone(await runtime.store.get(task.id));
    f.fail(new GitHubRequestDeferredError('local queue capacity exceeded'));
    for (let n = 0; n < 8; n++) { f.advance(); await runtime.poll('pr'); }
    assert.equal((await runtime.store.recovery.facts(task.id))!.failures, 1);
    assert.equal((await runtime.store.recovery.facts(task.id))!.disposition, undefined);
    assert.deepEqual(await runtime.store.get(task.id), before);
  } finally { await runtime.stop(); }
});

test('retrying before a pause notice is delivered cancels that stale notice without erasing history', async () => {
  const f = fixture(), runtime = f.runtime();
  try {
    const task = await runtime.registerPr(input, f.caller);
    f.fail(new Error('outage'));
    for (let n = 0; n < 5; n++) { f.advance(); await runtime.poll('pr'); }
    const facts = (await runtime.store.recovery.facts(task.id))!;
    assert.equal(Object.values(facts.notices)[0]!.state, 'pending');
    await runtime.retry({ taskId: task.id, expectedScope: facts.scope, expectedRecoveryRevision: facts.revision }, f.caller);
    f.fail(); f.advance(); await runtime.poll('pr');
    assert.equal(f.sent.length, 0);
    assert.equal(Object.values((await runtime.store.recovery.facts(task.id))!.notices)[0]!.state, 'cancelled');
    assert.ok(JSON.stringify(await f.storage.list()).includes('recoveryRetries'));
  } finally { await runtime.stop(); }
});

test('paused waits retain a redacted error and identify the subject in their one attention notice', async () => {
  const f = fixture(), runtime = f.runtime();
  f.context.secrets.get = async key => key === 'token' ? 'private-provider-token' : undefined;
  try {
    const tracked = await runtime.registerPr(input, f.caller);
    f.fail(new Error('provider rejected private-provider-token'));
    for (let n = 0; n < 7; n++) { f.advance(); await runtime.poll('pr'); }
    const facts = await runtime.store.recovery.facts(tracked.id);
    assert.match(JSON.stringify(facts), /provider rejected \[redacted\]/);
    assert.doesNotMatch(JSON.stringify(facts), /private-provider-token/);
    assert.equal(f.sent.length, 1);
    assert.match(JSON.stringify(f.sent[0]), /owner\/repo#1/);
    assert.match(JSON.stringify(f.sent[0]), /github_observation_failed/);
    assert.doesNotMatch(JSON.stringify(f.sent[0]), /private-provider-token|provider rejected/);
  } finally { await runtime.stop(); }
});

test('real failed observations leave automatic polling after five attempts and survive a cold runtime', async () => {
  const f = fixture(); let runtime = f.runtime();
  try {
    const tracked = await runtime.registerPr(input, f.caller), registrationReads = f.reads();
    f.fail(new Error('provider observation failed'));
    for (let n = 0; n < 8; n++) { f.advance(); await runtime.poll('pr'); }
    assert.equal(f.reads() - registrationReads, 5);
    assert.notEqual((await runtime.store.get(tracked.id))?.status, 'done');
    await runtime.stop(); runtime = f.runtime();
    f.advance(); await runtime.poll('pr');
    assert.equal(f.reads() - registrationReads, 5, 'recreation cannot reset the original failure budget');
    assert.equal(f.sent.length, 1, 'the original owner receives one idempotent attention notice');
    const notice = f.sent[0] as { wake?: unknown; meta: { phase: string }; idempotencyKey: string };
    assert.equal(notice.wake, undefined); assert.equal(notice.meta.phase, 'status');
    assert.match(notice.idempotencyKey, /^github-wait-recovery:/);
  } finally { await runtime.stop(); }
});

test('normal waiting and provider quota deferral never consume the failure budget', async () => {
  const f = fixture(), runtime = f.runtime();
  try {
    const tracked = await runtime.registerPr(input, f.caller), baselineReads = f.reads();
    for (let n = 0; n < 8; n++) { f.advance(); await runtime.poll('pr'); }
    assert.equal(f.reads() - baselineReads, 8);
    f.fail(new GitHubRateLimitError(10_000_000));
    for (let n = 0; n < 8; n++) { f.advance(); await runtime.poll('pr'); }
    f.fail(); f.advance();
    assert.notEqual((await runtime.store.get(tracked.id))?.status, 'done');
    const before = f.reads(); await runtime.poll('pr');
    assert.equal(f.reads(), before, 'a real quota reset defers the item until its recorded due time');
  } finally { await runtime.stop(); }
});

for (const missing of ['compareAndSetIndexed', 'readDue', 'rebuildIndex', 'scan'] as const)
test(`a Host missing ${missing} rejects registration before saving a claimed subscription`, async () => {
  const f = fixture();
  delete f.context.storage[missing];
  const runtime = f.runtime();
  try {
    await assert.rejects(runtime.registerPr(input, f.caller), /indexed.*storage.*unavailable/i);
    assert.equal(Object.keys(await f.storage.list()).filter(key => key.startsWith('github.typed-wait.v1.')).length, 0);
    assert.equal(f.reads(), 0);
  } finally { await runtime.stop(); }
});

test('a malformed canonical wait is parked without hiding a healthy due neighbor or changing its business bytes', async () => {
  const f = fixture(), runtime = f.runtime();
  try {
    const bad = await runtime.registerPr(input, f.caller);
    await runtime.registerPr({ ...input, registrationId: 'neighbor', prNumber: 2 }, f.caller);
    await runtime.store.recovery.initialize();
    const rows = await f.storage.list(), [name, entry] = Object.entries(rows).find(([, entry]) =>
      (entry.value as { task?: { id?: string } })?.task?.id === bad.id)!;
    const original = { ...(entry.value as object), task: { ...bad, kind: 'malformed' } };
    await f.storage.compareAndSetIndexed!(name, entry.revision, original, { index: 'github-pr-waits', score: 0 });
    const before = f.reads();
    await runtime.poll('pr');
    assert.equal(f.reads() - before, 1, 'the healthy neighbor must still be observed');
    const current = (await f.storage.get(name))!.value as { task: unknown; recovery: { disposition: string } };
    assert.deepEqual(current.task, original.task);
    assert.equal(current.recovery.disposition, 'needs_attention');
    assert.equal((await f.storage.readDue!({ index: 'github-pr-waits', before: 1000, limit: 20 })).status, 'ready');
    await runtime.store.recovery.initialize(true);
    assert.equal((await runtime.store.recovery.facts(bad.id))!.disposition, 'needs_attention');
  } finally { await runtime.stop(); }
});

test('a recorded quota reset cannot hide an earlier explicit wait deadline', async () => {
  const f = fixture(), runtime = f.runtime();
  try {
    const tracked = await runtime.registerPr({ ...input, expiresAt: 61000 }, f.caller);
    f.fail(new GitHubRateLimitError(10_000_000));
    await runtime.poll('pr');
    const before = f.reads();
    f.advance(); await runtime.poll('pr');
    assert.equal(f.reads(), before, 'expiry is decided locally without another provider read');
    assert.equal((await runtime.store.get(tracked.id))?.automationState?.waitOutcome?.reason, 'expired');
    assert.equal(f.sent.length, 1);
  } finally { await runtime.stop(); }
});

test('zero-due rounds use the native index and still emit one numeric summary', async () => {
  const f = fixture(), runtime = f.runtime();
  try {
    await runtime.store.recovery.initialize();
    f.context.storage.scan = async () => assert.fail('a ready round cannot scan retained history');
    f.context.storage.list = async () => assert.fail('a ready round cannot list retained history');
    await runtime.poll('pr');
    const summaries = f.logs.filter(log => log.message === 'GitHub wait recovery round');
    assert.equal(summaries.length, 1);
    assert.deepEqual(summaries[0]!.fields, { kind: 'pr', selected: 0, visited: 0, failed: 0, deferred: 0, elapsedMs: 0 });
    assert.equal(f.reads(), 0);
  } finally { await runtime.stop(); }
});

test('corrupt recovery counters retain their original bytes and cannot reset into automatic retries', async () => {
  const f = fixture(), runtime = f.runtime();
  try {
    const tracked = await runtime.registerPr(input, f.caller);
    await runtime.store.recovery.initialize();
    const [name, entry] = Object.entries(await f.storage.list()).find(([, row]) =>
      (row.value as { task?: { id?: string } })?.task?.id === tracked.id)!;
    const original = entry.value as { recovery: Record<string, unknown> };
    const invalid = { ...original.recovery, failures: 'corrupt-budget' };
    await f.storage.compareAndSetIndexed!(name, entry.revision, { ...original, recovery: invalid }, { index: 'github-pr-waits', score: 0 });
    const before = f.reads();
    await runtime.poll('pr');
    await runtime.store.recovery.initialize(true);
    f.advance(); await runtime.poll('pr');
    const current = (await f.storage.get(name))!.value as { recovery: { disposition: string }; malformedRecovery: unknown };
    assert.equal(current.recovery.disposition, 'needs_attention');
    assert.deepEqual(current.malformedRecovery, invalid);
    assert.equal(f.reads(), before);
  } finally { await runtime.stop(); }
});


test('an exact persisted self-review receipt is private, but another cat on the shared login still wakes', async () => {
  const f = fixture(), runtime = f.runtime(), head = 'a'.repeat(40);
  try {
    const task = await runtime.registerPr(input, f.caller);
    const { SdkCommunityObjectStore } = await import('./business/domains/community/CommunityObjectStore.js');
    await new SdkCommunityObjectStore(f.storage).save({
      subjectKey: 'pr:owner/repo#1',
      externalReview: {
        mode: 'maintainer_review', cloudPolicy: 'optional', lifecycle: 'delivered',
        currentHeadSha: head, headGeneration: 1, currentHeadObservedAt: 1000,
        lastReviewedHeadSha: head, lastReviewedHeadGeneration: 1,
        lastDeliveredHeadSha: head, lastDeliveredHeadGeneration: 1,
        ci: null, cloud: null, wake: null,
        delivery: { kind: 'delivered', headSha: head,
          githubUrl: 'https://github.com/owner/repo/pull/1#pullrequestreview-42', deliveredAt: 1000 },
        deliveredVerdictFingerprint: null, verdictSubmissionEpoch: 1, pendingVerdict: null,
        reviewerCatId: 'codex61-sol', reviewerThreadId: 'home',
      },
    } as import('./business/model/index.js').CommunityObjectProjection);
    f.update({ reviews: [{ id: 42, author: 'zts212653', state: 'APPROVED', commitId: head }] });
    f.advance(); await runtime.poll('pr');
    assert.equal(f.sent.length, 0, 'the exact review just persisted by this owner must not wake that owner again');
    assert.equal((await runtime.store.get(task.id))!.automationState!.waitOutcome, undefined);

    f.update({ reviews: [
      { id: 42, author: 'zts212653', state: 'APPROVED', commitId: head },
      { id: 43, author: 'zts212653', state: 'APPROVED', commitId: head },
    ] });
    f.advance(); await runtime.poll('pr');
    assert.equal(f.sent.length, 1, 'a different review id with no matching persisted self-receipt is actionable');
  } finally { await runtime.stop(); }
});

test('a reviewed PR defers only a no-action pending HEAD update, then wakes for its current-head CI result', async () => {
  const f = fixture(), runtime = f.runtime(), oldHead = 'a'.repeat(40), newHead = 'b'.repeat(40);
  try {
    f.update({ reviews: [{ id: 1, author: 'previous-reviewer', state: 'APPROVED', commitId: oldHead }] });
    const task = await runtime.registerPr(input, f.caller);
    f.update({ headSha: newHead, ci: 'pending' });
    f.advance(); await runtime.poll('pr');
    assert.equal(f.sent.length, 0, 'a pure rebase/update while CI is pending needs no immediate duplicate wake');
    const followed = (await runtime.store.get(task.id))!.automationState!.await!;
    assert.equal(followed.generation, 2, 'the deferred notification still renews the original wait instead of creating a parallel one');
    assert.equal('headSha' in followed.baseline && followed.baseline.headSha, newHead, 'the silent update still advances the durable head baseline');

    f.update({ ci: 'pass' });
    f.advance(); await runtime.poll('pr');
    assert.equal(f.sent.length, 1, 'the current-head terminal CI result still arrives');
    assert.equal((await runtime.store.get(task.id))!.automationState!.waitOutcome!.reason, 'matched');
  } finally { await runtime.stop(); }
});

for (const scenario of [
  {
    name: 'changes-requested',
    patch: {
      reviews: [
        { id: 1, author: 'previous-reviewer', state: 'APPROVED', commitId: 'a'.repeat(40) },
        { id: 2, author: 'zts212653', state: 'CHANGES_REQUESTED', commitId: 'b'.repeat(40) },
      ],
    },
  },
  {
    name: 'author-help',
    patch: {
      comments: [{ id: 9, author: 'contributor', body: 'please re-review after the rebase', commentType: 'conversation' as const }],
    },
  },
  {
    name: 'conflict',
    patch: { mergeState: 'CONFLICTING' },
  },
  {
    name: 'no-ci',
    patch: { ci: 'external_infrastructure' as const },
  },
] as const) {
  test(`CI-pending coalescing never hides ${scenario.name}`, async () => {
    const f = fixture(), runtime = f.runtime(), oldHead = 'a'.repeat(40), newHead = 'b'.repeat(40);
    try {
      f.update({ reviews: [{ id: 1, author: 'previous-reviewer', state: 'APPROVED', commitId: oldHead }] });
      await runtime.registerPr(input, f.caller);
      f.update({ headSha: newHead, ci: scenario.name === 'no-ci' ? 'external_infrastructure' : 'pending', ...scenario.patch });
      f.advance(); await runtime.poll('pr');
      assert.equal(f.sent.length, 1, `${scenario.name} must remain immediately visible`);
    } finally { await runtime.stop(); }
  });
}

test('CI failure and subject terminal are never deferred behind a green result', async () => {
  for (const terminal of [{ ci: 'fail' as const }, { state: 'merged' as const }]) {
    const f = fixture(), runtime = f.runtime(), oldHead = 'a'.repeat(40);
    try {
      f.update({ reviews: [{ id: 1, author: 'previous-reviewer', state: 'APPROVED', commitId: oldHead }] });
      await runtime.registerPr(input, f.caller);
      f.update({ headSha: 'b'.repeat(40), ci: 'pending', ...terminal });
      f.advance(); await runtime.poll('pr');
      assert.equal(f.sent.length, 1, JSON.stringify(terminal));
    } finally { await runtime.stop(); }
  }
});
