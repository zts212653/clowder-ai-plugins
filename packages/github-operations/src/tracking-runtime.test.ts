import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { GitHubTrackingRuntime, type GitHubSnapshot } from './tracking-runtime.js';
import { legacyIssueProgressBytes } from './legacy-issue-progress.js';

function fixture() {
  const records = new Map<string, { revision: number; value: unknown }>();
  let revision = 0;
  const messages: unknown[] = [];
  const storage = {
    async get(key: string) { return structuredClone(records.get(key)); },
    async list() { return structuredClone(Object.fromEntries(records)); },
    async set(key: string, value: unknown) { records.set(key, { revision: ++revision, value: structuredClone(value) }); return { revision }; },
    async compareAndSet(key: string, expected: number | null, value: unknown) {
      if ((records.get(key)?.revision ?? null) !== expected) return { applied: false };
      records.set(key, { revision: ++revision, value: structuredClone(value) });
      return { applied: true, revision };
    },
    async delete(key: string, expected?: number) {
      if (!records.has(key) || (expected !== undefined && records.get(key)?.revision !== expected)) return { deleted: false };
      records.delete(key); return { deleted: true, revision: ++revision };
    },
  };
  let snapshot: GitHubSnapshot = { state: 'open', headSha: 'a'.repeat(40), ci: 'pending', mergeState: 'CLEAN', comments: [], reviews: [] };
  let requests = 0;
  let failDelivery = false;
  const deps = {
    storage,
    threads: {
      get: async (id: string) => ({ id, title: 'Test', createdAt: 1, lastActiveAt: 1,
        preferredCats: [], featureRefs: [], deepLinkUrl: `https://host.example/thread/${encodeURIComponent(id)}` }),
      bind: async (key: string, threadId: string) => ({ key, threadId, createdAt: 1 }),
    },
    send: async (threadId: string, input: unknown) => {
      if (failDelivery) throw new Error('delivery unavailable');
      messages.push({ threadId, input }); return { messageId: `message-${messages.length}`, threadId };
    },
    provider: { async read() { requests++; return structuredClone(snapshot); } },
    selfLogin: async () => 'owner',
    noiseLogins: async () => ['setup-bot[bot]'],
  };
  return { deps, messages, records, requests: () => requests, set: (value: GitHubSnapshot) => { snapshot = value; }, snapshot: () => structuredClone(snapshot), fail: (value: boolean) => { failDelivery = value; } };
}

const target = { kind: 'pr' as const, repoFullName: 'example/project', number: 12, threadId: 'thread-1', catId: 'cat-1' };

test('issue copy serializes with registration and a failed registration CAS leaves inert retryable progress', async () => {
  const f = fixture(), runtime = new GitHubTrackingRuntime(f.deps);
  const tasks = { old: { id: 'old', kind: 'issue_tracking', subjectKey: 'issue:example/project#12', status: 'doing',
    automationState: JSON.stringify({ issue: { lastCommentCursor: 5, lastDeliveredCursor: 4 } }) } };
  const input = { input: { protocolVersion: 1, snapshot: { tasks },
    sourceDigest: createHash('sha256').update(legacyIssueProgressBytes(tasks)).digest('hex') } };
  const cas = f.deps.storage.compareAndSet;
  let release!: () => void, entered!: () => void;
  const paused = new Promise<void>(resolve => { release = resolve; });
  const staging = new Promise<void>(resolve => { entered = resolve; });
  f.deps.storage.compareAndSet = async (key, expected, value) => {
    if (key.startsWith('github.legacy-issue-progress.')) { entered(); await paused; return cas(key, expected, value); }
    return { applied: false };
  };
  const copying = runtime.importLegacyIssueProgress(input);
  await staging;
  const registering = runtime.register({ ...target, kind: 'issue' });
  const rejected = assert.rejects(registering, /changed concurrently/);
  assert.equal(f.requests(), 0);
  release(); await copying; await rejected;
  assert.equal((await runtime.list()).length, 0);
  assert.equal(f.requests(), 0);
  f.deps.storage.compareAndSet = cas;
  await runtime.register({ ...target, kind: 'issue' });
  assert.equal(f.requests(), 0, 'retry restores copied frontier without requesting a fresh baseline');
  const record = [...f.records.entries()].find(([key]) => key.startsWith('github.tracking.v1.'))![1].value as { baselines: { 'issue-tracking': { conversation: number } } };
  assert.equal(record.baselines['issue-tracking'].conversation, 4);
  await runtime.unregister({ ...target, kind: 'issue' });
  await runtime.register({ ...target, kind: 'issue' });
  assert.equal(f.requests(), 1, 'later explicit re-registration does not replay an old copied frontier');
  await runtime.stop();
});

test('cloud correlation registration is idempotent across object key ordering but refuses a different request', async () => {
  const f = fixture();
  const runtime = new GitHubTrackingRuntime(f.deps);
  const cloudReviewRequest = { headSha: 'a'.repeat(40), triggerCommentId: 1, requestedAt: 1000 };
  await runtime.register({ ...target, cloudReviewRequest });
  await runtime.register({ ...target, cloudReviewRequest: { requestedAt: 1000, triggerCommentId: 1, headSha: 'a'.repeat(40) } });
  assert.equal(f.requests(), 1);
  await assert.rejects(runtime.register({ ...target, cloudReviewRequest: { ...cloudReviewRequest, triggerCommentId: 2 } }), /REGISTRATION_CONFLICT/);
  await runtime.stop();
});

test('CI polling batches registered PRs only and uses the scoped reader for that tick', async () => {
  const f = fixture(); const batchTargets: number[][] = []; let scopedReads = 0;
  const runtime = new GitHubTrackingRuntime({ ...f.deps, provider: { ...f.deps.provider,
    async forCiBatch(targets: readonly typeof target[]) {
      batchTargets.push(targets.map(value => value.number).sort());
      return { async read() { scopedReads++; return f.snapshot(); } };
    },
  } });
  await runtime.poll('cicd-check');
  assert.equal(batchTargets.length, 0);
  await runtime.register(target);
  await runtime.register({ ...target, number: 13 });
  await runtime.register({ ...target, kind: 'issue', number: 14 });
  await runtime.poll('cicd-check');
  assert.deepEqual(batchTargets, [[12, 13]]);
  assert.equal(scopedReads, 2);
  await runtime.poll('review-feedback');
  assert.equal(batchTargets.length, 1);
  await runtime.stop();
});

test('bounded polls resume after the last attempted target across restart instead of starving later registrations', async () => {
  const f = fixture(); let now = 0; let consumeBudget = false;
  const seen: number[] = [];
  const deps = { ...f.deps, pollBudgetMs: 10, now: () => now,
    provider: { async read(input: typeof target) { seen.push(input.number); if (consumeBudget) now += 20; return f.snapshot(); } },
  };
  const first = new GitHubTrackingRuntime(deps);
  for (const number of [12, 13, 14]) await first.register({ ...target, number });
  seen.length = 0; consumeBudget = true;
  await first.poll('review-feedback');
  assert.equal(seen.length, 1, 'expired package budget must defer remaining subjects');
  await first.stop();
  const second = new GitHubTrackingRuntime(deps);
  await second.poll('review-feedback');
  await second.poll('review-feedback');
  assert.equal(new Set(seen).size, 3, 'restart retains the fairness cursor');
  await second.stop();
});

test('package object deadline aborts the provider but retains the polling lease until cleanup closes', async () => {
  const f = fixture(); let reads = 0; let aborted = false; let settled = false;
  let release!: () => void;
  const closed = new Promise<void>(resolve => { release = resolve; });
  const runtime = new GitHubTrackingRuntime({ ...f.deps, objectTimeoutMs: 5, provider: {
    async read(_target, signal) {
      if (++reads === 2) {
        signal.addEventListener('abort', () => { aborted = true; }, { once: true });
        await closed;
        signal.throwIfAborted();
      }
      return f.snapshot();
    },
  } });
  await runtime.register(target);
  const poll = runtime.poll('review-feedback');
  const rejected = assert.rejects(poll, /timeout/i).then(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(aborted, true);
  assert.equal(settled, false, 'deadline must not race away from cleanup');
  release(); await rejected;
  assert.equal((await runtime.list())[0]?.active, true);
  await runtime.poll('review-feedback');
  assert.equal(reads, 3);
  await runtime.stop();
});

test('the fourth formal changes-requested review pauses wake once while recording and notifying', async () => {
  const f = fixture();
  const reviews = Array.from({ length: 3 }, (_, index) => ({ id: index + 1, author: 'reviewer', state: 'CHANGES_REQUESTED', commitId: 'a'.repeat(40) }));
  f.set({ ...f.snapshot(), reviews });
  const runtime = new GitHubTrackingRuntime(f.deps);
  await runtime.register(target);
  f.set({ ...f.snapshot(), reviews: [...reviews, { ...reviews[0]!, id: 4 }] });
  await runtime.poll('review-feedback');
  const fourth = f.messages[0] as { input: { wake?: unknown; payload: unknown } };
  assert.equal(fourth.input.wake, undefined);
  assert.match(JSON.stringify(fourth.input.payload), /Finding Pattern Summary/);
  await runtime.poll('review-feedback');
  assert.equal(f.messages.length, 1);
  f.set({ ...f.snapshot(), reviews: [...f.snapshot().reviews, { ...reviews[0]!, id: 5 }] });
  await runtime.poll('review-feedback');
  assert.deepEqual((f.messages[1] as { input: { wake?: unknown } }).input.wake, { catId: target.catId });
  assert.equal((await runtime.list())[0]?.active, true);
  await runtime.stop();
});

test('activation without tracking does no IO; registered comments use SDK message and terminal tracking retires', async () => {
  const f = fixture();
  const runtime = new GitHubTrackingRuntime(f.deps);
  await runtime.poll('review-feedback');
  assert.equal(f.requests(), 0);
  await runtime.register(target);
  f.set({ ...f.snapshot(), comments: [
    { id: 1, author: 'OWNER', body: 'self', commentType: 'conversation' },
    { id: 2, author: 'setup-bot[bot]', body: 'To use Codex here, create an environment for this repo', commentType: 'conversation' },
    { id: 3, author: 'maintainer', body: 'Please fix the parser', commentType: 'conversation' },
  ] });
  await runtime.poll('review-feedback');
  assert.equal(f.messages.length, 1);
  const message = f.messages[0] as { threadId: string; input: { wake: { catId: string }; payload: unknown } };
  assert.equal(message.threadId, 'thread-1');
  assert.deepEqual(message.input.wake, { catId: 'cat-1' });
  assert.match(JSON.stringify(message.input.payload), /maintainer/);
  assert.doesNotMatch(JSON.stringify(message.input), /waitContinuationCarrier|ownerFence|parser/);
  await runtime.poll('review-feedback');
  assert.equal(f.messages.length, 1);
  f.set({ ...f.snapshot(), state: 'merged' });
  await runtime.poll('review-feedback');
  assert.equal(f.messages.length, 2);
  const count = f.requests();
  await runtime.poll('review-feedback');
  assert.equal(f.requests(), count);
  await runtime.stop();
});

test('persisted pending delivery survives restart and failed send does not lose the notification', async () => {
  const f = fixture();
  const first = new GitHubTrackingRuntime(f.deps);
  await first.register(target);
  f.set({ ...f.snapshot(), ci: 'fail' });
  f.fail(true);
  await assert.rejects(first.poll('cicd-check'), /delivery unavailable/);
  await first.stop();
  const second = new GitHubTrackingRuntime(f.deps);
  f.fail(false);
  await second.poll('cicd-check');
  assert.equal(f.messages.length, 1);
  await second.poll('cicd-check');
  assert.equal(f.messages.length, 1);
  await second.unregister({ kind: 'pr', repoFullName: target.repoFullName, number: target.number });
  const count = f.requests();
  await second.poll('cicd-check');
  assert.equal(f.requests(), count);
  await second.stop();
});

test('a terminal CI poll includes the last uncollected comments before retiring tracking', async () => {
  const f = fixture(); const runtime = new GitHubTrackingRuntime(f.deps);
  await runtime.register(target);
  f.set({ ...f.snapshot(), state: 'merged', comments: [
    { id: 99, author: 'maintainer', body: 'last review', commentType: 'inline' },
  ] });
  await runtime.poll('cicd-check');
  assert.match(JSON.stringify(f.messages), /maintainer/);
  assert.equal((await runtime.list())[0]?.active, false);
  await runtime.stop();
});

test('one unavailable repository does not starve other registered targets', async () => {
  const f = fixture(); const original = f.deps.provider.read;
  let fail = false;
  const runtime = new GitHubTrackingRuntime({ ...f.deps, provider: { async read(t, signal) {
    if (fail && t.number === 12) throw new Error('repository unavailable');
    return original();
  } } });
  await runtime.register(target); await runtime.register({ ...target, number: 13 });
  fail = true; f.set({ ...f.snapshot(), ci: 'fail' });
  await assert.rejects(runtime.poll('cicd-check'), /repository unavailable|poll failed/);
  assert.equal(f.messages.length, 1);
  assert.match(JSON.stringify(f.messages), /13/);
  await runtime.stop();
});

test('unregister waits for aborted provider cleanup; queued polls cannot revive tracking', async () => {
  const f = fixture(); let block = false; let began!: () => void; let release!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const cleaned = new Promise<void>(resolve => { release = resolve; });
  const runtime = new GitHubTrackingRuntime({ ...f.deps, provider: { async read(_t, signal) {
    if (block) { began(); await cleaned; signal.throwIfAborted(); }
    return f.snapshot();
  } } });
  await runtime.register(target); block = true;
  const poll = runtime.poll('review-feedback');
  const rejected = assert.rejects(poll, /unregistered/); await started;
  let finished = false;
  const unregister = runtime.unregister(target).then(() => { finished = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(finished, false);
  release(); await rejected; await unregister;
  assert.equal((await runtime.list())[0]?.active, false);
  assert.equal(f.messages.length, 0);
  await runtime.stop();
  await assert.rejects(runtime.poll('review-feedback'), /stopped/);
});

test('dismissal of a previously observed old-head review remains visible; stale new approvals do not', async () => {
  const f = fixture(), runtime = new GitHubTrackingRuntime(f.deps);
  const review = { id: 8, author: 'reviewer', state: 'APPROVED', commitId: 'a'.repeat(40) };
  f.set({ ...f.snapshot(), reviews: [review] });
  await runtime.register(target);
  f.set({ ...f.snapshot(), headSha: 'b'.repeat(40), reviews: [{ ...review, state: 'DISMISSED' }, { ...review, id: 9 }] });
  await runtime.poll('review-feedback');
  assert.equal(f.messages.length, 1);
  assert.match(JSON.stringify(f.messages), /DISMISSED/);
  assert.doesNotMatch(JSON.stringify(f.messages), /APPROVED/);
  await runtime.poll('review-feedback'); assert.equal(f.messages.length, 1);
  await runtime.stop();
});

test('cloud observation cannot turn a dismissed review clean through stale or missing provider reviews', async () => {
  const f = fixture(), observed: GitHubSnapshot[] = [];
  const deps = { ...f.deps, observe: async (_target: unknown, snapshot: GitHubSnapshot) => { observed.push(snapshot); } };
  let runtime = new GitHubTrackingRuntime(deps);
  const requestedAt = Date.parse('2026-01-01T00:00:00Z');
  const review = { id: 8, author: 'chatgpt-codex-connector[bot]', state: 'DISMISSED',
    commitId: 'a'.repeat(40), submittedAt: '2026-01-01T00:01:00Z' };
  f.set({ ...f.snapshot(), commentsComplete: true, comments: [{ id: 7, author: 'owner', body: '@codex review',
    commentType: 'conversation', createdAt: new Date(requestedAt).toISOString() }], reviews: [] });
  await runtime.register({ ...target, cloudReviewRequest: { headSha: review.commitId, triggerCommentId: 7, requestedAt } });
  f.set({ ...f.snapshot(), reviews: [review] }); await runtime.poll('review-feedback');
  assert.equal(observed.at(-1)?.cloudObservation?.status, 'failed_or_timeout');
  await runtime.stop(); runtime = new GitHubTrackingRuntime(deps);
  f.set({ ...f.snapshot(), reviews: [{ ...review, state: 'APPROVED' }] });
  await runtime.poll('review-feedback');
  assert.equal(observed.at(-1)?.cloudObservation?.status, 'failed_or_timeout');
  f.set({ ...f.snapshot(), reviews: [] }); await runtime.poll('review-feedback');
  assert.equal(observed.at(-1)?.cloudObservation, undefined, 'missing known review evidence cannot replace the last cloud observation');
  assert.equal(f.messages.length, 1);
  f.set({ ...f.snapshot(), reviews: [review, { ...review, id: 9, state: 'APPROVED' }] });
  await runtime.poll('review-feedback');
  assert.equal(observed.at(-1)?.cloudObservation?.status, 'clean', 'a new review may establish a new observation');
  assert.equal(f.messages.length, 2);
  await runtime.stop();
});

for (const stale of ['omitted', 'same-head', 'old-head'] as const) {
  test(`dismissed review stays final across ${stale} snapshot, restart and later terminal collection`, async () => {
    const f = fixture(), collected: GitHubSnapshot[] = [];
    const deps = { ...f.deps, collect: async (_target: unknown, snapshot: GitHubSnapshot) => { collected.push(snapshot); } };
    let runtime = new GitHubTrackingRuntime(deps);
    const review = { id: 8, author: 'reviewer', state: 'APPROVED', commitId: 'a'.repeat(40) };
    f.set({ ...f.snapshot(), reviews: [review] }); await runtime.register(target);
    f.set({ ...f.snapshot(), reviews: [{ ...review, state: 'DISMISSED' }] });
    await runtime.poll('review-feedback');
    assert.equal(f.messages.length, 1);
    assert.deepEqual(collected.flatMap(s => s.reviews).map(r => r.state), ['DISMISSED']);
    await runtime.stop(); runtime = new GitHubTrackingRuntime(deps);
    f.set({ ...f.snapshot(), headSha: (stale === 'old-head' ? 'b' : 'a').repeat(40),
      reviews: stale === 'omitted' ? [] : [review] });
    await runtime.poll('review-feedback');
    assert.equal(f.messages.length, 1, 'missing or stale provider data cannot revive a dismissed review');
    const record = [...f.records.entries()].find(([key]) => key.startsWith('github.tracking.v1.'))![1].value as {
      baselines: { 'review-feedback': { reviews: Record<string, string> } };
    };
    assert.equal(record.baselines['review-feedback'].reviews['8'], `DISMISSED:${review.commitId}`);
    f.set({ ...f.snapshot(), reviews: [{ ...review, state: 'DISMISSED' }] });
    await runtime.poll('review-feedback');
    assert.equal(f.messages.length, 1, 'the same dismissal is not reported twice');
    assert.deepEqual(collected.flatMap(s => s.reviews).map(r => r.state), ['DISMISSED']);
    f.set({ ...f.snapshot(), reviews: [review, { ...review, id: 9, commitId: f.snapshot().headSha }] });
    await runtime.poll('review-feedback');
    assert.equal(f.messages.length, 2, 'a distinct review still notifies');
    assert.deepEqual(collected.flatMap(s => s.reviews).map(r => r.id), [8, 9]);
    f.set({ ...f.snapshot(), state: 'closed', reviews: [review] });
    await runtime.poll('cicd-check');
    assert.equal(f.messages.length, 3, 'terminal state still notifies');
    assert.doesNotMatch(JSON.stringify(f.messages.at(-1)), /github:review:8/);
    assert.deepEqual(collected.flatMap(s => s.reviews).map(r => r.id), [8, 9]);
    await runtime.stop();
  });
}

test('registered review-thread resolution and replies are observed without Host wait state', async () => {
  const f = fixture(), runtime = new GitHubTrackingRuntime(f.deps);
  f.set({ ...f.snapshot(), reviewThreads: [{ reviewThreadId: 'PRRT_1', resolved: false, lastCommentId: 'comment-1' }] });
  await runtime.register({ ...target, reviewThreadIds: ['PRRT_1'] });
  f.set({ ...f.snapshot(), reviewThreads: [{ reviewThreadId: 'PRRT_1', resolved: true, lastCommentId: 'comment-2' }] });
  await runtime.poll('review-feedback');
  assert.equal(f.messages.length, 1);
  assert.match(JSON.stringify(f.messages), /PRRT_1.*resolved/);
  assert.match(JSON.stringify(f.messages), /comment-2/);
  await runtime.poll('review-feedback'); assert.equal(f.messages.length, 1);
  await runtime.stop();
});

test('self-merge notification remains durable without waking the merger, including after delivery retry', async () => {
  const f = fixture(), runtime = new GitHubTrackingRuntime(f.deps);
  await runtime.register(target);
  f.set({ ...f.snapshot(), state: 'merged', mergedByLogin: 'OWNER' });
  f.fail(true); await assert.rejects(runtime.poll('cicd-check'), /delivery unavailable/);
  await runtime.stop(); f.fail(false);
  const resumed = new GitHubTrackingRuntime(f.deps);
  await resumed.poll('cicd-check');
  assert.equal(f.messages.length, 1);
  assert.equal('wake' in (f.messages[0] as { input: object }).input, false);
  assert.equal((await resumed.list())[0]?.active, false);
  await resumed.stop();
});

test('a known dismissed review reaches Community collection even after its HEAD changed', async () => {
  const f = fixture(); const collected: GitHubSnapshot[] = [];
  const runtime = new GitHubTrackingRuntime({ ...f.deps, collect: async (_target, snapshot) => { collected.push(snapshot); } });
  const review = { id: 8, author: 'reviewer', state: 'APPROVED', commitId: 'a'.repeat(40) };
  f.set({ ...f.snapshot(), reviews: [review] }); await runtime.register(target);
  f.set({ ...f.snapshot(), headSha: 'b'.repeat(40), reviews: [{ ...review, state: 'DISMISSED' }] });
  await runtime.poll('review-feedback');
  assert.equal(collected[0]?.reviews[0]?.state, 'DISMISSED');
  await runtime.stop();
});
