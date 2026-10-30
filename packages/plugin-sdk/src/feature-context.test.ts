import assert from 'node:assert/strict';
import test from 'node:test';

import type { StaticContribution } from '@clowder-ai/plugin-contract';

import {
  FeatureContextRevokedError,
  activateDefinedFeature,
  createFeatureContextSession,
  definePlugin,
  type FeatureBinding,
  type FeatureContext,
  type FeatureHostAdapter,
} from './feature-context.js';
import { definePluginModule, requirePluginModuleEntrypoint } from './module-plugin.js';

const BINDING: FeatureBinding = {
  pluginInstanceId: 'instance-1',
  featureId: 'feature-1',
  packageRevision: 'package-1',
  integrityEpoch: 4,
  activationRevision: 7,


  executionLease: 'opaque-host-signed-lease',
};

test('accepted thread projections and preferredCats patch cross the real FeatureContext wrapper', async () => {
  const adapter = new RecordingAdapter();
  const seen: unknown[] = [];
  Object.assign(adapter.threads, {
    async list(options?: unknown) { seen.push(['list', options]); return []; },
    async readMessages(id: string, options: unknown) { seen.push(['readMessages', id, options]); return []; },
    async getCats(id: string) { seen.push(['getCats', id]); return { participants: [], routableNow: [], routableNotJoined: [], notRoutable: [] }; },
    async update(id: string, patch: unknown) { seen.push(['update', id, patch]); return { id, deepLinkUrl: 'https://owner.example/thread/projected', title: null, createdAt: 1, lastActiveAt: 1, featureRefs: [], preferredCats: [] }; },
  addParticipants: async () => { throw new Error('unused fixture addParticipants'); },
});
  const session = createFeatureContextSession(BINDING, adapter);
  const threads = session.context.threads;
  if (false) {
    // @ts-expect-error Numeric-only cursors lose messages sharing a timeline millisecond.
    await threads.readMessages('thread', { before: 20, limit: 1 });
    // @ts-expect-error Thread activity cursors must carry the composite position.
    await threads.list({ before: 20 });
  }
  await threads.list({ limit: 50, before: { lastActiveAt: 30, id: 'thread-30' } });
  await threads.list({ threadIds: ['thread-a', 'thread-b'] });
  await threads.readMessages('thread', { before: { timestamp: 20, id: 'message-20' }, limit: 500 });
  await threads.getCats('thread');
  assert.equal((await threads.update('thread', { preferredCats: [] })).deepLinkUrl,
    'https://owner.example/thread/projected', 'the wrapper preserves Host navigation without reconstructing it');
  assert.deepEqual(seen, [['list', { limit: 50, before: { lastActiveAt: 30, id: 'thread-30' } }],
    ['list', { threadIds: ['thread-a', 'thread-b'] }], ['readMessages', 'thread', { before: { timestamp: 20, id: 'message-20' }, limit: 500 }],
    ['getCats', 'thread'], ['update', 'thread', { preferredCats: [] }]]);
  await session.revoke();
  for (const invoke of [() => threads.list(), () => threads.readMessages('thread', { limit: 1 }),
    () => threads.getCats('thread'), () => threads.update('thread', { preferredCats: [] })]) {
    await assert.rejects(invoke(), FeatureContextRevokedError);
  }
  assert.equal(seen.length, 5);
});

function manifest() {
  return {
    pluginId: 'dev.clowder.fixture',
    version: '0.1.0',
    contractVersion: '0.1.0-beta.13',
    name: 'Fixture',
    contributions: [{ type: 'identity', id: 'cat', displayName: 'Fixture cat' }],
    features: [
      {
        id: 'feature-1',
        name: 'Feature one',
        resources: [],
        contributions: [{ type: 'identity', id: 'cat' }],

      },
    ],
    runtime: { transport: 'stdio', entrypoint: 'dist/entrypoint.js' },
  };
}

class RecordingAdapter implements FeatureHostAdapter {
  async getMessage(_id: string) { return null; }
  readonly calls: Array<{ operation: string; binding: FeatureBinding; value?: unknown }> = [];
  failNextDispose = false;
  #revision = 0;

  async readConfig(binding: FeatureBinding, key: string): Promise<unknown> {
    this.calls.push({ operation: 'config.get', binding, value: key });
    return key === 'mode' ? 'safe' : undefined;
  }

  async readSecret(binding: FeatureBinding, key: string): Promise<string> {
    this.calls.push({ operation: 'secrets.get', binding, value: key });
    return `secret:${key}`;
  }

  async readState(binding: FeatureBinding, key: string): Promise<unknown> {
    this.calls.push({ operation: 'storage.get', binding, value: key });
    return undefined;
  }

  async writeState(binding: FeatureBinding, key: string, value: unknown): Promise<void> {
    this.calls.push({ operation: 'storage.set', binding, value: { key, value } });
  }

  readonly storage: FeatureHostAdapter['storage'] = {
    get: async (key) => {
      await this.readState(BINDING, key);
      return undefined;
    },
    list: async () => ({}),
    set: async (key, value) => {
      await this.writeState(BINDING, key, value);
      return { revision: 1 };
    },
    compareAndSet: async (key, expectedRevision, value) => {
      this.calls.push({ operation: 'state.compareAndSet', binding: BINDING, value: { key, expectedRevision, value } });
      return { applied: true, revision: 1 };
    },
    delete: async (key, expectedRevision) => {
      this.calls.push({ operation: 'state.delete', binding: BINDING, value: { key, expectedRevision } });
      return { deleted: true, revision: 1 };
    },
  };

  readonly tasks = {
    get: async () => null,
    list: async () => [],
    create: async () => { throw new Error('not implemented by fixture'); },
    update: async () => null,
    bindDataController: async () => { throw new Error('not implemented by fixture'); },
    revokeDataController: async () => { throw new Error('not implemented by fixture'); },
  } satisfies FeatureHostAdapter['tasks'];

  readonly threads = {
    get: async () => null,
    list: async () => [],
    readMessages: async () => [],
    getCats: async () => ({ participants: [], routableNow: [], routableNotJoined: [], notRoutable: [] }),
    create: async () => { throw new Error('not implemented by fixture'); },
    update: async () => { throw new Error('not implemented by fixture'); },
  addParticipants: async () => { throw new Error('unused fixture addParticipants'); },
} satisfies FeatureHostAdapter['threads'];

  async sendMessage(
    binding: FeatureBinding,
    threadId: string,
    input: Parameters<FeatureHostAdapter['sendMessage']>[2],
  ): Promise<Awaited<ReturnType<FeatureHostAdapter['sendMessage']>>> {
    this.calls.push({ operation: 'messaging.send', binding, value: { threadId, ...input } });
    return {
      messageId: 'message-1',
      threadId: 'thread-1',
    };
  }

  async subscribeMessage(
    binding: FeatureBinding,
    input: Parameters<FeatureHostAdapter['subscribeMessage']>[1],
  ): Promise<void> {
    this.calls.push({ operation: 'messaging.subscribe', binding, value: input });
  }

  async unsubscribeMessage(
    binding: FeatureBinding,
    input: Parameters<FeatureHostAdapter['unsubscribeMessage']>[1],
  ): Promise<void> {
    this.calls.push({ operation: 'messaging.unsubscribe', binding, value: input });
  }

  readonly streams: FeatureHostAdapter['streams'] = {read: async function*() {}};

  log(
    binding: FeatureBinding,
    level: Parameters<FeatureHostAdapter['log']>[1],
    message: string,
    fields?: Readonly<Record<string, unknown>>,
  ): void {
    this.calls.push({ operation: `log.${level}`, binding, value: { message, fields } });
  }
}

type PausedHostOperation = 'config.get' | 'secrets.get' | 'storage.get' | 'storage.set';

class PausingHostOperationAdapter extends RecordingAdapter {
  readonly operationStarted: Promise<void>;
  readonly #operation: PausedHostOperation;
  readonly #releaseOperation: Promise<void>;
  #markOperationStarted!: () => void;
  #finishOperation!: () => void;

  constructor(operation: PausedHostOperation) {
    super();
    this.#operation = operation;
    this.operationStarted = new Promise((resolve) => {
      this.#markOperationStarted = resolve;
    });
    this.#releaseOperation = new Promise((resolve) => {
      this.#finishOperation = resolve;
    });
  }

  releaseOperation(): void {
    this.#finishOperation();
  }

  async #pause(operation: PausedHostOperation): Promise<void> {
    if (operation !== this.#operation) return;
    this.#markOperationStarted();
    await this.#releaseOperation;
  }

  override async readConfig(binding: FeatureBinding, key: string): Promise<unknown> {
    await this.#pause('config.get');
    return super.readConfig(binding, key);
  }

  override async readSecret(binding: FeatureBinding, key: string): Promise<string> {
    await this.#pause('secrets.get');
    return super.readSecret(binding, key);
  }

  override async readState(binding: FeatureBinding, key: string): Promise<unknown> {
    await this.#pause('storage.get');
    return super.readState(binding, key);
  }

  override async writeState(binding: FeatureBinding, key: string, value: unknown): Promise<void> {
    await this.#pause('storage.set');
    return super.writeState(binding, key, value);
  }
}

test('definePlugin validates the manifest and rejects undeclared activators', () => {
  const source = manifest();
  const defined = definePlugin({
    manifest: source,
    activate: {
      'feature-1': async (context) => {
        await context.config.get('mode');
      },
    },
  });
  assert.equal(defined.manifest.pluginId, 'dev.clowder.fixture');
  source.name = 'mutated after validation';
  assert.equal(defined.manifest.name, 'Fixture');
  assert.equal(Object.isFrozen(defined.manifest.features[0]), true);

  assert.throws(
    () => definePlugin({ manifest: manifest(), activate: { missing: async () => undefined } }),
    /activator.*missing.*not declared/i,
  );
});

test('module entrypoint accepts the Host-validated manifest without embedding a second copy', () => {
  const module = definePluginModule((candidate) => definePlugin({ manifest: candidate }));
  const candidate = manifest();
  candidate.runtime = { transport: 'builtin', entrypoint: 'dist/plugin.js' };
  const defined = requirePluginModuleEntrypoint(module).create(candidate);
  assert.equal(typeof defined.start, 'function');
});

test('module entrypoint guard rejects absent or ambiguous default exports', () => {
  assert.throws(() => requirePluginModuleEntrypoint(undefined), /default export.*PluginModuleEntrypoint/u);
  assert.throws(() => requirePluginModuleEntrypoint({ create: 'not-callable' }), /default export/u);
});

test('native MCP invokes exported handlers without a manifest method list and revokes them on disposal', async () => {
  const candidate = manifest();
  candidate.contributions.push({ type: 'mcp', id: 'native', runtime: { transport: 'stdio', entrypoint: 'native.js' } } as never);
  candidate.features[0]!.contributions.push({ type: 'mcp', id: 'native' } as never);
  const { context } = createFeatureContextSession(BINDING, new RecordingAdapter());
  const defined = definePlugin({ manifest: candidate, activate: { 'feature-1': () => ({
    actions: { 'native.run': async input => input }, dispose: () => undefined,
  }) } });
  const active = await activateDefinedFeature(defined, 'feature-1', context);
  assert.equal(await active.actions['native.run']!('native input'), 'native input');
  await active.dispose();
  await assert.rejects(async () => active.actions['native.run']!('late input'), FeatureContextRevokedError);
});

test('feature activation closes declared method handlers and owns idempotent disposal', async () => {
  const candidate = manifest();
  candidate.contributions.push({
    type: 'message-subscription',
    id: 'fixture-connector',
    binding: 'fixture-binding',
    action: { method: 'fixture.outbound' },
  } as never);
  candidate.features[0]!.contributions.push({ type: 'message-subscription', id: 'fixture-connector' } as never);
  let disposeCalls = 0;
  const defined = definePlugin({
    manifest: candidate,
    activate: {
      'feature-1': () => ({
        actions: { 'fixture.outbound': async (input) => ({ input }) },
        dispose: () => { disposeCalls += 1; },
      }),
    },
  });
  const adapter = new RecordingAdapter();
  const { context } = createFeatureContextSession(BINDING, adapter);
  const active = await activateDefinedFeature(defined, 'feature-1', context);

  assert.deepEqual(await active.actions['fixture.outbound']?.('hello'), { input: 'hello' });
  await active.dispose();
  await active.dispose();
  assert.equal(disposeCalls, 1);
});

test('feature activation rolls back missing routed package handlers', async (t) => {
  const candidate = manifest();
  candidate.contributions.push({
    type: 'message-subscription', id: 'fixture-connector', binding: 'fixture-binding',
    action: { method: 'fixture.outbound' },
  } as never);
  candidate.features[0]!.contributions.push({ type: 'message-subscription', id: 'fixture-connector' } as never);
  const cases: ReadonlyArray<readonly [
    string,
    Readonly<Record<string, (input: unknown) => unknown>>,
    RegExp,
  ]> = [
    ['missing', {}, /fixture\.outbound.*no handler/i],
  ];
  for (const [name, actions, pattern] of cases) {
    await t.test(name, async () => {
      let disposeCalls = 0;
      const defined = definePlugin({
        manifest: candidate,
        activate: {
          'feature-1': () => ({ actions, dispose: () => { disposeCalls += 1; } }),
        },
      });
      const { context } = createFeatureContextSession(BINDING, new RecordingAdapter());
      await assert.rejects(activateDefinedFeature(defined, 'feature-1', context), pattern);
      assert.equal(disposeCalls, 1);
    });
  }
});

test('messaging send ingress and logs retain Host-issued feature authority', async () => {
  const adapter = new RecordingAdapter();
  const session = createFeatureContextSession(BINDING, adapter);
  const draft = {
    idempotencyKey: 'provider-message-1',
    payload: {
      provenance: {
        origin: {
          kind: 'external',
          connectorId: 'fixture-connector',
          sourceAddress: {
            connectorId: 'fixture-connector',
            chatId: 'provider-chat-1',
            messageId: 'provider-message-1',
          },
        },
        epistemicStatus: 'observation',
      },
      elements: [{ elementId: 'text-1', kind: 'text', payload: { text: 'hello' } }],
    },
  } as const;
  await session.context.messaging.send('thread-1', draft);
  session.context.log('info', 'provider connected', { connectorId: 'fixture-connector' });

  assert.deepEqual(adapter.calls.slice(-2), [
    {
      operation: 'messaging.send',
      binding: BINDING,
      value: { threadId: 'thread-1', ...draft },
    },
    {
      operation: 'log.info',
      binding: BINDING,
      value: { message: 'provider connected', fields: { connectorId: 'fixture-connector' } },
    },
  ]);

  await session.revoke();
  await assert.rejects(
    session.context.messaging.send('thread-1', {
      ...draft,
      idempotencyKey: 'provider-message-2',
    }),
    FeatureContextRevokedError,
  );
  assert.throws(() => session.context.log('warn','late'), FeatureContextRevokedError);
});

test('Host operation results never cross a revoked context boundary', async (t) => {
  const cases: readonly {
    readonly operation: PausedHostOperation;
    readonly invoke: (context: FeatureContext) => Promise<unknown>;
  }[] = [
    { operation: 'config.get', invoke: (context) => context.config.get('mode') },
    { operation: 'secrets.get', invoke: (context) => context.secrets.get('apiKey') },
    { operation: 'storage.get', invoke: (context) => context.storage.get('cursor') },
    { operation: 'storage.set', invoke: (context) => context.storage.set('cursor', { value: 1 }) },
  ];

  for (const scenario of cases) {
    await t.test(scenario.operation, async () => {
      const adapter = new PausingHostOperationAdapter(scenario.operation);
      const session = createFeatureContextSession(BINDING, adapter);
      const operation = scenario.invoke(session.context);
      await adapter.operationStarted;
      await session.revoke();
      const rejection = assert.rejects(operation, FeatureContextRevokedError);
      adapter.releaseOperation();
      await rejection;
    });
  }
});

test('wait patch delegates the full neutral snapshot and rejects a late result after revocation', async () => {
  const adapter = new RecordingAdapter();
  let release!: () => void;
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const input = { expectedGeneration: 1, generation: 2, active: { expiresAt: 1234 },
    outcome: { outcomeId: 'outcome-1', generation: 1, ownerFence: { kind: 'containing_task' as const, generation: 1 },
      reason: 'matched' as const, delivery: 'pending' as const } };
  Object.assign(adapter.tasks, { update: async (id: string, value: unknown) => {
    assert.equal(id, 'task-1'); assert.deepEqual(value, {wait:input}); began();
    await new Promise<void>(resolve => { release = resolve; }); return null;
  } });
  const session = createFeatureContextSession(BINDING, adapter);
  const pending = session.context.tasks.update('task-1', { wait: input });
  await started; await session.revoke();
  const rejected = assert.rejects(pending, FeatureContextRevokedError);
  release(); await rejected;
  await assert.rejects(session.context.tasks.update('task-1', { wait: input }), FeatureContextRevokedError);
});

test('Task public surface forwards ordinary data and explicit data-controller mutations intact', async () => {
  const adapter = new RecordingAdapter();
  const calls: unknown[] = [];
  const controllerReceipt=`task-data-controller:${'a'.repeat(64)}`;
  const revocationReceipt=`task-data-controller:${'b'.repeat(64)}`;
  const controlledTask={id:'task',kind:'work' as const,userId:'owner',threadId:'thread',subjectKey:'work:one',
    title:'Work',ownerCatId:'cat',status:'todo' as const,why:'Work',createdBy:'owner',createdAt:1,updatedAt:2,
    entrustedWork:{revision:2,artifactRefs:[],closure:{state:'open'},admission:{sourceRefs:['message:first'],
      authorityRef:'message:admission'},dataController:{bindingRevision:1,state:'active' as const,currentForCaller:true,
        binding:{userId:'owner',catId:'cat',threadId:'thread',subjectKey:'work:one',firstSourceRef:'message:first',
          admissionAuthorityRef:'message:admission',pluginId:'official.collective-connector',pluginInstanceId:'instance-1',
          moduleRef:'plugin:official.collective-connector',lifecycleRevision:1,
          ownerOperationReceiptRef:controllerReceipt}}}};
  Object.assign(adapter.tasks, {
    get: async (selector: unknown) => {calls.push(['get',selector]);return null;},
    list: async (filter: unknown) => {calls.push(['list',filter]);return [];},
    create: async (input: unknown, options: unknown) => {calls.push(['create',input,options]);return {id:'task'};},
    update: async (id: string, patch: unknown, conditions: unknown) => {calls.push(['update',id,patch,conditions]);return null;},
    bindDataController: async (input: unknown) => {calls.push(['bindDataController',input]);return {
      disposition:'bound',receiptRef:controllerReceipt,bindingRevision:1,task:controlledTask};},
    revokeDataController: async (input: unknown) => {calls.push(['revokeDataController',input]);return {
      disposition:'revoked',receiptRef:revocationReceipt,bindingRevision:2,task:{...controlledTask,entrustedWork:{
        ...controlledTask.entrustedWork,revision:3,dataController:{...controlledTask.entrustedWork.dataController,
          bindingRevision:2,state:'revoked',currentForCaller:false,revocationReceiptRef:revocationReceipt}}}};},
  });
  const session = createFeatureContextSession(BINDING, adapter);
  assert.deepEqual(Object.keys(session.context.tasks).sort(),
    ['bindDataController','create','get','list','revokeDataController','update']);
  await session.context.tasks.get({subjectKey:'work:one'});
  await session.context.tasks.list({threadId:'thread',kind:'work'});
  const input={threadId:'thread',title:'Work',subjectKey:'work:one'};
  await session.context.tasks.create(input,{onConflict:'update'});
  const wait={expectedGeneration:null,generation:1,active:null};
  await session.context.tasks.update('task',{wait},{expectedThreadId:'thread'});
  const bindInput = {taskId:'task',expectedTaskRevision:4,operationId:'owner-operation:bind',expected:{
    ownerCatId:'cat',threadId:'thread',subjectKey:'work:one',firstSourceRef:'message:first',
    admissionAuthorityRef:'message:admission'}};
  await session.context.tasks.bindDataController(bindInput);
  const revokeInput = {taskId:'task',expectedTaskRevision:5,expectedBindingRevision:1,
    expectedControllerReceiptRef:`task-data-controller:${'a'.repeat(64)}`,operationId:'owner-operation:revoke'};
  await session.context.tasks.revokeDataController(revokeInput);
  assert.deepEqual(calls,[['get',{subjectKey:'work:one'}],['list',{threadId:'thread',kind:'work'}],
    ['create',input,{onConflict:'update'}],['update','task',{wait},{expectedThreadId:'thread'}],
    ['bindDataController',bindInput],['revokeDataController',revokeInput]]);
  await assert.rejects(session.context.tasks.update('task', {wait,title:'mixed'} as unknown as import('./module-host.js').PluginTaskUpdateInput), /wait.*mix/i);
  assert.equal(calls.length,6,'mixed wait patch cannot enter a Host write');
  await session.revoke();
  await assert.rejects(session.context.tasks.list({}),FeatureContextRevokedError);
});

test('Task data-controller mutations fail closed when an older Host lacks the typed ports', async () => {
  const adapter = new RecordingAdapter();
  const legacyTasks = {
    get: adapter.tasks.get,
    list: adapter.tasks.list,
    create: adapter.tasks.create,
    update: adapter.tasks.update,
  };
  const session = createFeatureContextSession(BINDING, {
    ...adapter,
    tasks: legacyTasks,
  } as unknown as FeatureHostAdapter);
  await assert.rejects(
    session.context.tasks.bindDataController({taskId:'task',expectedTaskRevision:4,
      operationId:'owner-operation:bind',expected:{ownerCatId:'cat',threadId:'thread',subjectKey:'work:one',
        firstSourceRef:'message:first',admissionAuthorityRef:'message:admission'}}),
    /binding is unavailable/,
  );
  await assert.rejects(
    session.context.tasks.revokeDataController({taskId:'task',expectedTaskRevision:5,expectedBindingRevision:1,
      expectedControllerReceiptRef:`task-data-controller:${'a'.repeat(64)}`,operationId:'owner-operation:revoke'}),
    /revocation is unavailable/,
  );
});
