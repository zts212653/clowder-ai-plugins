import assert from 'node:assert/strict';
import test from 'node:test';
import { definePlugin, type FeatureContext, FeatureContextRevokedError } from './feature-context.js';
import { definePluginModule } from './module-plugin.js';
import type { ModulePluginHostShape } from './module-host.js';

const source = () => ({ id: 'assignment', userId: 'owner', threadId: 'public-thread', catId: null,
  content: 'Original request', source: { connector: 'collective' }, extra: { pluginMessage: { instanceId: 'instance' } } });
const nativeTask = () => ({ userId: 'owner', threadId: 'private-thread', catId: 'cat', invocationId: 'invocation',
  originTriggerMessageId: 'dispatch-trigger', source: source(), task: { taskRef: 'task:work:task', taskRevision: 2,
    admissionRef: 'message:admission', executionRef: 'message:execution', sourceRevision: 3 } });
const prepared = () => ({ result: 'admitted' as const, taskRef: 'task:work:task', taskRevision: 2,
  threadId: 'private-thread', admissionRef: 'message:admission', executionRef: 'message:execution' });
const request = () => ({ sourceMessageId: 'assignment', targetCatId: 'cat', destination: { kind: 'derived_from_source' as const },
  subject: { kind: 'new' as const, title: 'Original task', intendedOutcome: 'Reviewable result',
    closure: { condition: 'Answer the request', expectedSignal: 'collective:accepted-result' },
    time: { businessDeadline: { value: 0, sourceRef: 'message:assignment' } } } });
async function fixture(tasks: Record<string, unknown> = {}, native?: Record<string, unknown>,
  capabilities = ['task.admitEntrusted', 'task.read', 'thread.readContent']) {
  let context!: FeatureContext;
  const manifest = { pluginId: 'dev.entrusted-task-fixture', version: '0.1.0', contractVersion: '0.1.0-beta.36', name: 'Task fixture',
    runtime: { transport: 'builtin', entrypoint: 'dist/index.js' },
    features: [{ id: 'work', name: 'Work', resources: [], capabilities }] };
  const module = definePluginModule(input => definePlugin({ manifest: input, activate: {
    work: value => { context = value; return { actions: {} }; },
  } }));
  // Controlled port implementation; no hidden Task projection or real Host authority is injected.
  const host = { config: { get: async () => undefined }, secrets: { get: async () => undefined }, storage: {},
    tasks, threads: {}, messaging: {}, media: {}, log() {}, ...(native ? { nativeContext: native } : {}) } as unknown as ModulePluginHostShape;
  const activation = await module.create(manifest as never).start(host);
  return { context, activation };
}

test('explicit Task current preserves dispatch origin and distinct owned source thread, detached and frozen', async () => {
  const calls: unknown[] = [], fact = nativeTask();
  const f = await fixture({}, { async current(input: unknown) { calls.push(input); return fact; } });
  try {
    const value = await f.context.nativeContext!.current({ includeTask: true });
    assert.deepEqual(calls, [{ includeTask: true }]); assert.deepEqual(value, fact);
    assert.ok(Object.isFrozen(value.task)); assert.ok(Object.isFrozen(value.source.extra));
    fact.task.taskRevision = 5; assert.equal(value.task.taskRevision, 2);
  } finally { await f.activation.stop(); }
});

test('Task v2 entry provenance is optional, detached/frozen and never substitutes Work basis', async () => {
  let reply: unknown = nativeTask();
  const f = await fixture({}, { async current() { return reply; } });
  try {
    const old = await f.context.nativeContext!.current({ includeTask: true });
    assert.equal(old.task.execution, undefined);
    for (const kind of ['initial', 'owner_resume', 'source_continuation'] as const) {
      const execution = { kind, firstAdmissionKind: 'installed_plugin_policy' as const, requestKind: 'owner_http_write' as const };
      reply = { ...nativeTask(), task: { ...nativeTask().task, execution } };
      const value = await f.context.nativeContext!.current({ includeTask: true });
      assert.deepEqual(value.task.execution, execution);
      assert.ok(Object.isFrozen(value.task.execution));
      assert.notEqual(value.task.execution, execution);
      assert.throws(() => { (value.task.execution as { requestKind: string }).requestKind = 'standing_grant'; }, TypeError);
      assert.equal(value.task.execution!.requestKind, 'owner_http_write');
    }
    const execution = { kind: 'initial', firstAdmissionKind: 'owner_http_write', requestKind: 'owner_http_write' };
    let reads = 0;
    const getter = Object.defineProperty({ ...execution }, 'requestKind', { enumerable: true,
      get() { reads++; return 'owner_http_write'; } });
    for (const invalid of [null, { ...execution, requestKind: 'standing_grant' }, { ...execution, businessBasis: 'manual_owner_write' },
      { ...execution, body: 'secret' }, { ...execution, request: { requestId: 'caller' } }, getter]) {
      reply = { ...nativeTask(), task: { ...nativeTask().task, execution: invalid } };
      await assert.rejects(f.context.nativeContext!.current({ includeTask: true }), TypeError);
    }
    assert.equal(reads, 0);
  } finally { await f.activation.stop(); }
});

test('a v2 Task result arriving after activation stop is refused', async () => {
  let resolve!: (value: unknown) => void;
  const f = await fixture({}, { async current() { return new Promise(r => { resolve = r; }); } });
  const pending = f.context.nativeContext!.current({ includeTask: true });
  await f.activation.stop();
  resolve({ ...nativeTask(), task: { ...nativeTask().task,
    execution: { kind: 'initial', firstAdmissionKind: 'installed_plugin_policy', requestKind: 'installed_plugin_policy' } } });
  await assert.rejects(pending, FeatureContextRevokedError);
});
test('Task current requires task.read and rejects forged selector/expanded or foreign response', async () => {
  let calls = 0, reply: unknown = nativeTask();
  const host = { async current() { calls++; return reply; } };
  const denied = await fixture({}, host, ['thread.readContent']);
  await assert.rejects(denied.context.nativeContext!.current({ includeTask: true }), /task.read/);
  assert.equal(calls, 0); await denied.activation.stop();
  const f = await fixture({}, host);
  try {
    await assert.rejects(f.context.nativeContext!.current({ includeTask: true, owner: 'forged' } as never), TypeError);
    assert.equal(calls, 0);
    reply = { ...nativeTask(), task: { ...nativeTask().task, bearer: 'forged' } };
    await assert.rejects(f.context.nativeContext!.current({ includeTask: true }), TypeError);
    reply = { ...nativeTask(), source: { ...source(), userId: 'foreign' } };
    await assert.rejects(f.context.nativeContext!.current({ includeTask: true }), TypeError);
    reply = nativeTask(); await assert.rejects(f.context.nativeContext!.current(), TypeError);
  } finally { await f.activation.stop(); }
});
test('prepare and dispatch use the narrow grant with exact selectors, frozen snapshots and no CRUD', async () => {
  const calls: unknown[] = [], result = prepared();
  const f = await fixture({ async prepareEntrusted(input: unknown) { calls.push(input); return result; },
    async dispatchEntrusted(input: unknown) { calls.push(input); return { messageRef: 'message:trigger', entryId: 'entry', status: 'queued' }; } });
  try {
    const input = request(); const task = await f.context.tasks.prepareEntrusted!(input);
    assert.deepEqual(calls[0], input); assert.ok(Object.isFrozen(calls[0])); assert.ok(Object.isFrozen(task));
    assert.equal(task.result, 'admitted');
    const receipt = await f.context.tasks.dispatchEntrusted!({ taskRef: 'task:work:task', taskRevision: 2, executionRef: 'message:execution' });
    assert.deepEqual(receipt, { messageRef: 'message:trigger', entryId: 'entry', status: 'queued' });
    assert.ok(Object.isFrozen(receipt));
    assert.deepEqual(calls[1], { taskRef: 'task:work:task', taskRevision: 2, executionRef: 'message:execution' });
    assert.equal(f.context.tasks.create !== undefined, true); // The old API exists; it is never used by these effects.
  } finally { await f.activation.stop(); }
});
test('Task method input and response reject body authority, malformed time/closure and effect shape drift', async () => {
  let calls = 0, reply: unknown = prepared();
  const f = await fixture({ async prepareEntrusted() { calls++; return reply; },
    async dispatchEntrusted() { calls++; return { messageRef: 'wrong', entryId: 'entry', status: 'completed' }; } });
  try {
    for (const input of [{ ...request(), ownerUserId: 'forged' }, { ...request(), subject: { ...request().subject,
      time: { businessDeadline: { value: -1, sourceRef: 'message:assignment' } } } },
      { ...request(), subject: { ...request().subject, closure: { condition: 'x', expectedSignal: 'y', authority: 'forged' } } }])
      await assert.rejects(f.context.tasks.prepareEntrusted!(input as never), TypeError);
    assert.equal(calls, 0);
    reply = { ...prepared(), grant: 'forged' }; await assert.rejects(f.context.tasks.prepareEntrusted!(request()), TypeError);
    await assert.rejects(f.context.tasks.dispatchEntrusted!({ taskRef: 'task:work:task', taskRevision: 2, executionRef: 'message:execution' }), TypeError);
  } finally { await f.activation.stop(); }
});
test('continuation and clarification retain actual result semantics without dispatching automatically', async () => {
  const calls: unknown[] = [];
  const f = await fixture({ async prepareEntrusted(input: unknown) { calls.push(input); return { result: 'needs_clarification', clarificationReason: 'missing_closure' }; } });
  try {
    const input = { sourceMessageId: 'current-notice', targetCatId: 'cat', destination: { kind: 'existing_thread' as const, threadId: 'private-thread' },
      subject: { kind: 'continue' as const, taskRef: 'task:work:task', expectedRevision: 2 } };
    assert.deepEqual(await f.context.tasks.prepareEntrusted!(input), { result: 'needs_clarification', clarificationReason: 'missing_closure' });
    assert.deepEqual(calls, [input]); assert.equal(f.context.tasks.dispatchEntrusted, undefined);
  } finally { await f.activation.stop(); }
});
test('missing grant prevents Host effects and stop rejects late Task responses without retries', async () => {
  let calls = 0; const host = { async prepareEntrusted() { calls++; return prepared(); } };
  const denied = await fixture(host, undefined, []);
  await assert.rejects(denied.context.tasks.prepareEntrusted!(request()), /task.admitEntrusted/);
  assert.equal(calls, 0); await denied.activation.stop();
  let resolve!: (value: ReturnType<typeof prepared>) => void;
  const f = await fixture({ async prepareEntrusted() { calls++; return new Promise(r => { resolve = r; }); } });
  const pending = f.context.tasks.prepareEntrusted!(request());
  await f.activation.stop(); resolve(prepared());
  await assert.rejects(pending, FeatureContextRevokedError);
  await assert.rejects(f.context.tasks.prepareEntrusted!(request()), FeatureContextRevokedError);
  assert.equal(calls, 1);
});

test('prepare mirrors Host trim and UTF-16 string limits without touching malformed input getters', async () => {
  const calls: unknown[] = [];
  const f = await fixture({ async prepareEntrusted(input: unknown) { calls.push(input); return prepared(); } });
  try {
    const input = request(); input.subject.title = ' 😀' + '😀'.repeat(99) + ' ';
    await f.context.tasks.prepareEntrusted!(input);
    assert.equal((calls[0] as ReturnType<typeof request>).subject.title, '😀'.repeat(100));
    input.subject.title = '😀'.repeat(101);
    await assert.rejects(f.context.tasks.prepareEntrusted!(input), TypeError);
    assert.equal(calls.length, 1);
    let reads = 0;
    const malformed = Object.defineProperty(request(), 'sourceMessageId', {
      enumerable: true, get() { reads++; return 'assignment'; },
    });
    await assert.rejects(f.context.tasks.prepareEntrusted!(malformed), TypeError);
    assert.equal(reads, 0); assert.equal(calls.length, 1);
  } finally { await f.activation.stop(); }
});
