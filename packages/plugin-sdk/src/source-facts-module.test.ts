import assert from 'node:assert/strict';
import test from 'node:test';
import { definePlugin, type FeatureContext, FeatureContextRevokedError } from './feature-context.js';
import { definePluginModule } from './module-plugin.js';
import type { ModulePluginHostShape } from './module-host.js';
function source() { return { id: 'origin', userId: 'owner', threadId: 'thread', catId: null, content: 'body',
  source: { connector: 'neutral', meta: { participation: { revision: 3 } } }, extra: { pluginMessage: { instanceId: 'instance' } } }; }
function native() { return { userId: 'owner', threadId: 'thread', catId: 'cat', invocationId: 'inv', originTriggerMessageId: 'origin', source: source() }; }
async function fixture(ports: Record<string, unknown> = {}, capabilities = ['thread.readContent']) {
  let context!: FeatureContext;
  const manifest = { pluginId: 'dev.source-facts-fixture', version: '0.1.0', contractVersion: '0.1.0-beta.36', name: 'Source fixture', runtime: { transport: 'builtin', entrypoint: 'dist/index.js' },
    features: [{ id: 'facts', name: 'Facts', resources: [], capabilities }] };
  const module = definePluginModule(input => definePlugin({ manifest: input, activate: { facts: value => { context = value; return { actions: {} }; } } }));
  const host = { config: { get: async () => undefined }, secrets: { get: async () => undefined }, storage: {}, tasks: {}, threads: {}, messaging: {}, media: {}, log() {}, ...ports } as unknown as ModulePluginHostShape;
  const activation = await module.create(manifest as never).start(host);
  return { context, activation };
}
// Untyped hostile inputs below exercise the protocol boundary rather than the TypeScript caller.
function portsOf(context: FeatureContext) { return context as unknown as {
  sourceFacts?: { read(input: unknown): Promise<ReturnType<typeof source>> };
  nativeContext?: { current(): Promise<ReturnType<typeof native>> };
}; }
test('module forwards source facts and exact native origin, detached and deeply frozen', async () => {
  const calls: unknown[] = []; const fact = source(), current = native();
  const { context, activation } = await fixture({ sourceFacts: { async read(input: unknown) { calls.push(input); return fact; } },
    nativeContext: { async current(...args: unknown[]) { calls.push(args); return current; } } });
  const ports = portsOf(context); assert.ok(ports.sourceFacts, 'Missing module sourceFacts port'); assert.ok(ports.nativeContext, 'Missing module nativeContext port');
  const got = await ports.sourceFacts.read({ messageRef: 'message:origin' }); const ctx = await ports.nativeContext.current();
  assert.deepEqual(calls, [{ messageRef: 'message:origin' }, []]); assert.deepEqual(got, fact); assert.deepEqual(ctx, current);
  assert.ok(Object.isFrozen(got.source.meta.participation)); assert.ok(Object.isFrozen(ctx.source.extra.pluginMessage));
  fact.source.meta.participation.revision = 9; current.source.content = 'changed';
  assert.equal(got.source.meta.participation.revision, 3); assert.equal(ctx.source.content, 'body');
  await activation.stop();
});
test('older carriers keep each source port absent and supplied incomplete ports fail closed', async () => {
  const { context, activation } = await fixture(); assert.equal(portsOf(context).sourceFacts, undefined); assert.equal(portsOf(context).nativeContext, undefined); await activation.stop();
  await assert.rejects(fixture({ sourceFacts: {} }), /source facts port/);
  await assert.rejects(fixture({ nativeContext: {} }), /native context port/);
});
test('source ports require existing content grant before either Host call', async () => {
  let calls = 0; const { context, activation } = await fixture({ sourceFacts: { async read() { calls++; return source(); } }, nativeContext: { async current() { calls++; return native(); } } }, []);
  const ports = portsOf(context); assert.ok(ports.sourceFacts); assert.ok(ports.nativeContext);
  await assert.rejects(() => ports.sourceFacts!.read({ messageRef: 'message:origin' }), /thread.readContent/);
  await assert.rejects(() => ports.nativeContext!.current(), /thread.readContent/); assert.equal(calls, 0); await activation.stop();
});
test('source input rejects caller authority and native current rejects a body without sending it', async () => {
  let calls = 0; const { context, activation } = await fixture({ sourceFacts: { async read() { calls++; return source(); } }, nativeContext: { async current() { calls++; return native(); } } });
  const ports = portsOf(context); assert.ok(ports.sourceFacts); assert.ok(ports.nativeContext);
  await assert.rejects(() => ports.sourceFacts!.read({ messageRef: 'message:origin', userId: 'forged' }), TypeError);
  const current = ports.nativeContext.current as (body?: unknown) => Promise<unknown>;
  await assert.rejects(() => current({ originTriggerMessageId: 'other' }), TypeError); assert.equal(calls, 0); await activation.stop();
});
test('owner/native Host refusal is preserved with no retries or generic read fallback', async () => {
  const refusal = new Error('DELIVERY_REJECTED'); let calls = 0;
  const { context, activation } = await fixture({ sourceFacts: { async read() { calls++; throw refusal; } }, nativeContext: { async current() { calls++; throw refusal; } } });
  const ports = portsOf(context); assert.ok(ports.sourceFacts); assert.ok(ports.nativeContext);
  await assert.rejects(() => ports.sourceFacts!.read({ messageRef: 'message:origin' }), e => e === refusal);
  await assert.rejects(() => ports.nativeContext!.current(), e => e === refusal); assert.equal(calls, 2); await activation.stop();
});
test('both source ports reject late response after stop and do not send later calls', async () => {
  let finishRead!: (value: ReturnType<typeof source>) => void; let finishCurrent!: (value: ReturnType<typeof native>) => void; let calls = 0;
  const { context, activation } = await fixture({ sourceFacts: { async read() { calls++; return new Promise(resolve => { finishRead = resolve; }); } }, nativeContext: { async current() { calls++; return new Promise(resolve => { finishCurrent = resolve; }); } } });
  const ports = portsOf(context); assert.ok(ports.sourceFacts); assert.ok(ports.nativeContext);
  const read = ports.sourceFacts.read({ messageRef: 'message:origin' }), current = ports.nativeContext.current();
  await activation.stop(); finishRead(source()); finishCurrent(native());
  await assert.rejects(read, FeatureContextRevokedError); await assert.rejects(current, FeatureContextRevokedError);
  await assert.rejects(() => ports.sourceFacts!.read({ messageRef: 'message:origin' }), FeatureContextRevokedError);
  await assert.rejects(() => ports.nativeContext!.current(), FeatureContextRevokedError); assert.equal(calls, 2);
});
test('source and native Host responses reject expanded Work or private fields', async () => {
  const { context, activation } = await fixture({ sourceFacts: { async read() { return { ...source(), receipt: {} }; } }, nativeContext: { async current() { return { ...native(), binding: {} }; } } });
  const ports = portsOf(context); assert.ok(ports.sourceFacts); assert.ok(ports.nativeContext);
  await assert.rejects(() => ports.sourceFacts!.read({ messageRef: 'message:origin' }), /PluginSourceFact/);
  await assert.rejects(() => ports.nativeContext!.current(), /PluginNativeContext/); await activation.stop();
});


function progressFact() {
  const { content: _body, ...identity } = source();
  return { ...identity, queueCustody: { status: 'processing', allTargetCats: ['cat'], handledByCatIds: [],
    failedByCatIds: [], seenByCatIds: ['cat'], bodyExposures: [{ targetCatId: 'cat' }],
    targetOutcomeByCatId: { cat: { handledAt: 42 } } } };
}
test('existing sourceFacts carries content-free owner progress, detached and immutable', async () => {
  const fact = progressFact(), calls: unknown[] = [];
  const { context, activation } = await fixture({ sourceFacts: { async read() { throw new Error('Must not read queued body'); },
    async readProgress(input: unknown) { calls.push(input); return fact; } } });
  try {
    assert.equal(typeof context.sourceFacts!.readProgress, 'function');
    const got = await context.sourceFacts!.readProgress!({ messageRef: 'message:origin' });
    assert.deepEqual(got, fact); assert.ok(!('content' in got));
    assert.ok(Object.isFrozen(got.queueCustody)); assert.ok(Object.isFrozen(got.queueCustody!.targetOutcomeByCatId!.cat));
    fact.queueCustody.allTargetCats.push('later'); assert.deepEqual(got.queueCustody!.allTargetCats, ['cat']);
    assert.deepEqual(calls, [{ messageRef: 'message:origin' }]);
  } finally { await activation.stop(); }
});
test('older sourceFacts carriers keep progress absent and malformed advertised ports fail activation', async () => {
  const f = await fixture({ sourceFacts: { async read() { return source(); } } });
  assert.equal(f.context.sourceFacts!.readProgress, undefined); await f.activation.stop();
  await assert.rejects(fixture({ sourceFacts: { async read() { return source(); }, readProgress: true } }), /readProgress/);
});
test('owner progress checks content grant/input and propagates exact owner/native refusal without body fallback', async () => {
  const refusal = new Error('Current owner required'); let progressCalls = 0, bodyCalls = 0;
  const host = { async read() { bodyCalls++; return source(); }, async readProgress() { progressCalls++; throw refusal; } };
  const denied = await fixture({ sourceFacts: host }, []);
  await assert.rejects(() => denied.context.sourceFacts!.readProgress!({ messageRef: 'message:origin' }), /thread.readContent/);
  assert.equal(progressCalls, 0); await denied.activation.stop();
  const f = await fixture({ sourceFacts: host });
  try {
    await assert.rejects(() => f.context.sourceFacts!.readProgress!({ messageRef: 'message:origin', userId: 'forged' } as never), TypeError);
    assert.equal(progressCalls, 0);
    await assert.rejects(() => f.context.sourceFacts!.readProgress!({ messageRef: 'message:origin' }), error => error === refusal);
    assert.equal(progressCalls, 1); assert.equal(bodyCalls, 0);
  } finally { await f.activation.stop(); }
});
test('owner progress rejects body, hidden Queue authority and an unrelated message response', async () => {
  let fact: unknown = progressFact();
  const f = await fixture({ sourceFacts: { async read() { throw new Error('No fallback'); }, async readProgress() { return fact; } } });
  try {
    const base = progressFact();
    for (const invalid of [{ ...base, content: 'private queued body' }, { ...base, id: 'other' },
      { ...base, queueCustody: { ...base.queueCustody, invocationWitnesses: [{ invocationId: 'private' }] } },
      { ...base, queueCustody: { ...base.queueCustody, targetOutcomeByCatId: { cat: { handledAt: 1, evidence: 'private' } } } },
      { ...base, queueCustody: { ...base.queueCustody, bodyExposures: [{ targetCatId: 'cat', body: 'private' }] } },
      { ...base, queueCustody: { ...base.queueCustody, executionScope: 'collective-participation' } }]) {
      fact = invalid;
      await assert.rejects(() => f.context.sourceFacts!.readProgress!({ messageRef: 'message:origin' }), /progress/i);
    }
    const { queueCustody: _absent, ...identity } = base; fact = identity;
    assert.deepEqual(await f.context.sourceFacts!.readProgress!({ messageRef: 'message:origin' }), identity);
  } finally { await f.activation.stop(); }
});
test('owner progress rejects a late response and calls after feature stop', async () => {
  let finish!: (value: ReturnType<typeof progressFact>) => void, calls = 0;
  const f = await fixture({ sourceFacts: { async read() { throw new Error('No fallback'); },
    async readProgress() { calls++; return new Promise(resolve => { finish = resolve; }); } } });
  const pending = f.context.sourceFacts!.readProgress!({ messageRef: 'message:origin' });
  await f.activation.stop(); finish(progressFact());
  await assert.rejects(pending, FeatureContextRevokedError);
  await assert.rejects(() => f.context.sourceFacts!.readProgress!({ messageRef: 'message:origin' }), FeatureContextRevokedError);
  assert.equal(calls, 1);
});

if (process.env.C1_SOURCE_PROGRESS_HOST_ROOT) test('actual compiled Host Queue transitions cross the SDK without body or invocation authority', async () => {
  const base = process.env.C1_SOURCE_PROGRESS_HOST_ROOT!;
  const { MessageStore } = await import(`${base}/domains/cats/services/stores/ports/MessageStore.js`);
  const { createInitialQueuedMessageCustody } = await import(`${base}/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js`);
  const { createPluginSourceFactsHost } = await import(`${base}/domains/plugin/host-surface/plugin-source-facts-host.js`);
  const { withPluginOwnerRequest, withPluginOwnerWebhook } = await import(`${base}/domains/plugin/carrier/plugin-owner-request-context.js`);
  const { withPluginCallContext } = await import(`${base}/domains/plugin/carrier/plugin-call-context.js`);
  for (const stage of ['queued', 'started', 'failed', 'ended']) {
    const store = new MessageStore();
    const custody = createInitialQueuedMessageCustody({ id: 'entry', threadId: 'thread', userId: 'owner',
      ownerAuthProvenance: 'unknown', source: 'connector', content: 'private queued body', messageId: 'source',
      mergedMessageIds: [], targetCats: ['cat'], allTargetCats: ['cat'], intent: 'execute', autoExecute: true,
      status: 'queued', priority: 'normal', createdAt: 1000 });
    const message = store.append({ userId: 'owner', threadId: 'thread', catId: null, content: 'private queued body',
      mentions: ['cat'], timestamp: 1000, deliveryStatus: 'queued', queueCustody: custody,
      source: { connector: 'neutral', meta: { participation: { connectionId: 'connection', eventId: 'event', catId: 'cat' } } },
      extra: { pluginMessage: { instanceId: 'instance', revision: 1 }, privateField: 'not-visible' } });
    if (stage !== 'queued') {
      const current = store.getById(message.id).queueCustody;
      const next = { ...current, revision: current.revision + 1, status: 'processing', updatedAt: 2000,
        bodyExposures: [{ targetCatId: 'cat', invocationId: 'private-child', seenAt: 1100 }],
        seenByCatIds: ['cat'], seenInvocationIdByCatId: { cat: 'private-child' } };
      if (stage === 'failed') next.failedByCatIds = ['cat'];
      if (stage === 'ended') Object.assign(next, { status: 'terminal', pendingTargetCats: [], handledByCatIds: ['cat'],
        targetOutcomeByCatId: { cat: { invocationId: 'private-child', disposition: 'completed_with_turn',
          evidenceRef: { kind: 'turn_execution', invocationId: 'private-child' }, handledAt: 2000 } } });
      const transition = store.transitionQueueCustody(message.id, { expectedRevision: current.revision, next,
        ...(stage === 'ended' ? { deliveredAt: 2000 } : {}) });
      assert.equal(transition.kind, 'updated');
    }
    const host = createPluginSourceFactsHost({ pluginInstanceId: 'instance', ownerUserId: 'owner',
      messageStore: { async getById(id: string) { return structuredClone(store.getById(id)); } },
      threadStore: { async get() { return { id: 'thread', createdBy: 'owner' }; } }, assertCurrent: async () => {} });
    const owner = (operation: () => unknown, userId = 'owner') => withPluginOwnerRequest({ pluginId: 'neutral',
      contributionId: 'owner', userId, operation: 'read', signal: new AbortController().signal },
      () => withPluginOwnerWebhook('neutral', 'owner', 'instance', false, () => {}, operation));
    const f = await fixture({ sourceFacts: host.sourceFacts });
    try {
      const input = { messageRef: `message:${message.id}` } as const;
      const fact = await owner(() => f.context.sourceFacts!.readProgress!(input)) as import('./source-progress.js').PluginSourceProgressFact;
      assert.equal(fact.queueCustody!.status, stage === 'queued' ? 'queued' : stage === 'ended' ? 'terminal' : 'processing');
      assert.deepEqual(fact.queueCustody!.handledByCatIds, stage === 'ended' ? ['cat'] : []);
      assert.deepEqual(fact.queueCustody!.failedByCatIds, stage === 'failed' ? ['cat'] : []);
      assert.deepEqual(fact.queueCustody!.targetOutcomeByCatId, stage === 'ended' ? { cat: { handledAt: 2000 } } : undefined);
      assert.ok(!JSON.stringify(fact).includes('private-child')); assert.ok(!('content' in fact));
      assert.ok(!('executionScope' in fact.queueCustody!));
      if (stage === 'queued') await assert.rejects(() => owner(() => f.context.sourceFacts!.read(input)));
      await assert.rejects(() => owner(() => f.context.sourceFacts!.readProgress!(input), 'foreign-owner'));
      await assert.rejects(() => withPluginCallContext('instance', { userId: 'owner', threadId: 'thread', catId: 'cat',
        invocationId: 'inv', originTriggerMessageId: message.id, assertCurrent: async () => {}, assertInvocationCurrent: async () => {} },
        () => f.context.sourceFacts!.readProgress!(input)));
    } finally { await f.activation.stop(); }
  }
});
