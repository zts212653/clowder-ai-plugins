import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { FeatureContext, PluginActionContext, PluginTaskItem, PluginStorageEntry } from '@clowder-ai/plugin-sdk';
import { TypedWaitRuntime } from './typed-wait-runtime.js';
import type { GitHubSnapshot } from './tracking-runtime.js';
import type { GitHubPrAwaitStateV1 } from './business/model/types/github-wait.js';
import { executeGitHubRequest } from './business/infrastructure/github/request-budget.js';

function fixture() {
  const rows = new Map<string, PluginStorageEntry>();
  const config = new Map<string, unknown>();
  const sent: unknown[] = []; let revision = 0; let reads = 0; let current = true;
  let sendFailure = false, threadAvailable = true, hostTaskCalls = 0;
  const forbiddenTask = async () => { hostTaskCalls++; throw new Error('Host Tasks forbidden'); };
  let snapshot: GitHubSnapshot = { state: 'open', headSha: 'a'.repeat(40), ci: 'pending', comments: [], reviews: [],
    commentsComplete: true, trackingIdentity: { selfLogin: 'self', subjectAuthorLogin: 'self' } };
  let read: (() => Promise<GitHubSnapshot>) | undefined;
  const context = {
    storage: {
      get: async (key: string) => structuredClone(rows.get(key)), list: async () => structuredClone(Object.fromEntries(rows)),
      compareAndSet: async (key: string, expected: number | null, value: unknown) => {
        if ((rows.get(key)?.revision ?? null) !== expected) return { applied: false };
        rows.set(key, { revision: ++revision, value: structuredClone(value) }); return { applied: true, revision };
      },
    },
    secrets: { get: async () => undefined },
    tasks: { get: forbiddenTask, list: forbiddenTask, create: forbiddenTask, update: forbiddenTask },
    threads: { get: async () => threadAvailable ? { id: 'thread' } : null },
    messaging: { get: async () => { throw new Error('Message reads forbidden'); }, send: async (_thread: string, draft: unknown) => {
      if (sendFailure || !threadAvailable) throw new Error('delivery unavailable'); sent.push(draft); return { messageId: 'message', threadId: 'thread' };
    } }, config: { get: async (key: string) => config.get(key) }, log: () => {},
  } as unknown as FeatureContext;
  const caller: PluginActionContext = { catId: 'astra', userId: 'owner', threadId: 'thread', invocationId: 'turn',
    assertCurrent: async () => { if (!current) throw new Error('stale invocation'); } };
  const options = { context, provider: { read: async () => { reads++; return read ? read() : structuredClone(snapshot); } },
    coverage: async () => ({ covered: true }), now: () => 1000 };
  return { context, caller, options, config, rows, sent, reads: () => reads, hostTaskCalls: () => hostTaskCalls,
    setSnapshot: (value: GitHubSnapshot) => { snapshot = value; },
    defer: (value: () => Promise<GitHubSnapshot>) => { read = value; }, stale: () => { current = false; },
    failSend: (value: boolean) => { sendFailure = value; }, threadAvailable: (value: boolean) => { threadAvailable = value; },
    snapshot: () => snapshot };
}
const input = { registrationId: 'registration', repoFullName: 'owner/repo', prNumber: 1 };

for (const kind of ['pr', 'issue'] as const) test(`${kind}: native registration admits its live baseline ahead of queued collection`, async () => {
  const f = fixture(), runtime = new TypedWaitRuntime(f.options);
  const order: string[] = [];
  let release!: () => void, entered!: () => void, baselineEntered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const baselineStarted = new Promise<void>(resolve => { baselineEntered = resolve; });
  const options = { ghToken: `registration-queue-${kind}`, execFileAsync: async (_file: string, args: string[]) => {
    order.push(args[1]!);
    if (args[1] === 'running') { entered(); await blocked; }
    return { stdout: '{}' };
  } };
  const first = executeGitHubRequest(['api', 'running'], options); await started;
  const background = Array.from({ length: 6 }, (_, i) => executeGitHubRequest(['api', `poll-${i}`], options));
  f.defer(async () => {
    baselineEntered(); await executeGitHubRequest(['api', 'native-baseline'], options);
    return f.snapshot();
  });
  const registration = kind === 'pr' ? runtime.registerPr(input, f.caller) :
    runtime.registerIssue({ registrationId: 'registration', repoFullName: 'owner/repo', issueNumber: 1 }, f.caller);
  await baselineStarted; await new Promise(resolve => setImmediate(resolve));
  release();
  try {
    const task = await registration;
    await Promise.all([first, ...background]);
    assert.equal(order[1], 'native-baseline', 'registration must carry interactive admission through the real provider read');
    assert.equal(task.automationState?.await?.generation, 1);
    assert.deepEqual(await (kind === 'pr' ? runtime.registerPr(input, f.caller) :
      runtime.registerIssue({ registrationId: 'registration', repoFullName: 'owner/repo', issueNumber: 1 }, f.caller)), task);
    assert.equal(f.reads(), 1, 'stable replay does not freeze another baseline');
    assert.equal(f.hostTaskCalls(), 0); assert.equal(f.sent.length, 0);
  } finally { release(); await runtime.stop(); }
});

test('a typed poll yields within its budget and resumes the next subscription after restart', async () => {
  const f = fixture(); let now = 1000;
  const options = { ...f.options, now: () => now, pollBudgetMs: 2000 };
  let runtime = new TypedWaitRuntime(options);
  const first = await runtime.registerIssue({ registrationId: 'one', repoFullName: 'owner/repo', issueNumber: 1 }, f.caller);
  const second = await runtime.registerIssue({ registrationId: 'two', repoFullName: 'owner/repo', issueNumber: 2 }, f.caller);
  const originals = new Map([first, second].map(task => [task.id, structuredClone(task.automationState)]));
  const visited: number[] = [];
  const provider = { read: async (target: { number: number }) => {
    visited.push(target.number); now += 2000; return f.snapshot();
  } };
  await runtime.stop(); runtime = new TypedWaitRuntime({ ...options, provider });
  await runtime.poll('issue'); assert.equal(visited.length, 1, 'a tick must not admit the entire backlog after its deadline');
  await runtime.stop(); runtime = new TypedWaitRuntime({ ...options, provider });
  await runtime.poll('issue'); assert.equal(visited.length, 2);
  assert.notEqual(visited[0], visited[1], 'restart preserves admission fairness rather than restarting at the first wait');
  for (const task of [first, second]) {
    const current = await runtime.store.get(task.id);
    assert.deepEqual(current?.automationState?.await, originals.get(task.id)?.await, 'no new baseline or generation');
  }
  assert.equal(f.sent.length, 0); assert.equal(f.hostTaskCalls(), 0);
  await runtime.stop();
});

test('CI batching consumes the same typed poll budget before any per-PR observation', async () => {
  const f = fixture(); let now = 1000, reads = 0;
  let runtime = new TypedWaitRuntime(f.options);
  const task = await runtime.registerPr(input, f.caller); await runtime.stop();
  runtime = new TypedWaitRuntime({ ...f.options, now: () => now, pollBudgetMs: 2000,
    provider: { read: async () => { throw new Error('Unscoped read'); },
      forCiBatch: async () => { now += 2000; return { read: async () => { reads++; return f.snapshot(); } }; } } });
  await runtime.poll('pr'); assert.equal(reads, 0, 'spent batch budget cannot admit another observation');
  assert.deepEqual((await runtime.store.get(task.id))?.automationState, task.automationState);
  await runtime.stop();
});

test('the last subscription cut short by the poll budget gets a full slot next tick', async () => {
  const f = fixture(); let now = 1000, truncated = false;
  const visited: number[] = [];
  let runtime = new TypedWaitRuntime(f.options);
  await runtime.registerIssue({ registrationId: 'one', repoFullName: 'owner/repo', issueNumber: 1 }, f.caller);
  await runtime.registerIssue({ registrationId: 'two', repoFullName: 'owner/repo', issueNumber: 2 }, f.caller);
  await runtime.stop();
  runtime = new TypedWaitRuntime({ ...f.options, now: () => now, pollBudgetMs: 10_000,
    provider: { read: async target => {
      visited.push(target.number);
      if (target.number === 2 && !truncated) {
        truncated = true; now += 4000; throw new DOMException('Tick budget exhausted', 'TimeoutError');
      }
      now += target.number === 1 ? 6000 : 1000;
      return f.snapshot();
    } } });
  await runtime.poll('issue'); assert.deepEqual(visited, [1, 2]);
  await runtime.poll('issue'); assert.equal(visited[2], 2, 'advancing past a truncated tail can starve that same position every cycle');
  assert.equal(f.sent.length, 0); assert.equal(f.hostTaskCalls(), 0);
  await runtime.stop();
});

test('a budget-clipped timer retains its target even before the clock reaches the soft deadline', async () => {
  const f = fixture(); let now = 1000, truncated = false;
  const visited: number[] = [];
  let runtime = new TypedWaitRuntime(f.options);
  await runtime.registerIssue({ registrationId: 'one', repoFullName: 'owner/repo', issueNumber: 1 }, f.caller);
  await runtime.registerIssue({ registrationId: 'two', repoFullName: 'owner/repo', issueNumber: 2 }, f.caller);
  await runtime.stop();
  runtime = new TypedWaitRuntime({ ...f.options, now: () => now, pollBudgetMs: 5000, objectTimeoutMs: 1000,
    provider: { read: async (target, signal) => {
      visited.push(target.number);
      if (!truncated && target.number === 1) now = 4499;
      else if (!truncated) {
        truncated = true;
        await new Promise<void>((_resolve, reject) => {
          const guard = setTimeout(() => reject(new Error('Expected clipped admission timer')), 100);
          signal!.addEventListener('abort', () => { clearTimeout(guard); reject(signal!.reason); }, { once: true });
        });
      }
      return f.snapshot();
    } } });
  await runtime.poll('issue'); assert.deepEqual(visited, [1, 2]);
  assert.equal(now, 4499, 'the timer can fire one millisecond before the observed soft deadline');
  await runtime.poll('issue');
  assert.equal(visited[2], 2, 'a clipped timeout must not advance the durable cursor past its target');
  assert.equal(f.sent.length, 0); assert.equal(f.hostTaskCalls(), 0);
  await runtime.stop();
});

test('a full object timeout still rotates after cleanup crosses the poll deadline', async () => {
  const f = fixture(); let now = 1000, failed = false;
  const visited: number[] = [];
  let runtime = new TypedWaitRuntime(f.options);
  await runtime.registerIssue({ registrationId: 'one', repoFullName: 'owner/repo', issueNumber: 1 }, f.caller);
  await runtime.registerIssue({ registrationId: 'two', repoFullName: 'owner/repo', issueNumber: 2 }, f.caller);
  await runtime.stop();
  runtime = new TypedWaitRuntime({ ...f.options, now: () => now, pollBudgetMs: 3000, objectTimeoutMs: 20,
    provider: { read: async (target, signal) => {
      visited.push(target.number);
      if (!failed) {
        failed = true;
        await new Promise<void>((_resolve, reject) => {
          const guard = setTimeout(() => reject(new Error('Expected full object timer')), 100);
          signal!.addEventListener('abort', () => {
            clearTimeout(guard); now = 4000; reject(signal!.reason);
          }, { once: true });
        });
      }
      return f.snapshot();
    } } });
  await runtime.poll('issue');
  await runtime.poll('issue');
  assert.equal(visited[1], 2, 'cleanup cannot turn a complete failed slot into perpetual tail deferral');
  assert.equal(f.sent.length, 0); assert.equal(f.hostTaskCalls(), 0);
  await runtime.stop();
});

for (const authors of [['alice', 'bot[bot]'], ['bot[bot]', 'alice'], ['alice', 'bob', 'bot[bot]']]) {
  test(`mixed review authors are filtered independently before the poll is consumed (${authors.join(',')})`, async () => {
    const f = fixture();
    f.config.set('notificationAllowlist', 'alice,bob'); f.config.set('notificationBlocklist', 'bot[bot]');
    const runtime = new TypedWaitRuntime(f.options);
    try {
      const task = await runtime.registerPr(input, f.caller);
      const reviews = authors.map((author, index) => ({ id: index + 7, author, commitId: f.snapshot().headSha,
        state: author === 'bot[bot]' ? 'COMMENTED' as const : 'CHANGES_REQUESTED' as const }));
      f.setSnapshot({ ...f.snapshot(), reviews });
      await runtime.poll('pr'); assert.equal(f.sent.length, 1);
      const notification = JSON.stringify(f.sent[0]);
      for (const review of reviews) {
        if (review.author !== 'bot[bot]') assert.ok(notification.includes(`review:${review.id}`), 'every allowed review has its own source');
        else assert.ok(!notification.includes(`review:${review.id}`), 'blocked review has no notification delta');
      }
      assert.equal((await runtime.store.get(task.id))?.automationState?.review?.lastDecisionCursor, reviews.at(-1)!.id);
      f.config.clear(); await runtime.poll('pr');
      assert.equal(f.sent.length, 1, 'relaxing policy must not replay consumed reviews');
    } finally { await runtime.stop(); }
  });
}

for (const kind of ['pr', 'issue'] as const) test(`${kind}: cancelled subscription history does not block a new authenticated thread`, async () => {
  const f = fixture(); const runtime = new TypedWaitRuntime(f.options);
  const args = kind === 'pr' ? input : { registrationId: 'issue-request', repoFullName: 'owner/repo', issueNumber: 1 };
  const register = (value: any, who: PluginActionContext) => kind === 'pr' ? runtime.registerPr(value, who) : runtime.registerIssue(value, who);
  try {
    const old = await register(args, f.caller);
    await runtime.unregister({ subjectKey: old.subjectKey }, f.caller);
    const cancelled = await runtime.store.get(old.id);
    const nextCaller = { ...f.caller, threadId: 'new-thread' };
    const retry = { ...args, registrationId: 'new-thread-stable-request' };
    const next = await register(retry, nextCaller);
    assert.notEqual(next.id, old.id); assert.equal(next.threadId, 'new-thread');
    assert.ok(next.automationState?.await);
    assert.deepEqual(await register(retry, nextCaller), next, 'unknown responses replay the same committed registration');
    assert.deepEqual(await runtime.store.get(old.id), cancelled, 'old cancellation history remains unchanged');
    await runtime.unregister({ subjectKey: old.subjectKey }, f.caller);
    assert.deepEqual(await runtime.store.get(next.id), next, 'old owner cannot cancel the new thread subscription');
    assert.equal(f.hostTaskCalls(), 0);
  } finally { await runtime.stop(); }
});

test('independent authenticated subscribers never replace each other or consume each other’s replay', async () => {
  const f = fixture(); const runtime = new TypedWaitRuntime(f.options);
  try {
    const first = await runtime.registerPr(input, f.caller);
    for (const change of [{ userId: 'other' }, { catId: 'other' }, { threadId: 'other' }]) {
      const who = { ...f.caller, ...change };
      const other = await runtime.registerPr(input, who);
      assert.notEqual(other.id, first.id);
      const cancellation = await runtime.unregister({ subjectKey: first.subjectKey }, who);
      assert.equal(cancellation.unregistered, true);
      assert.equal(cancellation.scope, 'current_user_cat_thread');
      assert.match(cancellation.message, /other subscribers are unchanged/);
      assert.deepEqual(await runtime.store.get(first.id), first);
    }
    assert.equal(first.ownerCatId, 'astra'); assert.equal(first.userId, 'owner');
    assert.equal(f.hostTaskCalls(), 0);
  } finally { await runtime.stop(); }
});

test('unregister reports the caller scope even when this subscriber has no registration', async () => {
  const f = fixture(); const runtime = new TypedWaitRuntime(f.options);
  try {
    const result = await runtime.unregister({ subjectKey: 'pr:owner/repo#1' }, f.caller);
    assert.equal(result.unregistered, false);
    assert.equal(result.scope, 'current_user_cat_thread');
    assert.match(result.message, /other subscribers are unchanged/);
  } finally { await runtime.stop(); }
});

test('pending delivery recovers after restart with an ordinary message and no Host projection', async () => {
  const f = fixture(); let runtime = new TypedWaitRuntime(f.options);
  const task = await runtime.registerPr(input, f.caller);
  f.failSend(true);
  f.setSnapshot({ ...f.snapshot(), comments: [{ id: 5, author: 'reviewer', body: 'result', commentType: 'conversation' }] });
  await runtime.poll('pr');
  assert.equal(f.sent.length, 0);
  assert.equal((await runtime.store.get(task.id))?.automationState?.waitOutcome?.delivery, 'pending');
  await runtime.stop(); f.failSend(false);
  runtime = new TypedWaitRuntime(f.options); await runtime.recover();
  assert.equal(f.sent.length, 1);
  assert.doesNotMatch(JSON.stringify(f.sent), /waitContinuationCarrier|holdTaskId|invocationId|ownerFence/);
  assert.equal((await runtime.store.get(task.id))?.automationState?.waitOutcome?.delivery, 'delivered');
  assert.equal(f.hostTaskCalls(), 0); await runtime.stop();
});

test('unknown private registration result replays its durable receipt without a new baseline', async () => {
  const f = fixture(); const runtime = new TypedWaitRuntime(f.options);
  const cas = f.context.storage.compareAndSet;
  let lost = false;
  f.context.storage.compareAndSet = async (...args) => {
    const result = await cas(...args);
    if (args[0].startsWith('github.typed-wait.v1.') && result.applied && !lost) { lost = true; throw new Error('response lost'); }
    return result;
  };
  await assert.rejects(runtime.registerPr(input, f.caller), /response lost/);
  assert.equal([...f.rows.keys()].filter(key => key.startsWith('github.typed-wait.v1.')).length, 1); assert.equal(f.reads(), 1);
  f.context.storage.compareAndSet = cas;
  f.defer(async () => { throw new Error('provider offline'); });
  const replay = await runtime.registerPr(input, f.caller);
  assert.equal(replay.automationState?.await?.generation, 1);
  assert.equal(f.reads(), 1); assert.equal(f.hostTaskCalls(), 0);
  await runtime.stop();
});

test('delivered private outcome is not resent during offline polling', async () => {
  const f = fixture(); const runtime = new TypedWaitRuntime(f.options);
  const task = await runtime.registerPr(input, f.caller);
  f.setSnapshot({ ...f.snapshot(), comments: [{ id: 5, author: 'reviewer', body: 'result', commentType: 'conversation' }] });
  await runtime.poll('pr'); assert.equal(f.sent.length, 1);
  f.defer(async () => { throw new Error('offline'); }); await runtime.poll('pr');
  assert.equal(f.sent.length, 1);
  assert.equal((await runtime.store.get(task.id))?.automationState?.waitOutcome?.delivery, 'delivered');
  assert.equal(f.hostTaskCalls(), 0); await runtime.stop();
});

test('typed runtime freezes baseline, uses Host identity and replays registration without provider reads', async () => {
  const f = fixture(); const runtime = new TypedWaitRuntime(f.options);
  try {
    await assert.rejects(runtime.registerPr({ ...input, catId: 'forged' }, f.caller));
    assert.equal(f.reads(), 0);
    const registered = await runtime.registerPr(input, f.caller);
    assert.equal(registered.ownerCatId, 'astra'); assert.equal(registered.automationState?.await?.generation, 1);
    assert.equal(f.sent.length, 0); assert.equal(f.reads(), 1);
    f.defer(async () => { throw new Error('offline'); });
    assert.deepEqual(await runtime.registerPr(input, f.caller), registered); assert.equal(f.reads(), 1);
    await assert.rejects(runtime.registerPr(input, { ...f.caller, catId: 'other' }), /offline/);
    assert.deepEqual(await runtime.store.get(registered.id), registered);
  } finally { await runtime.stop(); }
});

test('stale invocation after provider work creates neither task nor private wait', async () => {
  const f = fixture(); f.defer(async () => { f.stale(); return f.snapshot(); });
  const runtime = new TypedWaitRuntime(f.options);
  await assert.rejects(runtime.registerPr(input, f.caller), /stale invocation/);
  assert.equal(f.hostTaskCalls(), 0); assert.equal((await runtime.store.listByKind('pr_tracking')).length, 0); await runtime.stop();
});

test('replaying an old receipt never resurrects a cancelled task or changes its notification coverage', async () => {
  const f = fixture(); const runtime = new TypedWaitRuntime(f.options);
  const first = await runtime.registerPr(input, f.caller);
  await runtime.unregister({ subjectKey: 'pr:owner/repo#1' }, f.caller);
  assert.equal((await runtime.store.get(first.id))?.status, 'done');
  f.defer(async () => { throw new Error('offline'); });
  assert.deepEqual(await runtime.registerPr(input, f.caller), first);
  assert.equal((await runtime.store.get(first.id))?.status, 'done');
  assert.equal((await runtime.store.get(first.id))?.automationState?.await, undefined);
  assert.ok((first as any).notification?.perspective);
  await runtime.stop();
});

test('an expired wait terminates even when the provider is unavailable', async () => {
  const f = fixture(); let now = 1000;
  const runtime = new TypedWaitRuntime({ ...f.options, now: () => now });
  const first = await runtime.registerPr({ ...input, expiresAt: 2000 }, f.caller);
  f.defer(async () => { throw new Error('offline'); }); now = 2001;
  await runtime.poll('pr');
  assert.equal(f.reads(), 1, 'expiration needs no provider read');
  assert.equal((await runtime.store.get(first.id))?.automationState?.await, undefined);
  assert.equal(f.sent.length, 1);
  await runtime.stop();
});

test('poll delivers typed result once, renews, and recovers pending delivery after restart/provider failure', async () => {
  const f = fixture(); let runtime = new TypedWaitRuntime(f.options);
  const first = await runtime.registerPr(input, f.caller);
  f.setSnapshot({ ...f.snapshot(), comments: [{ id: 5, author: 'reviewer', body: 'not copied', commentType: 'conversation' }] });
  f.failSend(true); await runtime.poll('pr');
  assert.equal(f.sent.length, 0); await runtime.stop();
  f.failSend(false); f.defer(async () => { throw new Error('provider down'); });
  runtime = new TypedWaitRuntime(f.options);
  await runtime.recover(); assert.equal(f.sent.length, 1);
  await runtime.recover(); assert.equal(f.sent.length, 1);
  const stored = await runtime.store.get(first.id);
  assert.equal(stored?.automationState?.await?.generation, 2);
  assert.equal(stored?.automationState?.waitOutcome?.delivery, 'delivered');
  assert.match(JSON.stringify(f.sent), /github-wait/); assert.doesNotMatch(JSON.stringify(f.sent), /not copied/);
  assert.equal((await runtime.store.lifecycleEvents(first.id)).length, 1);
  await runtime.unregister({ subjectKey: 'pr:owner/repo#1' }, f.caller);
  assert.equal((await runtime.store.get(first.id))?.automationState?.await, undefined);
  await runtime.stop();
});

test('stop aborts and joins outstanding provider work; late result never changes baseline or sends', async () => {
  const f = fixture(); const runtime = new TypedWaitRuntime(f.options);
  await runtime.registerPr(input, f.caller);
  let release!: (value: GitHubSnapshot) => void;
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  f.defer(() => { entered(); return new Promise(resolve => { release = resolve; }); });
  const before = structuredClone([...f.rows]);
  const poll = runtime.poll('pr'); await started;
  let stopped = false; const stop = runtime.stop().then(() => { stopped = true; });
  await Promise.resolve(); assert.equal(stopped, false);
  release({ ...f.snapshot(), ci: 'pass' }); await Promise.all([poll, stop]);
  assert.deepEqual([...f.rows], before); assert.equal(f.sent.length, 0);
  await assert.rejects(runtime.registerPr({ ...input, registrationId: 'new' }, f.caller), /stopped/);
});

test('issue default audience ignores self, renews from the matched snapshot, and ends on close', async () => {
  const f = fixture(); f.setSnapshot({ state: 'open', commentsComplete: true, comments: [], reviews: [],
    trackingIdentity: { selfLogin: 'self', subjectAuthorLogin: 'author' } });
  const runtime = new TypedWaitRuntime(f.options);
  const first = await runtime.registerIssue({ registrationId: 'issue-request', repoFullName: 'owner/repo', issueNumber: 1 }, f.caller);
  const comment = (id: number, author: string) => ({ id, author, body: 'private body', commentType: 'conversation' as const });
  f.setSnapshot({ ...f.snapshot(), comments: [comment(1, 'self')] });
  await runtime.poll('issue'); assert.equal(f.sent.length, 0);
  f.setSnapshot({ ...f.snapshot(), comments: [comment(1, 'self'), comment(2, 'author')] });
  await runtime.poll('issue'); assert.equal(f.sent.length, 1);
  await runtime.poll('issue'); assert.equal(f.sent.length, 1);
  f.setSnapshot({ ...f.snapshot(), state: 'closed', comments: [...f.snapshot().comments, comment(3, 'reviewer')] });
  await runtime.poll('issue'); assert.equal(f.sent.length, 2);
  assert.equal((await runtime.store.get(first.id))?.status, 'done');
  assert.equal((await runtime.store.get(first.id))?.automationState?.await, undefined);
  const reads = f.reads(); await runtime.poll('issue'); assert.equal(f.reads(), reads);
  assert.doesNotMatch(JSON.stringify(f.sent), /private body/);
  await runtime.stop();
});

test('an unavailable thread pauses delivery without retiring private tracking', async () => {
  const f = fixture(); const runtime = new TypedWaitRuntime(f.options);
  const task = await runtime.registerPr(input, f.caller);
  f.threadAvailable(false);
  f.setSnapshot({ ...f.snapshot(), comments: [{ id: 5, author: 'reviewer', body: 'result', commentType: 'conversation' }] });
  await runtime.poll('pr');
  assert.equal(f.sent.length, 0); assert.equal(f.reads(), 2);
  assert.ok((await runtime.store.get(task.id))?.automationState?.await);
  f.threadAvailable(true); await runtime.poll('pr'); assert.equal(f.sent.length, 1);
  assert.equal(f.hostTaskCalls(), 0); await runtime.stop();
});

test('production typed polling consumes one scoped CI batch and retains healthy sibling wake idempotency', async () => {
  const f = fixture(); let batches = 0, scopedReads = 0; const healthy = { ...f.snapshot(), ci: 'pass' as const };
  const provider = { ...f.options.provider, forCiBatch: async (targets: readonly { number: number }[]) => {
    batches++; if (batches === 1) assert.deepEqual(targets.map(t => t.number).sort(), [1, 2]);
    return { read: async (target: { number: number }, signal: AbortSignal) => {
      scopedReads++; signal.throwIfAborted();
      if (target.number === 1) throw new Error('PR-local detail unavailable');
      return healthy;
    } };
  } };
  const runtime = new TypedWaitRuntime({ ...f.options, provider });
  try {
    const bad = await runtime.registerPr({ ...input, when: [{ kind: 'pr_ci_terminal' }] }, f.caller);
    const good = await runtime.registerPr({ ...input, prNumber: 2, registrationId: 'second', when: [{ kind: 'pr_ci_terminal' }] }, f.caller);
    const generation = (await runtime.store.get(bad.id))!.automationState!.await!.generation;
    await runtime.poll('pr');
    assert.equal(batches, 1); assert.equal(scopedReads, 2);
    assert.equal((await runtime.store.get(bad.id))!.automationState!.await!.generation, generation);
    assert.equal((await runtime.store.get(good.id))!.automationState!.waitOutcome!.delivery, 'delivered');
    assert.equal(f.sent.length, 1);
    await runtime.poll('pr'); assert.equal(f.sent.length, 1);
  } finally { await runtime.stop(); }
});


import { GitHubProvider } from './github-provider.js';

test('real CI transport isolates detail/truncation deadlines and resolves the configured token for each phase', async t => {
  for (const mode of ['failure', 'truncated'] as const) {
    const f = fixture(); let polling = false, token = 'isolated-batch-token', batches = 0;
    const calls: { args: string[]; token?: string; signal?: AbortSignal }[] = [];
    const localSignals: AbortSignal[] = [];
    const head = 'a'.repeat(40);
    const provider = new GitHubProvider({ token: async () => token, log: { warn() {} }, execFileAsync: async (_file, args, options) => {
      if (polling) calls.push({ args, token: options.env?.GITHUB_TOKEN, signal: options.signal });
      const path = args[1]!;
      if (path === 'graphql') {
        batches++; token = 'isolated-detail-token';
        const pr = (bad: boolean) => ({ headRefOid: head, state: 'OPEN', commits: { nodes: [{ commit: { statusCheckRollup: { contexts: {
          nodes: [{ __typename: 'CheckRun', name: 'gate', status: 'COMPLETED', conclusion: bad ? 'FAILURE' : 'SUCCESS' }],
          pageInfo: { hasNextPage: bad && mode === 'truncated' },
        } } } }] } });
        return { stdout: JSON.stringify({ data: { r0: { p0: pr(true), p1: pr(false) } } }) };
      }
      if (polling && args[0] === 'pr' && args[2] === '1') {
        assert.equal(path, mode === 'failure' ? 'checks' : 'view');
        const signal = options.signal!; localSignals.push(signal);
        await new Promise<void>((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason); else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
        throw new Error('unreachable');
      }
      if (args[0] === 'pr' && path === 'view') return { stdout: JSON.stringify({ headRefOid: head, state: 'OPEN', statusCheckRollup: [] }) };
      if (path === 'user') return { stdout: 'self' };
      if (/\/pulls\/(1|2)$/.test(path)) return { stdout: JSON.stringify({ state: 'open', head: { sha: head }, user: { login: 'self' } }) };
      if (path.includes('/comments?') || path.includes('/reviews?')) return { stdout: '' };
      throw new Error('Unexpected CI request ' + args.join(' '));
    } });
    const runtime = new TypedWaitRuntime({ ...f.options, provider, objectTimeoutMs: 50 });
    // Node's abort timers are unref'd; keep this isolated deadline fixture alive.
    const keepAlive = setInterval(() => {}, 1000);
    t.after(async () => { clearInterval(keepAlive); await runtime.stop(); });
    const bad = await runtime.registerPr({ ...input, when: [{ kind: 'pr_ci_terminal' }] }, f.caller);
    const good = await runtime.registerPr({ ...input, prNumber: 2, registrationId: 'second', when: [{ kind: 'pr_ci_terminal' }] }, f.caller);
    const before = structuredClone((await runtime.store.get(bad.id))!.automationState);
    polling = true; await runtime.poll('pr');
    assert.equal(batches, 1); assert.equal(localSignals.length, 1); assert.equal(localSignals[0]!.aborted, true);
    assert.equal(calls[0]!.args[1], 'graphql'); assert.equal(calls[0]!.token, 'isolated-batch-token');
    assert.ok(calls.slice(1).every(call => call.token === 'isolated-detail-token'));
    assert.ok(calls.filter(call => call.args[0] === 'pr').every(call => call.args[2] === '1'), 'healthy complete fact never falls back');
    assert.deepEqual((await runtime.store.get(bad.id))!.automationState, before, 'timeout/unknown never advances the failed PR generation');
    assert.equal((await runtime.store.get(good.id))!.automationState!.waitOutcome!.delivery, 'delivered');
    assert.equal(f.sent.length, 1);
    const deliveredGeneration = (await runtime.store.get(good.id))!.automationState!.await!.generation;
    await runtime.poll('pr');
    assert.equal(batches, 2); assert.equal(f.sent.length, 1);
    assert.equal((await runtime.store.get(good.id))!.automationState!.await!.generation, deliveredGeneration);
    clearInterval(keepAlive); await runtime.stop();
  }
});

test('registration generation changed during batch cannot consume the previous generation snapshot', async () => {
  const f = fixture(); let runtime!: TypedWaitRuntime, taskId = '', reads = 0;
  const provider = { ...f.options.provider, forCiBatch: async () => {
    const current = (await runtime.store.get(taskId))!;
    await runtime.store.patchAutomationState(taskId, { await: { ...current.automationState!.await! as GitHubPrAwaitStateV1, generation: 2 } });
    return { read: async () => { reads++; return { ...f.snapshot(), ci: 'pass' as const }; } };
  } };
  runtime = new TypedWaitRuntime({ ...f.options, provider });
  try {
    taskId = (await runtime.registerPr({ ...input, when: [{ kind: 'pr_ci_terminal' }] }, f.caller)).id;
    await runtime.poll('pr');
    assert.equal(reads, 0); assert.equal(f.sent.length, 0);
    assert.equal((await runtime.store.get(taskId))!.automationState!.await!.generation, 2);
  } finally { await runtime.stop(); }
});


test('CI batch failure still recovers a durable notification without advancing unavailable facts', async () => {
  const f = fixture(); let failBatch = false;
  const provider = { ...f.options.provider, forCiBatch: async () => {
    if (failBatch) throw new Error('batch unavailable');
    return { read: async () => ({ ...f.snapshot(), ci: 'pass' as const }) };
  } };
  const runtime = new TypedWaitRuntime({ ...f.options, provider });
  try {
    const task = await runtime.registerPr({ ...input, when: [{ kind: 'pr_ci_terminal' }] }, f.caller);
    f.failSend(true); await runtime.poll('pr');
    assert.equal(f.sent.length, 0);
    assert.equal((await runtime.store.get(task.id))!.automationState!.waitOutcome!.delivery, 'pending');
    failBatch = true; f.failSend(false); await runtime.poll('pr');
    assert.equal(f.sent.length, 1);
    assert.equal((await runtime.store.get(task.id))!.automationState!.waitOutcome!.delivery, 'delivered');
    await runtime.poll('pr'); assert.equal(f.sent.length, 1);
  } finally { await runtime.stop(); }
});

test('cancellation during shared CI admission prevents PR-local reads and wake', async () => {
  const f = fixture(); let runtime!: TypedWaitRuntime, reads = 0;
  const provider = { ...f.options.provider, forCiBatch: async () => {
    assert.equal((await runtime.unregister({ subjectKey: 'pr:owner/repo#1' }, f.caller)).unregistered, true);
    return { read: async () => { reads++; return { ...f.snapshot(), ci: 'pass' as const }; } };
  } };
  runtime = new TypedWaitRuntime({ ...f.options, provider });
  try {
    const task = await runtime.registerPr(input, f.caller);
    await runtime.poll('pr'); assert.equal(reads, 0); assert.equal(f.sent.length, 0);
    assert.equal((await runtime.store.get(task.id))!.automationState!.waitOutcome!.reason, 'user_cancel');
  } finally { await runtime.stop(); }
});


test('terminal CI observation with lost private writes is not delivered and retries without consuming its baseline', async () => {
  const f = fixture(); const runtime = new TypedWaitRuntime(f.options);
  try {
    const task = await runtime.registerPr({ ...input, when: [{ kind: 'pr_ci_terminal' }] }, f.caller);
    const before = structuredClone(Object.fromEntries(f.rows));
    f.setSnapshot({ ...f.snapshot(), state: 'merged' });
    const cas = f.context.storage.compareAndSet;
    f.context.storage.compareAndSet = async () => ({ applied: false });
    await runtime.poll('pr');
    assert.deepEqual(Object.fromEntries(f.rows), before);
    assert.equal(f.sent.length, 0);
    assert.equal((await runtime.store.get(task.id))?.automationState?.waitOutcome, undefined);
    assert.ok((await runtime.store.get(task.id))?.automationState?.await, 'private subscription remains active for retry');
    f.context.storage.compareAndSet = cas;
    await runtime.poll('pr');
    assert.equal(f.sent.length, 1);
    assert.equal((await runtime.store.get(task.id))?.automationState?.waitOutcome?.reason, 'subject_terminal');
    await runtime.poll('pr');
    assert.equal(f.sent.length, 1, 'no duplicate terminal delivery after the committed retry');
  } finally { await runtime.stop(); }
});


test('notification allowlist and blocklist filter actors without replaying filtered history', async () => {
  const f = fixture(); const runtime = new TypedWaitRuntime(f.options);
  const task = await runtime.registerPr(input, f.caller);
  f.config.set('notificationAllowlist', 'Alice, Blocked');
  f.config.set('notificationBlocklist', 'blocked');
  const comment = (id: number, author: string) => ({ id, author, body: 'not copied', commentType: 'conversation' as const });
  f.setSnapshot({ ...f.snapshot(), comments: [comment(1, 'BLOCKED'), comment(2, 'bob')] });
  await runtime.poll('pr'); assert.equal(f.sent.length, 0);
  assert.equal((await runtime.store.get(task.id))?.automationState?.await?.generation, 1);
  f.config.set('notificationAllowlist', ''); f.config.set('notificationBlocklist', '');
  await runtime.poll('pr'); assert.equal(f.sent.length, 0, 'changing policy must not replay filtered history');
  f.config.set('notificationAllowlist', 'alice');
  f.setSnapshot({ ...f.snapshot(), comments: [...f.snapshot().comments, comment(3, 'ALICE')] });
  await runtime.poll('pr'); assert.equal(f.sent.length, 1);
  assert.equal(f.hostTaskCalls(), 0); await runtime.stop();
});

test('blocked review decisions are quiet while CI status uses ordinary notification delivery', async () => {
  const f = fixture(); const runtime = new TypedWaitRuntime(f.options);
  const task = await runtime.registerPr(input, f.caller);
  f.config.set('notificationBlocklist', 'review-bot[bot]');
  f.setSnapshot({ ...f.snapshot(), reviews: [{ id: 7, author: 'review-bot[bot]', state: 'CHANGES_REQUESTED', commitId: 'a'.repeat(40) }] });
  await runtime.poll('pr'); assert.equal(f.sent.length, 0);
  f.setSnapshot({ ...f.snapshot(), ci: 'pass' });
  await runtime.poll('pr'); assert.equal(f.sent.length, 1);
  assert.equal((await runtime.store.get(task.id))?.automationState?.waitOutcome?.delivery, 'delivered');
  assert.doesNotMatch(JSON.stringify(f.sent), /waitContinuationCarrier|holdTaskId|invocationId/);
  await runtime.stop();
});


test('existing private records keep legacy Host-derived IDs and replay without Host access', async () => {
  const f = fixture(); let runtime = new TypedWaitRuntime(f.options);
  const first = await runtime.registerPr(input, f.caller); await runtime.stop();
  const [oldKey, entry] = [...f.rows].find(([key]) => key.startsWith('github.typed-wait.v1.'))!;
  const record = structuredClone(entry.value) as any;
  record.task.id = 'legacy-host-task';
  for (const receipt of Object.values(record.registrations) as any[]) receipt.result.id = 'legacy-host-task';
  f.rows.delete(oldKey);
  const key = 'github.typed-wait.v1.' + createHash('sha256').update('legacy-host-task').digest('hex');
  f.rows.set(key, { ...entry, value: record });
  f.defer(async () => { throw new Error('provider offline'); });
  runtime = new TypedWaitRuntime(f.options);
  const replay = await runtime.registerPr(input, f.caller);
  assert.equal(replay.id, 'legacy-host-task'); assert.equal([...f.rows.keys()].filter(key => key.startsWith('github.typed-wait.v1.')).length, 1);
  assert.deepEqual(replay.automationState, first.automationState);
  assert.equal(f.reads(), 1); assert.equal(f.hostTaskCalls(), 0);
  assert.equal((await runtime.unregister({ subjectKey: 'pr:owner/repo#1' }, f.caller)).unregistered, true);
  assert.equal((await runtime.store.get('legacy-host-task'))?.status, 'done');
  await runtime.stop();
});

test('native subscription registration needs no Host thread metadata reads', async () => {
  const f = fixture();
  (f.context.threads as any).get = async () => { throw new Error('content permission forbidden'); };
  (f.context.threads as any).list = async () => { throw new Error('metadata reads unnecessary'); };
  const runtime = new TypedWaitRuntime(f.options);
  const task = await runtime.registerPr(input, f.caller);
  assert.ok(task.automationState?.await);
  assert.equal(f.reads(), 1); assert.equal([...f.rows.keys()].filter(key => key.startsWith('github.typed-wait.v1.')).length, 1); assert.equal(f.hostTaskCalls(), 0);
  await runtime.stop();
});

test('registration diagnostics retain original exception details across restart and redact credentials', async () => {
  const f = fixture(); let runtime = new TypedWaitRuntime(f.options);
  (f.context.secrets as any).get = async (key: string) => key === 'token' ? 'SECRET_TOKEN' : undefined;
  f.defer(async () => { throw Object.assign(new Error('SECRET_TOKEN GitHub request failed', { cause: new Error('getaddrinfo ENOTFOUND api.github.com') }),
    { code: 403, stderr: 'gh: Forbidden (HTTP 403)\nAuthorization: Bearer other-credential\nX-Callback-Token: callback-credential' }); });
  await assert.rejects(runtime.registerPr(input, f.caller), /SECRET_TOKEN/);
  await runtime.stop(); runtime = new TypedWaitRuntime(f.options);
  try {
    const diagnostics = await runtime.diagnostics();
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0]?.phase, 'read_github');
    assert.equal(diagnostics[0]?.status, 'failed');
    assert.equal(diagnostics[0]?.code, 'provider_read_failed');
    assert.equal(diagnostics[0]?.threadId, 'thread');
    assert.doesNotMatch(JSON.stringify(diagnostics), /SECRET_TOKEN|other-credential|callback-credential|registrationId|invocationId/);
    assert.equal(diagnostics[0]?.error?.message, '[redacted] GitHub request failed');
    assert.equal(diagnostics[0]?.error?.code, 403);
    assert.match(diagnostics[0]?.error?.stderr ?? '', /Forbidden \(HTTP 403\)/);
    assert.match(diagnostics[0]?.error?.stack ?? '', /typed-wait-runtime.test/);
    assert.equal(diagnostics[0]?.error?.cause?.message, 'getaddrinfo ENOTFOUND api.github.com');
    assert.equal((await runtime.store.listByKind('pr_tracking')).length, 0);
    f.defer(async () => f.snapshot());
    await runtime.registerPr(input, f.caller);
    assert.equal((await runtime.diagnostics())[0]?.status, 'registered');
  } finally { await runtime.stop(); }
});
