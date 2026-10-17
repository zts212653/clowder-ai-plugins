import assert from 'node:assert/strict';
import test from 'node:test';
import type { FeatureContext, PluginActionContext, PluginTaskItem, PluginStorageEntry } from '@clowder-ai/plugin-sdk';
import { TypedWaitRuntime } from './typed-wait-runtime.js';
import type { GitHubSnapshot } from './tracking-runtime.js';
import type { GitHubPrAwaitStateV1 } from './business/model/types/github-wait.js';

function fixture() {
  const rows = new Map<string, PluginStorageEntry>(); const tasks = new Map<string, PluginTaskItem>();
  const sent: unknown[] = []; let revision = 0; let reads = 0; let current = true; let sendFailure = false;
  let projectionFailure = false;
  let reassignOnWrite = false;
  const raceOwner = (id: string) => { const task = tasks.get(id);
    if (reassignOnWrite && task) { reassignOnWrite = false; tasks.set(id, { ...task, ownerCatId: 'other' }); } };
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
    tasks: {
      setWait: async (id: string, input: any) => {
        if (projectionFailure) return null;
        raceOwner(id);
        const old = tasks.get(id);
        if (old && old.ownerCatId !== 'astra') throw new Error('different owner');
        if (!old || ((old as any).pluginWait?.generation ?? null) !== input.expectedGeneration) return null;
        const task = { ...old, status: input.active ? 'doing' as const : input.outcome ? 'done' as const : old.status, pluginWait: { pluginInstanceId: 'instance', generation: input.generation,
          ...(input.active ? { await: { generation: input.generation, ...input.active } } : {}),
          ...(input.outcome ? { waitOutcome: structuredClone(input.outcome) } : {}) } };
        tasks.set(id, task); return structuredClone(task);
      },
      get: async (id: string) => structuredClone(tasks.get(id) ?? null),
      getBySubject: async (subject: string) => structuredClone([...tasks.values()].find(task => task.subjectKey === subject) ?? null),
      create: async (value: Record<string, unknown>) => {
        const task = { ...value, id: 'task-' + tasks.size, createdAt: 1, updatedAt: 1, createdBy: 'system', why: '', status: 'todo' } as unknown as PluginTaskItem;
        tasks.set(task.id, task); return structuredClone(task);
      },
      updateIfThreadId: async (id: string, thread: string, value: object) => {
        raceOwner(id);
        const old = tasks.get(id); if (!old || old.threadId !== thread) return null;
        const task = { ...old, ...value }; tasks.set(id, task); return structuredClone(task);
      },
    },
    messaging: { send: async (_thread: string, draft: unknown) => {
      if (sendFailure) throw new Error('delivery unavailable'); sent.push(draft); return { messageId: 'message', threadId: 'thread' };
    } }, config: { get: async () => undefined }, log: () => {},
  } as unknown as FeatureContext;
  const caller: PluginActionContext = { catId: 'astra', userId: 'owner', threadId: 'thread', invocationId: 'turn',
    assertCurrent: async () => { if (!current) throw new Error('stale invocation'); } };
  const options = { context, provider: { read: async () => { reads++; return read ? read() : structuredClone(snapshot); } },
    coverage: async () => ({ covered: true }), now: () => 1000 };
  return { context, caller, options, tasks, rows, sent, reads: () => reads, setSnapshot: (value: GitHubSnapshot) => { snapshot = value; },
    defer: (value: () => Promise<GitHubSnapshot>) => { read = value; }, stale: () => { current = false; },
    failSend: (value: boolean) => { sendFailure = value; }, failProjection: (value: boolean) => { projectionFailure = value; },
    raceOwnerOnWrite: () => { reassignOnWrite = true; }, snapshot: () => snapshot };
}
const input = { registrationId: 'registration', repoFullName: 'owner/repo', prNumber: 1 };

test('same-thread reassignment cannot let an old registration overwrite the new owner status', async () => {
  const f = fixture(); const runtime = new TypedWaitRuntime(f.options);
  f.raceOwnerOnWrite();
  await assert.rejects(runtime.registerPr(input, f.caller), /owner/);
  const task = [...f.tasks.values()][0]!;
  assert.equal(task.ownerCatId, 'other'); assert.equal(task.status, 'todo');
  assert.equal(task.pluginWait, undefined); assert.equal(f.sent.length, 0);
  await runtime.stop();
});

test('Host projection failure retains the outbox; recovery projects active N+1 and pending N before sending', async () => {
  const f = fixture(); const runtime = new TypedWaitRuntime(f.options);
  const task = await runtime.registerPr(input, f.caller);
  f.failProjection(true);
  f.setSnapshot({ ...f.snapshot(), comments: [{ id: 5, author: 'reviewer', body: 'result', commentType: 'conversation' }] });
  await runtime.poll('pr');
  assert.equal(f.sent.length, 0);
  assert.equal((await runtime.store.get(task.id))?.automationState?.waitOutcome?.delivery, 'pending');
  f.failProjection(false);
  const send = f.context.messaging.send;
  (f.context.messaging as any).send = async (...args: any[]) => {
    const projection = (f.tasks.get(task.id) as any).pluginWait;
    assert.equal(projection.await.generation, 2);
    assert.equal(projection.waitOutcome.generation, 1);
    assert.equal(projection.waitOutcome.delivery, 'pending');
    return (send as any)(...args);
  };
  await runtime.recover();
  assert.equal(f.sent.length, 1);
  assert.equal((f.tasks.get(task.id) as any).pluginWait.waitOutcome.delivery, 'delivered');
  await runtime.stop();
});

test('unknown initial projection result is repairable by exact authenticated replay without a new baseline', async () => {
  const f = fixture(); const runtime = new TypedWaitRuntime(f.options);
  f.failProjection(true);
  await assert.rejects(runtime.registerPr(input, f.caller), /projection/);
  assert.equal(f.tasks.size, 1); assert.equal(f.reads(), 1);
  f.setSnapshot({ ...f.snapshot(), comments: [{ id: 5, author: 'reviewer', body: 'arrived', commentType: 'conversation' }] });
  await runtime.poll('pr'); assert.equal(f.reads(), 1); assert.equal(f.sent.length, 0);
  f.failProjection(false);
  const task = await runtime.registerPr(input, f.caller);
  assert.equal(f.reads(), 1); assert.equal(task.automationState?.await?.generation, 1);
  assert.equal(f.tasks.get(task.id)?.pluginWait?.generation, 1);
  await runtime.poll('pr'); assert.equal(f.sent.length, 1);
  await runtime.stop();
});

test('a failed delivered projection repairs during offline polling without resending the message', async () => {
  const f = fixture(); const runtime = new TypedWaitRuntime(f.options);
  const task = await runtime.registerPr(input, f.caller);
  const send = f.context.messaging.send;
  (f.context.messaging as any).send = async (...args: any[]) => {
    const result = await (send as any)(...args); f.failProjection(true); return result;
  };
  f.setSnapshot({ ...f.snapshot(), comments: [{ id: 5, author: 'reviewer', body: 'result', commentType: 'conversation' }] });
  await runtime.poll('pr');
  assert.equal(f.sent.length, 1); assert.equal(f.tasks.get(task.id)?.pluginWait?.waitOutcome?.delivery, 'pending');
  f.failProjection(false); f.defer(async () => { throw new Error('offline'); });
  await runtime.poll('pr');
  assert.equal(f.sent.length, 1); assert.equal(f.tasks.get(task.id)?.pluginWait?.waitOutcome?.delivery, 'delivered');
  await runtime.stop();
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
    await assert.rejects(runtime.registerPr(input, { ...f.caller, catId: 'other' }), /owner/);
  } finally { await runtime.stop(); }
});

test('stale invocation after provider work creates neither task nor private wait', async () => {
  const f = fixture(); f.defer(async () => { f.stale(); return f.snapshot(); });
  const runtime = new TypedWaitRuntime(f.options);
  await assert.rejects(runtime.registerPr(input, f.caller), /stale invocation/);
  assert.equal(f.tasks.size, 0); assert.equal(f.rows.size, 0); await runtime.stop();
});

test('replaying an old receipt never resurrects a cancelled task or changes its notification coverage', async () => {
  const f = fixture(); const runtime = new TypedWaitRuntime(f.options);
  const first = await runtime.registerPr(input, f.caller);
  await runtime.unregister({ subjectKey: 'pr:owner/repo#1' }, f.caller);
  assert.equal(f.tasks.get(first.id)?.status, 'done');
  f.defer(async () => { throw new Error('offline'); });
  assert.deepEqual(await runtime.registerPr(input, f.caller), first);
  assert.equal(f.tasks.get(first.id)?.status, 'done');
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
  assert.equal(f.tasks.get(first.id)?.status, 'done');
  assert.equal((await runtime.store.get(first.id))?.automationState?.await, undefined);
  const reads = f.reads(); await runtime.poll('issue'); assert.equal(f.reads(), reads);
  assert.doesNotMatch(JSON.stringify(f.sent), /private body/);
  await runtime.stop();
});

test('unregister rejects a different user and owner changes terminate without notifying the old destination', async () => {
  const f = fixture(); const runtime = new TypedWaitRuntime(f.options);
  const task = await runtime.registerPr(input, f.caller);
  await assert.rejects(runtime.unregister({ subjectKey: 'pr:owner/repo#1' }, { ...f.caller, userId: 'other' }), /user/);
  const host = f.tasks.get(task.id)!; f.tasks.set(task.id, { ...host, ownerCatId: 'other' });
  await runtime.poll('pr');
  assert.equal(f.sent.length, 0); assert.equal(f.reads(), 1);
  assert.equal((await runtime.store.get(task.id))?.automationState?.await, undefined);
  assert.equal(f.tasks.get(task.id)?.ownerCatId, 'other');
  await runtime.stop();
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
    assert.equal(f.tasks.get(task.id)?.pluginWait?.waitOutcome, undefined);
    assert.ok(f.tasks.get(task.id)?.pluginWait?.await, 'registration remains active for retry');
    f.context.storage.compareAndSet = cas;
    await runtime.poll('pr');
    assert.equal(f.sent.length, 1);
    assert.equal(f.tasks.get(task.id)?.pluginWait?.waitOutcome?.reason, 'subject_terminal');
    await runtime.poll('pr');
    assert.equal(f.sent.length, 1, 'no duplicate terminal delivery after the committed retry');
  } finally { await runtime.stop(); }
});
