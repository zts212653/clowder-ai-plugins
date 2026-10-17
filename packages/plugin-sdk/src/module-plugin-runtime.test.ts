import assert from 'node:assert/strict';
import test from 'node:test';

import {
  definePlugin,
  FeatureContextRevokedError,
  FeaturePermissionError,
  type FeatureContext,
} from './feature-context.js';
import { definePluginModule } from './module-plugin.js';
import type { PluginActionContext } from './module-action-client.js';
import type { ModulePluginHostShape } from './module-host.js';
import { operationRowAction, rowsResult } from './operation-results.js';

async function ownerThreadFixture(port: unknown, capabilities = ['thread.listMetadata', 'thread.write']) {
  let context!: FeatureContext;
  const candidate = manifest();
  candidate.features[0]!.capabilities = capabilities as never;
  const entrypoint = definePluginModule(input => definePlugin({ manifest: input, activate: {
    'feature-1': value => {
      context = value;
      return { actions: { 'fixture.outbound': () => undefined, 'fixture.echo': () => undefined } };
    },
  } }));
  const runtimeHost = { ...host([]), ...(port === undefined ? {} : { ownerThreads: port }) } as ModulePluginHostShape;
  const activation = await entrypoint.create(candidate).start(runtimeHost);
  return { context, activation };
}

function ownerThreadPort() {
  const calls: unknown[] = [];
  const projection = { id: 'owner-thread', createdBy: 'local-owner', participants: ['cat-1'] };
  const port = {
    async get(id: string) { calls.push(['get', id]); return id === 'missing' ? null : projection; },
    async create(input: unknown) { calls.push(['create', input]); return projection; },
    async addParticipants(input: unknown) { calls.push(['addParticipants', input]); return projection; },
  };
  return { port, calls, projection };
}

test('module ownerThreads carries all three exact methods and immutable owner projections', async () => {
  const { port, calls, projection } = ownerThreadPort();
  const { context, activation } = await ownerThreadFixture(port);
  assert.ok(context.ownerThreads, 'the exact Host owner thread port must reach FeatureContext');
  assert.equal(await context.ownerThreads.get('missing'), null);
  const result = await context.ownerThreads.get('owner-thread');
  assert.deepEqual(result, projection);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result!.participants));
  projection.participants.push('late-mutation');
  assert.deepEqual(result!.participants, ['cat-1']);
  await context.ownerThreads.create({ title: 'Owner thread' });
  await context.ownerThreads.addParticipants({ threadId: 'owner-thread', catIds: [] });
  assert.deepEqual(calls, [['get', 'missing'], ['get', 'owner-thread'], ['create', { title: 'Owner thread' }],
    ['addParticipants', { threadId: 'owner-thread', catIds: [] }]]);
  await activation.stop();
});

test('ownerThreads remains absent on older carriers instead of using accessible threads', async () => {
  const { context, activation } = await ownerThreadFixture(undefined);
  assert.equal(context.ownerThreads, undefined);
  await activation.stop();
});

test('ownerThreads checks read and write grants before calling the Host', async () => {
  const { port, calls } = ownerThreadPort();
  const { context, activation } = await ownerThreadFixture(port, []);
  assert.ok(context.ownerThreads);
  await assert.rejects(() => context.ownerThreads!.get('owner-thread'), /thread.listMetadata/);
  await assert.rejects(() => context.ownerThreads!.create({ title: 'Owner thread' }), /thread.write/);
  await assert.rejects(() => context.ownerThreads!.addParticipants({ threadId: 'owner-thread', catIds: [] }), /thread.write/);
  assert.deepEqual(calls, []);
  await activation.stop();
});

test('ownerThreads refuses use after stop and a late response after revocation', async () => {
  const { port, calls, projection } = ownerThreadPort();
  let finish!: (value: typeof projection) => void;
  port.get = async id => { calls.push(['get', id]); return new Promise<typeof projection>(resolve => { finish = resolve; }); };
  const { context, activation } = await ownerThreadFixture(port);
  assert.ok(context.ownerThreads);
  const pending = context.ownerThreads.get('owner-thread');
  await activation.stop();
  finish(projection);
  await assert.rejects(pending, FeatureContextRevokedError);
  await assert.rejects(() => context.ownerThreads!.create({ title: 'Owner thread' }), FeatureContextRevokedError);
  assert.deepEqual(calls, [['get', 'owner-thread']]);
});

test('ownerThreads preserves Host owner rejection and never retries an ambiguous create', async () => {
  const { port, calls } = ownerThreadPort();
  const refusal = new Error('A current authenticated owner request is required for owner threads');
  port.create = async input => { calls.push(['create', input]); throw refusal; };
  const { context, activation } = await ownerThreadFixture(port);
  assert.ok(context.ownerThreads);
  await assert.rejects(() => context.ownerThreads!.create({ title: 'Owner thread' }), error => error === refusal);
  assert.deepEqual(calls, [['create', { title: 'Owner thread' }]]);
  await activation.stop();
});

test('ownerThreads rejects a partial carrier and an invalid owner projection', async () => {
  await assert.rejects(ownerThreadFixture({ get: async () => null }), /owner thread port/);
  const { port, projection } = ownerThreadPort();
  port.get = async () => ({ ...projection, secret: 'must-not-be-projected' });
  const { context, activation } = await ownerThreadFixture(port);
  assert.ok(context.ownerThreads);
  await assert.rejects(() => context.ownerThreads!.get('owner-thread'), /PluginOwnerThread/);
  await activation.stop();
});

async function participantRosterFixture(port: unknown) {
  let context!: FeatureContext;
  const entrypoint = definePluginModule(input => definePlugin({ manifest: input, activate: {
    'feature-1': value => { context = value; return { actions: { 'fixture.outbound': () => undefined, 'fixture.echo': () => undefined } }; },
  } }));
  const runtimeHost = { ...host([]), ...(port === undefined ? {} : { participantRoster: port }) } as ModulePluginHostShape;
  const activation = await entrypoint.create(manifest()).start(runtimeHost);
  return { context, activation };
}

test('participantRoster transports the declared contribution only and freezes honest public rows', async () => {
  const calls: unknown[] = [];
  const row = { catId: 'cat', displayName: 'Cat', defaultModel: 'model', nickname: 'Kit', supported: false };
  const { context, activation } = await participantRosterFixture({ async listForNativeContribution(input: unknown) { calls.push(input); return [row]; } });
  assert.ok(context.participantRoster);
  const rows = await context.participantRoster.listForNativeContribution({ contributionId: 'native' });
  assert.deepEqual(calls, [{ contributionId: 'native' }]);
  assert.deepEqual(rows, [row]); assert.equal(rows[0]!.supported, false);
  assert.ok(Object.isFrozen(rows)); assert.ok(Object.isFrozen(rows[0]));
  row.displayName = 'Changed'; assert.equal(rows[0]!.displayName, 'Cat');
  await activation.stop();
});

test('participantRoster stays absent on older carriers and rejects partial supplied carriers', async () => {
  const { context, activation } = await participantRosterFixture(undefined);
  assert.equal(context.participantRoster, undefined); await activation.stop();
  await assert.rejects(participantRosterFixture({}), /participant roster port/);
});

test('participantRoster rejects forged authority and UTF16 or trim-invalid contribution IDs before Host calls', async () => {
  let calls = 0;
  const { context, activation } = await participantRosterFixture({ async listForNativeContribution() { calls++; return []; } });
  assert.ok(context.participantRoster);
  for (const input of [{ contributionId: '' }, { contributionId: 'native\n' }, { contributionId: '😀'.repeat(129) },
    { contributionId: 'native', instanceId: 'forged' }, { contributionId: 'native', methods: ['fake'] }]) {
    await assert.rejects(() => context.participantRoster!.listForNativeContribution(input), TypeError);
  }
  assert.equal(calls, 0); await activation.stop();
});

test('participantRoster preserves Host refusal without retry or available/catalog fallback', async () => {
  const refusal = new Error('DELIVERY_REJECTED'); let calls = 0;
  const { context, activation } = await participantRosterFixture({ async listForNativeContribution() { calls++; throw refusal; } });
  assert.ok(context.participantRoster);
  await assert.rejects(() => context.participantRoster!.listForNativeContribution({ contributionId: 'native' }), error => error === refusal);
  assert.equal(calls, 1); await activation.stop();
});

test('participantRoster rejects late results and use after stop', async () => {
  let finish!: (rows: never[]) => void; let calls = 0;
  const { context, activation } = await participantRosterFixture({ async listForNativeContribution() { calls++; return new Promise<never[]>(resolve => { finish = resolve; }); } });
  assert.ok(context.participantRoster);
  const pending = context.participantRoster.listForNativeContribution({ contributionId: 'native' });
  await activation.stop(); finish([]);
  await assert.rejects(pending, FeatureContextRevokedError);
  await assert.rejects(() => context.participantRoster!.listForNativeContribution({ contributionId: 'native' }), FeatureContextRevokedError);
  assert.equal(calls, 1);
});

test('participantRoster rejects private/available/eligible fields and nonportable avatars in Host projections', async () => {
  const row = { catId: 'cat', displayName: 'Cat', defaultModel: 'model', supported: false };
  let result: unknown = [];
  const { context, activation } = await participantRosterFixture({ async listForNativeContribution() { return result; } });
  assert.ok(context.participantRoster);
  for (const invalid of [{ ...row, eligible: true }, { ...row, available: true }, { ...row, account: 'private' },
    { ...row, avatar: '/Users/private/avatar.webp' }, { ...row, supported: 'true' }, { catId: 'cat' }]) {
    result = [invalid];
    await assert.rejects(() => context.participantRoster!.listForNativeContribution({ contributionId: 'native' }), /PluginParticipant/);
  }
  await activation.stop();
});

function manifest() {
  return {
    pluginId: 'dev.clowder.module-fixture',
    version: '0.1.0',
    contractVersion: '0.1.0-beta.18',
    name: 'Module fixture',
    contributions: [
      { type: 'identity', id: 'cat', displayName: 'Fixture cat' },
      {
        type: 'message-subscription',
        id: 'outbound',
        binding: 'fixture',
        action: { method: 'fixture.outbound' },
        presentation: 'v1',
      },
      {
        type: 'tool',
        id: 'echo',
        name: 'echo',
        inputSchema: { type: 'object' },
        action: { method: 'fixture.echo' },
      },
    ],
    features: [
      {
        id: 'feature-1',
        name: 'Feature one',
        resources: [],
        contributions: [
          { type: 'identity', id: 'cat' },
          { type: 'message-subscription', id: 'outbound' },
          { type: 'tool', id: 'echo' },
        ],
        capabilities: [
          'messaging.send',
          'message.event.subscribe',
          'thread.write',
          'plugin.state.get',
          'plugin.state.set',
          'task.read',
          'task.write',
        ],
      },
    ],
    runtime: { transport: 'builtin', entrypoint: 'dist/plugin-entrypoint.js' },
  };
}

function host(
  calls: Array<{ operation: string; value?: unknown }>,
  sendError?: Error,
  dataDirectory?: string,
) {
  const task = {
    id: 'task-1', kind: 'work', threadId: 'thread-1', subjectKey: 'fixture:1', title: 'Fixture task',
    ownerCatId: null, status: 'todo', why: '', createdBy: 'system', createdAt: 1, updatedAt: 1, userId: null,
  } as const;
  return {
    pluginInstanceId: 'installed-module-fixture',
    config: { get: async (key: string) => key === 'mode' ? 'safe' : undefined },
    secrets: { get: async (key: string) => key === 'token' ? 'secret' : undefined },
    storage: {
      get: async (key: string) => ({ revision: 1, value: key }),
      list: async () => ({}),
      set: async (key: string, value: unknown) => ({ revision: (calls.push({ operation: 'storage.set', value: { key, value } }), 2) }),
      compareAndSet: async (key: string, expectedRevision: number | null, value: unknown) => {
        calls.push({ operation: 'storage.compareAndSet', value: { key, expectedRevision, value } });
        return { applied: true, revision: 3 };
      },
      delete: async (key: string, expectedRevision?: number) => ({ deleted: true, revision: (calls.push({ operation: 'storage.delete', value: { key, expectedRevision } }), 4) }),
    },
    tasks: {
      get: async () => task,
      listByThread: async () => [task],
      listByKind: async () => [task],
      getBySubject: async () => task,
      create: async () => task,
      upsertBySubject: async (input: unknown) => (calls.push({ operation: 'tasks.upsertBySubject', value: input }), task),
      update: async () => task,
      updateIfThreadId: async () => task,
      setWait: async () => task,
    },
    threads: {
      get: async () => null,
      list: async () => [],
      readMessages: async () => [],
      getCats: async () => ({ participants: [], routableNow: [], routableNotJoined: [], notRoutable: [] }),
      create: async () => ({ id: 'thread-1', deepLinkUrl: 'https://owner.example/thread/thread-1', title: 'Fixture', createdAt: 1, lastActiveAt: 1, preferredCats: [], featureRefs: [] }),
      update: async () => ({ id: 'thread-1', deepLinkUrl: 'https://owner.example/thread/thread-1', title: 'Fixture', createdAt: 1, lastActiveAt: 1, preferredCats: [], featureRefs: [] }),
      findByKey: async () => null,
      ensureByKey: async (key: string, input: unknown) => {
        calls.push({ operation: 'threads.ensureByKey', value: { key, input } });
        return { id: 'thread-1', deepLinkUrl: 'https://owner.example/thread/thread-1', title: 'Fixture', createdAt: 1, lastActiveAt: 1, preferredCats: [], featureRefs: [] };
      },
      bind: async () => ({ key: 'fixture', threadId: 'thread-1', createdAt: 1 }),
      unbind: async () => true,
      listBindings: async () => [],
      ensureSystemThread: async () => ({ id: 'system-thread', deepLinkUrl: 'https://owner.example/thread/system-thread', title: 'System', createdAt: 1, lastActiveAt: 1, preferredCats: [], featureRefs: [] }),
    },
    messaging: {
      send: async (input: unknown) => {
        calls.push({ operation: 'messaging.send', value: input });
        if (sendError) throw sendError;
        return { messageId: 'message-1', threadId: 'thread-1' };
      },
      subscribe: async (input: unknown) => { calls.push({ operation: 'messaging.subscribe', value: input }); },
      unsubscribe: async (input: unknown) => { calls.push({ operation: 'messaging.unsubscribe', value: input }); },
    },
    media: {
      read: async (input: { readonly offset: number }) => ({
        offset: input.offset,
        dataBase64: '',
        done: true,
      }),
    },
    ...(dataDirectory === undefined ? {} : { dataDirectory }),
    log: (level: string, message: string, fields?: Readonly<Record<string, unknown>>) => {
      calls.push({ operation: 'log', value: { level, message, fields } });
    },
  };
}

test('module activation exposes the actual installed instance, independently of manifest identity', async () => {
  let instance: unknown;
  const entrypoint = definePluginModule(input => definePlugin({manifest: input, activate: {
    'feature-1': context => {
      instance = (context as FeatureContext & {pluginInstanceId?: string}).pluginInstanceId;
      return {actions: {'fixture.outbound': () => undefined, 'fixture.echo': () => undefined}};
    },
  }}));
  const runtime = await entrypoint.create(manifest()).start(host([]));
  assert.equal(instance, 'installed-module-fixture');
  assert.notEqual(instance, manifest().pluginId);
  await runtime.stop();
});

test('module carrier exposes the Host dataDirectory only to a feature granted data.directory', async () => {
  const calls: Array<{ operation: string; value?: unknown }> = [];
  const candidate = manifest();
  candidate.runtime = {
    ...candidate.runtime,
    dataDirectory: 'module-fixture',
  } as never;
  candidate.features[0]!.capabilities.push('data.directory' as never);
  candidate.features.push({
    id: 'feature-without-data',
    name: 'Feature without data',
    resources: [],
    contributions: [],
    capabilities: [],
  } as never);

  const observed: string[] = [];
  const entrypoint = definePluginModule((input) => definePlugin({
    manifest: input,
    activate: {
      'feature-1': (context) => {
        observed.push(context.dataDirectory);
        return {
          actions: {
            'fixture.outbound': () => undefined,
            'fixture.echo': () => undefined,
          },
        };
      },
      'feature-without-data': (context) => {
        assert.throws(
          () => context.dataDirectory,
          (error: unknown) =>
            error instanceof FeaturePermissionError && error.code === 'PERMISSION',
        );
        return { actions: {} };
      },
    },
  }));
  const runtimeHost: ModulePluginHostShape = host(
    calls,
    undefined,
    '/tmp/clowder-module-fixture',
  );
  assert.equal(runtimeHost.dataDirectory, '/tmp/clowder-module-fixture');

  const activation = await entrypoint.create(candidate).start(runtimeHost);
  assert.deepEqual(observed, ['/tmp/clowder-module-fixture']);
  await activation.stop();
});

test('module carrier rejects dataDirectory access when the Host provides no path', async () => {
  const candidate = manifest();
  candidate.runtime = {
    ...candidate.runtime,
    dataDirectory: 'module-fixture',
  } as never;
  candidate.features[0]!.capabilities.push('data.directory' as never);
  const entrypoint = definePluginModule((input) => definePlugin({
    manifest: input,
    activate: {
      'feature-1': (context) => {
        void context.dataDirectory;
        return {
          actions: {
            'fixture.outbound': () => undefined,
            'fixture.echo': () => undefined,
          },
        };
      },
    },
  }));

  await assert.rejects(
    entrypoint.create(candidate).start(host([])),
    (error: unknown) => error instanceof FeaturePermissionError && error.code === 'PERMISSION',
  );
});

test('beta.24 rows, confirm, and cloud-conversation-host cross the real module carrier', async () => {
  const candidate = manifest() as ReturnType<typeof manifest> & { configuration: unknown[] };
  candidate.configuration = [{
    key: 'authorizations',
    label: 'Authorizations',
    kind: 'operation',
    required: false,
    actions: [
      { id: 'list', label: 'List', render: 'status', action: { method: 'fixture.rows.list' } },
      {
        id: 'revoke',
        label: 'Revoke',
        render: 'row',
        confirm: 'Revoke this authorization?',
        action: { method: 'fixture.rows.revoke' },
      },
    ],
  }];
  const cloudHost = {
    type: 'cloud-conversation-host' as const,
    id: 'fixture-cloud-host',
    provider: 'chatgpt' as const,
    appendMessage: { method: 'fixture.cloud.append' },
    assistantReturns: {
      list: { method: 'fixture.cloud.list' },
      ack: { method: 'fixture.cloud.ack' },
    },
  };
  candidate.contributions.push(cloudHost as never);
  candidate.features[0]!.contributions.push(
    { type: 'cloud-conversation-host', id: cloudHost.id } as never,
  );
  candidate.features[0]!.capabilities.push('cloud.conversation.host' as never);

  const entrypoint = definePluginModule((input) => definePlugin({
    manifest: input,
    activate: {
      'feature-1': async (context) => {
        await context.conversationHosts.register({
          id: cloudHost.id,
          provider: cloudHost.provider,
          appendMessage: cloudHost.appendMessage,
          assistantReturns: cloudHost.assistantReturns,
        });
        return {
          actions: {
            'fixture.outbound': () => undefined,
            'fixture.echo': () => undefined,
            'fixture.rows.list': () => rowsResult([{
              key: 'conversation-1',
              label: 'Conversation one',
              actions: [operationRowAction('revoke', { conversationId: 'conversation-1' })],
            }]),
            'fixture.rows.revoke': () => rowsResult([]),
            'fixture.cloud.append': () => ({ status: 'accepted' }),
            'fixture.cloud.list': () => ({ returns: [] }),
            'fixture.cloud.ack': () => ({ status: 'accepted' }),
          },
        };
      },
    },
  }));

  const activation = await entrypoint.create(candidate).start(host([]));
  assert.deepEqual(await activation.actions['fixture.rows.list']?.({}), {
    render: 'rows',
    data: {
      rows: [{
        key: 'conversation-1',
        label: 'Conversation one',
        actions: [{ action: 'revoke', input: { conversationId: 'conversation-1' } }],
      }],
    },
  });
  assert.equal(
    (candidate.configuration[0] as { actions: Array<{ confirm?: string }> }).actions[1]?.confirm,
    'Revoke this authorization?',
  );
  await activation.stop();
});

function moduleWithJourney(received: unknown[]) {
  return definePluginModule((candidate) => definePlugin({
    manifest: candidate,
    activate: {
      'feature-1': async (context: FeatureContext) => {
        assert.equal(await context.config.get('mode'), 'safe');
        assert.equal(await context.secrets.get('token'), 'secret');
        await context.identity.register({ id: 'cat', displayName: 'Fixture cat' });
        await context.messaging.subscribe('thread-1', { contributionId: 'outbound', includeOwnMessages: true });
        assert.deepEqual(await context.messaging.send('thread-1', {
          idempotencyKey: 'message-1',
          payload: {
            provenance: { epistemicStatus: 'observation' },
            elements: [{ elementId: 'text-1', kind: 'text', payload: { text: 'hello' } }],
          },
        }), { messageId: 'message-1', threadId: 'thread-1' });
        assert.deepEqual(await context.threads.ensureByKey('fixture', { title: 'Fixture' }), {
          id: 'thread-1', deepLinkUrl: 'https://owner.example/thread/thread-1', title: 'Fixture', createdAt: 1, lastActiveAt: 1, preferredCats: [], featureRefs: [],
        });
        assert.deepEqual(await context.storage.compareAndSet('cursor', null, { sequence: 1 }), {
          applied: true, revision: 3,
        });
        assert.equal(context.state, context.storage);
        assert.equal((await context.tasks.upsertBySubject({
          threadId: 'thread-1', title: 'Fixture task', subjectKey: 'fixture:1',
        })).id, 'task-1');
        context.log('info', 'fixture started', { featureId: context.featureId });
        return {
          actions: {
            'fixture.outbound': (input: unknown) => { received.push(input); },
            'fixture.echo': (input: unknown) => input,
          },
          dispose: () => undefined,
        };
      },
    },
  }));
}

test('module entrypoint mirrors the Host lifecycle and thin host surfaces', async () => {
  const calls: Array<{ operation: string; value?: unknown }> = [];
  const received: unknown[] = [];
  const entrypoint = moduleWithJourney(received);
  const activation = await entrypoint.create(manifest()).start(host(calls));

  assert.deepEqual(Object.keys(activation.actions).sort(), ['fixture.echo', 'fixture.outbound']);
  const delivery = {
    deliveryId: 'delivery-1', threadId: 'thread-1', envelope: { messageId: 'message-1' },
    presentation: { actor: { displayName: 'Fixture', emoji: '🐱' }, thread: { shortId: 'abc123' } },
  };
  await activation.actions['fixture.outbound']?.(delivery);
  assert.deepEqual(received, [delivery]);
  await assert.rejects(
    Promise.resolve().then(() => activation.actions['fixture.outbound']?.({
      deliveryId: 'delivery-2', threadId: 'thread-1', envelope: { messageId: 'message-2' },
    })),
    /delivery presentation is required/,
  );
  assert.deepEqual(calls.find((call) => call.operation === 'messaging.send')?.value, {
    threadId: 'thread-1',
    idempotencyKey: 'message-1',
    payload: {
      provenance: { epistemicStatus: 'observation' },
      elements: [{ elementId: 'text-1', kind: 'text', payload: { text: 'hello' } }],
    },
  });
  assert.equal('address' in (calls.find((call) => call.operation === 'messaging.send')?.value as object), false);
  assert.deepEqual(calls.find((call) => call.operation === 'messaging.subscribe')?.value, {
    threadId: 'thread-1', method: 'fixture.outbound', includeOwnMessages: true,
  });
  assert.equal(calls.some((call) => call.operation === 'threads.ensureByKey'), true);
  assert.equal(calls.some((call) => call.operation === 'storage.compareAndSet'), true);
  assert.equal(calls.some((call) => call.operation === 'tasks.upsertBySubject'), true);
  assert.deepEqual(calls.find((call) => call.operation === 'log')?.value, {
    level: 'info', message: 'fixture started', fields: { featureId: 'feature-1' },
  });
  await activation.stop();
  await activation.stop();
  assert.equal(calls.some((call) => call.operation === 'messaging.unsubscribe'), false);
});

test('a v2 message subscription registers and still requires delivery presentation', async () => {
  const calls: Array<{ operation: string; value?: unknown }> = [];
  const received: unknown[] = [];
  const v2Manifest = structuredClone(manifest());
  const subscription = v2Manifest.contributions.find(
    (contribution) => contribution.type === 'message-subscription',
  );
  assert.ok(subscription && 'presentation' in subscription);
  (subscription as { presentation: string }).presentation = 'v2';

  const entrypoint = moduleWithJourney(received);
  const activation = await entrypoint.create(v2Manifest).start(host(calls));
  assert.deepEqual(calls.find((call) => call.operation === 'messaging.subscribe')?.value, {
    threadId: 'thread-1', method: 'fixture.outbound', includeOwnMessages: true,
  });

  const delivery = {
    deliveryId: 'delivery-1', threadId: 'thread-1', envelope: { messageId: 'message-1' },
    presentation: { actor: { displayName: 'Fixture', emoji: '🐱' }, thread: { shortId: 'abc123' } },
  };
  await activation.actions['fixture.outbound']?.(delivery);
  assert.deepEqual(received, [delivery]);
  await assert.rejects(
    Promise.resolve().then(() => activation.actions['fixture.outbound']?.({
      deliveryId: 'delivery-2', threadId: 'thread-1', envelope: { messageId: 'message-2' },
    })),
    /delivery presentation is required/,
  );
  await activation.stop();
});

test('a fresh module start replays subscriptions without an SDK registration store', async () => {
  const calls: Array<{ operation: string; value?: unknown }> = [];
  const entrypoint = moduleWithJourney([]);
  const first = await entrypoint.create(manifest()).start(host(calls));
  await first.stop();
  const second = await entrypoint.create(manifest()).start(host(calls));
  await second.stop();
  assert.equal(calls.filter((call) => call.operation === 'messaging.subscribe').length, 2);
});

test('Host messaging errors and idempotency keys cross the SDK unchanged', async () => {
  const calls: Array<{ operation: string; value?: unknown }> = [];
  const retryable = Object.assign(new Error('retry'), { code: 'RETRYABLE_INFLIGHT' });
  const entrypoint = moduleWithJourney([]);
  await assert.rejects(entrypoint.create(manifest()).start(host(calls, retryable)), (error) => error === retryable);
  assert.equal((calls.find((call) => call.operation === 'messaging.send')?.value as { idempotencyKey: string }).idempotencyKey, 'message-1');
});

test('module entrypoint rejects a static-only manifest before start', () => {
  const staticManifest = {
    pluginId: 'dev.clowder.static-fixture',
    version: '0.1.0',
    contractVersion: '0.1.0-beta.18',
    name: 'Static fixture',
    contributions: [{ type: 'skill', id: 'docs', path: 'skills/docs' }],
    features: [{
      id: 'feature-1', name: 'Feature one', resources: [],
      contributions: [{ type: 'skill', id: 'docs' }], capabilities: [],
    }],
  };
  const entrypoint = definePluginModule((candidate) => definePlugin({ manifest: candidate }));
  assert.throws(() => entrypoint.create(staticManifest), /builtin runtime entrypoint/i);
});

test('in-process registrars validate declarations without registering or withdrawing Host resources', async () => {
  let declaredReceipt: unknown;
  const entrypoint = definePluginModule((candidate) => definePlugin({
    manifest: candidate,
    activate: {
      'feature-1': async (context) => {
        declaredReceipt = await context.identity.register({ id: 'cat', displayName: 'Fixture cat' });
        await (declaredReceipt as { dispose(): Promise<void> }).dispose();
        await context.skills.register({ id: 'undeclared', path: 'skills/undeclared' });
      },
    },
  }));

  await assert.rejects(
    entrypoint.create(manifest()).start(host([])),
    /contribution skill:undeclared is not declared by feature feature-1/i,
  );
  assert.equal((declaredReceipt as { key?: string } | undefined)?.key, 'identity:cat');
});

test('runtime subscriptions require a manifest declaration', async () => {
  const candidate = manifest();
  candidate.contributions = candidate.contributions.filter((contribution) => contribution.type !== 'message-subscription') as never;
  candidate.features[0]!.contributions = candidate.features[0]!.contributions.filter(
    (contribution) => contribution.type !== 'message-subscription',
  ) as never;
  const entrypoint = definePluginModule((input) => definePlugin({
    manifest: input,
    activate: {
      'feature-1': async (context) => {
        await context.messaging.subscribe('thread-1');
        return { actions: { 'fixture.echo': () => undefined }, dispose: () => undefined };
      },
    },
  }));
  await assert.rejects(
    entrypoint.create(candidate).start(host([])),
    /declares no message-subscription contribution/i,
  );
});

test('top-level operation and test callbacks join the closed module action table', async () => {
  const candidate = manifest() as ReturnType<typeof manifest> & {
    configuration: unknown[];
    test: { action: { method: string } };
  };
  candidate.configuration = [{
    key: 'connect', label: 'Connect', kind: 'operation', required: false,
    actions: [{ id: 'start', label: 'Start', render: 'button', action: { method: 'fixture.connect' } }],
  }];
  candidate.test = { action: { method: 'fixture.test' } };
  const entrypoint = definePluginModule((input) => definePlugin({
    manifest: input,
    activate: {
      'feature-1': () => ({
        actions: {
          'fixture.outbound': () => undefined,
          'fixture.echo': () => undefined,
          'fixture.connect': () => undefined,
          'fixture.test': () => undefined,
        },
        dispose: () => undefined,
      }),
    },
  }));
  const activation = await entrypoint.create(candidate).start(host([]));
  assert.deepEqual(Object.keys(activation.actions).sort(), [
    'fixture.connect', 'fixture.echo', 'fixture.outbound', 'fixture.test',
  ]);
  await activation.stop();
});

test('top-level callbacks are required once across a multi-feature module', async (t) => {
  const candidate = manifest() as ReturnType<typeof manifest> & {
    configuration: unknown[];
    test: { action: { method: string } };
  };
  candidate.configuration = [{
    key: 'login', label: 'Login', kind: 'operation', required: false,
    actions: [{ id: 'go', label: 'Go', render: 'button', action: { method: 'login.go' } }],
  }];
  candidate.test = { action: { method: 'self.test' } };
  candidate.features.push({
    id: 'aux', name: 'Auxiliary', resources: [], contributions: [], capabilities: [],
  } as never);

  const featureActions = {
    'fixture.outbound': () => undefined,
    'fixture.echo': () => undefined,
  };
  const globalActions = (include: boolean): Readonly<Record<string, () => undefined>> => include
    ? { 'login.go': () => undefined, 'self.test': () => undefined }
    : {};
  const createModule = (
    mainGlobals: boolean,
    auxGlobals: boolean,
  ) => definePluginModule((input) => definePlugin({
    manifest: input,
    activate: {
      'feature-1': () => ({
        actions: {
          ...featureActions,
          ...globalActions(mainGlobals),
        },
        dispose: () => undefined,
      }),
      aux: () => ({
        actions: globalActions(auxGlobals),
        dispose: () => undefined,
      }),
    },
  }));

  await t.test('one feature supplies both top-level callbacks', async () => {
    const activation = await createModule(true, false).create(candidate).start(host([]));
    assert.deepEqual(Object.keys(activation.actions).sort(), [
      'fixture.echo', 'fixture.outbound', 'login.go', 'self.test',
    ]);
    await activation.stop();
  });
  await t.test('no feature supplies the callbacks', async () => {
    await assert.rejects(
      createModule(false, false).create(candidate).start(host([])),
      /^TypeError: declared action login\.go has no plugin handler$/,
    );
  });
  await t.test('two features supply the same callback', async () => {
    await assert.rejects(
      createModule(true, true).create(candidate).start(host([])),
      /action handler login\.go is exposed by multiple plugin features/i,
    );
  });
});

test('feature activation cleanup is optional and never masks handler validation', async () => {
  const withoutDispose = definePluginModule((input) => definePlugin({
    manifest: input,
    activate: {
      'feature-1': () => ({
        actions: { 'fixture.outbound': () => undefined, 'fixture.echo': () => undefined },
      }),
    },
  }));
  const activation = await withoutDispose.create(manifest()).start(host([]));
  await activation.stop();

  const missingHandler = definePluginModule((input) => definePlugin({
    manifest: input,
    activate: {
      'feature-1': () => ({ actions: { 'fixture.outbound': () => undefined } }),
    },
  }));
  await assert.rejects(
    missingHandler.create(manifest()).start(host([])),
    /^TypeError: declared action fixture\.echo has no handler for feature feature-1$/,
  );
});

test('limb handlers pass through while duplicate callback and limb names fail closed', async () => {
  const candidate = manifest();
  candidate.contributions.push({ type: 'limb', id: 'commands', manifestPath: 'limbs/commands.yaml' } as never);
  candidate.features[0]!.contributions.push({ type: 'limb', id: 'commands' } as never);
  const passThrough = definePluginModule((input) => definePlugin({
    manifest: input,
    activate: {
      'feature-1': () => ({
        actions: {
          'fixture.outbound': () => undefined,
          'fixture.echo': () => undefined,
          'limb.execute': () => 'ok',
        },
        dispose: () => undefined,
      }),
    },
  }));
  const activation = await passThrough.create(candidate).start(host([]));
  assert.equal(await activation.actions['limb.execute']?.({}), 'ok');
  await activation.stop();

  candidate.contributions.push({
    type: 'tool', id: 'second-tool', name: 'second-tool', inputSchema: { type: 'object' },
    action: { method: 'limb.execute' },
  } as never);
  candidate.features.push({
    id: 'feature-2', name: 'Feature two', resources: [],
    contributions: [{ type: 'tool', id: 'second-tool' }], capabilities: [],
  } as never);
  const collision = definePluginModule((input) => definePlugin({
    manifest: input,
    activate: {
      'feature-1': () => ({
        actions: {
          'fixture.outbound': () => undefined,
          'fixture.echo': () => undefined,
          'limb.execute': () => 'limb',
        },
        dispose: () => undefined,
      }),
      'feature-2': () => ({ actions: { 'limb.execute': () => 'tool' }, dispose: () => undefined }),
    },
  }));
  await assert.rejects(
    collision.create(candidate).start(host([])),
    /action handler limb\.execute is exposed by multiple plugin features/i,
  );
});

type PublicSlot = (input: unknown, context: { readonly signal: AbortSignal; assertCurrent(): Promise<void> }) => Promise<Readonly<{ current: true }>>;
const publicInput = () => ({ authority: { ref: 'public:source-1', revision: 'source-revision-1' },
  source: { messageRef: 'message:source-1' }, targetCatId: 'cat-1', native: { contributionId: 'native-1', methods: ['native.read'] } });
const publicCall = () => ({ signal: new AbortController().signal, async assertCurrent() {} });
async function publicSlotFixture(raw: object, candidate = manifest()) {
  const entrypoint = definePluginModule(input => definePlugin({ manifest: input, activate: {
    'feature-1': () => raw as never,
  } }));
  return entrypoint.create(candidate).start(host([]));
}
function publicActivation(slot?: unknown) {
  return { actions: { 'fixture.outbound': () => undefined, 'fixture.echo': () => undefined },
    ...(slot === undefined ? {} : { publicInvocationVerifier: slot }) };
}
function slotOf(activation: object): PublicSlot {
  const descriptor = Object.getOwnPropertyDescriptor(activation, 'publicInvocationVerifier');
  assert.equal(typeof descriptor?.value, 'function', 'Feature → module must preserve its private verifier slot');
  return descriptor!.value as PublicSlot;
}

test('public verifier slot traverses Feature and module with exact isolated ABI', async () => {
  let captured!: Parameters<PublicSlot>[1]; let received: unknown; let calls = 0;
  const activation = await publicSlotFixture(publicActivation(async (input: unknown, context: Parameters<PublicSlot>[1]) => {
    calls++; received = input; captured = context;
    assert.deepEqual(Object.keys(context).sort(), ['assertCurrent', 'signal']);
    await context.assertCurrent(); return { current: true };
  }));
  const input = publicInput(); const result = await slotOf(activation)(input, publicCall());
  assert.deepEqual(received, input); assert.notEqual(received, input);
  assert.ok(Object.isFrozen(received)); assert.ok(Object.isFrozen((received as typeof input).native.methods));
  assert.deepEqual(result, { current: true }); assert.ok(Object.isFrozen(result)); assert.equal(calls, 1);
  assert.equal(activation.actions['host.public-invocation.assert-current'], undefined);
  await assert.rejects(captured.assertCurrent(), /expired/);
  await activation.stop(); await assert.rejects(slotOf(activation)(input, publicCall()), /revoked|stopped/);
});

test('public verifier remains absent for older activators', async () => {
  const activation = await publicSlotFixture(publicActivation());
  assert.equal(Object.hasOwn(activation, 'publicInvocationVerifier'), false); await activation.stop();
});

test('public verifier rejects inherited/accessor/non-function slots without invoking getters', async () => {
  let gets = 0; let disposals = 0;
  for (const malformed of [Object.assign(Object.create({ publicInvocationVerifier: () => ({ current: true }) }), publicActivation()),
    Object.defineProperty(publicActivation(), 'publicInvocationVerifier', { get() { gets++; return () => ({ current: true }); } }),
    publicActivation(true)]) {
    Object.assign(malformed, { dispose() { disposals++; } });
    await assert.rejects(publicSlotFixture(malformed), /own data function/);
  }
  assert.equal(gets, 0); assert.equal(disposals, 3);
});

test('public verifier rejects invalid snapshots and context identity fields before calling business', async () => {
  let calls = 0;
  const activation = await publicSlotFixture(publicActivation(() => { calls++; return { current: true }; }));
  const slot = slotOf(activation);
  for (const input of [{ ...publicInput(), userId: 'owner' }, { ...publicInput(), authority: { ref: 'x', revision: 1 } },
    { ...publicInput(), native: { contributionId: 'native-1', methods: ['b', 'a'] } },
    { ...publicInput(), native: { contributionId: 'native-1', methods: ['a', 'a'] } },
    { ...publicInput(), source: { messageRef: 'message:bad\n' } }]) await assert.rejects(slot(input, publicCall()), TypeError);
  await assert.rejects(slot(publicInput(), { ...publicCall(), userId: 'owner' } as never), TypeError);
  assert.equal(calls, 0); await activation.stop();
});

test('public verifier requires strictly current true and preserves Host refusals without retry', async () => {
  for (const result of [false, { current: false }, { current: true, authority: 'widened' },
    Object.defineProperty({}, 'current', { enumerable: true, get() { throw new Error('must not read getter'); } })]) {
    const activation = await publicSlotFixture(publicActivation(() => result));
    await assert.rejects(slotOf(activation)(publicInput(), publicCall()), TypeError); await activation.stop();
  }
  let calls = 0; const refused = new Error('authority revoked');
  const activation = await publicSlotFixture(publicActivation(() => { calls++; return { current: true }; }));
  await assert.rejects(slotOf(activation)(publicInput(), { signal: publicCall().signal, async assertCurrent() { throw refused; } }), error => error === refused);
  assert.equal(calls, 0); await activation.stop();
});

test('public verifier abort and stop reject pending or late results', async () => {
  for (const reason of ['abort', 'stop']) {
    let finish!: (value: { current: true }) => void; const controller = new AbortController();
    const activation = await publicSlotFixture(publicActivation(() => new Promise(resolve => { finish = resolve; })));
    const pending = slotOf(activation)(publicInput(), { signal: controller.signal, async assertCurrent() {} });
    const rejected = assert.rejects(pending); await new Promise(resolve => setImmediate(resolve));
    if (reason === 'abort') controller.abort(new Error('caller cancelled')); else await activation.stop();
    await rejected; finish({ current: true }); await activation.stop();
  }
});

test('public verifier cannot occupy ordinary action or MCP method', async () => {
  const raw = publicActivation(() => ({ current: true }));
  raw.actions['host.public-invocation.assert-current' as keyof typeof raw.actions] = () => undefined;
  await assert.rejects(publicSlotFixture(raw), /declared|ordinary action/);
  const candidate = manifest();
  candidate.contributions.push({ type: 'mcp', id: 'native', runtime: { transport: 'stdio', entrypoint: 'native.js' },
    actions: [{ method: 'host.public-invocation.assert-current' }] } as never);
  candidate.features[0]!.contributions.push({ type: 'mcp', id: 'native' } as never);
  await assert.rejects(publicSlotFixture(publicActivation(), candidate), /ordinary action/);
});

test('public verifier snapshots before Host awaits and preserves business refusal once', async () => {
  let release!: () => void; let first = true; let seen: unknown; let calls = 0;
  const activation = await publicSlotFixture(publicActivation((input: unknown) => { calls++; seen = input; return { current: true }; }));
  const input = publicInput();
  const pending = slotOf(activation)(input, { signal: publicCall().signal, async assertCurrent() {
    if (first) { first = false; await new Promise<void>(resolve => { release = resolve; }); }
  } });
  input.authority.revision = 'changed'; input.native.methods.push('native.write'); release();
  await pending; assert.deepEqual(seen, publicInput()); assert.equal(calls, 1); await activation.stop();
  const refusal = new Error('Service participation revoked');
  const denied = await publicSlotFixture(publicActivation(() => { calls++; throw refusal; }));
  await assert.rejects(slotOf(denied)(publicInput(), publicCall()), error => error === refusal);
  assert.equal(calls, 2); await denied.stop();
});

test('public verifier duplicates reject startup and dispose both feature owners', async () => {
  const candidate = manifest();
  candidate.features.push({ id: 'feature-2', name: 'Other', resources: [], contributions: [], capabilities: [] });
  let disposals = 0;
  const entrypoint = definePluginModule(input => definePlugin({ manifest: input, activate: {
    'feature-1': () => ({ ...publicActivation(() => ({ current: true })), dispose() { disposals++; } }) as never,
    'feature-2': () => ({ publicInvocationVerifier: () => ({ current: true as const }), dispose() { disposals++; } }),
  } }));
  await assert.rejects(entrypoint.create(candidate).start(host([])), /multiple plugin features/);
  assert.equal(disposals, 2);
});


test('native second context keeps authenticated owner/policy and exact origin separate from held source', async () => {
  let seen: PluginActionContext | undefined;
  const entrypoint = definePluginModule(input => definePlugin({ manifest: input, activate: {
    'feature-1': () => ({ actions: { 'fixture.outbound': () => undefined, 'fixture.echo': (_input, native) => { seen = native; return native?.ownerAuthProvenance; } } }),
  } }));
  const active = await entrypoint.create(manifest()).start(host([]));
  const policy = Object.freeze({ mode: 'read_only', replayDeniedToolNames: Object.freeze([]) });
  const native: PluginActionContext = Object.freeze({ userId: 'owner', threadId: 'thread', catId: 'cat', invocationId: 'invocation',
    ownerAuthProvenance: 'strict', toolExecutionPolicy: policy, originTriggerMessageId: 'origin',
    source: Object.freeze({ kind: 'adopted_hold', sourceMessageId: 'different-held-source', holdTaskId: 'task' }), async assertCurrent() {} });
  try {
    assert.equal(await active.actions['fixture.echo']!({ ownerAuthProvenance: 'unknown' }, native), 'strict');
    assert.equal(seen, native); assert.equal(seen?.originTriggerMessageId, 'origin');
    assert.equal(seen?.source?.sourceMessageId, 'different-held-source'); assert.equal(seen?.toolExecutionPolicy, policy);
    assert.equal(await active.actions['fixture.echo']!({ ownerAuthProvenance: 'strict' }), undefined);
    assert.equal(seen, undefined, 'business input cannot populate native authority');
  } finally { await active.stop(); }
});


async function taskReadFixture(task: unknown, taskHost?: ModulePluginHostShape['tasks']) {
  let context!: FeatureContext;
  const runtimeHost: ModulePluginHostShape = { ...host([]), ...(taskHost ? { tasks: taskHost } : {}) };
  if (!taskHost) {
    for (const name of ['get', 'getBySubject'] as const) runtimeHost.tasks[name] = async () => task as never;
    for (const name of ['listByThread', 'listByKind'] as const) runtimeHost.tasks[name] = async () => [task] as never;
  }
  const entrypoint = definePluginModule(input => definePlugin({ manifest: input, activate: {
    'feature-1': value => { context = value; return { actions: {
      'fixture.outbound': () => undefined, 'fixture.echo': () => undefined,
    } }; },
  } }));
  const activation = await entrypoint.create(manifest()).start(runtimeHost);
  return { context, activation };
}

const taskReadBase = { id: 'read-task', kind: 'work', threadId: 'thread-1', subjectKey: null,
  title: 'Owner task', ownerCatId: null, status: 'doing', why: '', createdBy: 'owner', createdAt: 1, updatedAt: 1 } as const;

test('all four Task reads preserve the declared owner and bounded Work summary without authority fields', async () => {
  const task = { ...taskReadBase, userId: 'local-owner', secret: 'host-only', entrustedWork: {
    revision: 3, closure: { state: 'open', privateResult: 'host-only' },
    admission: { sourceRefs: ['message:source'], grant: 'host-only' }, execution: { seal: 'host-only' },
  } };
  const { context, activation } = await taskReadFixture(task);
  try {
    const results = [await context.tasks.get('read-task'), await context.tasks.getBySubject('subject'),
      ...(await context.tasks.listByThread('thread-1')), ...(await context.tasks.listByKind('work'))];
    for (const result of results) {
      assert.deepEqual(result, { ...taskReadBase, userId: 'local-owner', entrustedWork: {
        revision: 3, closure: { state: 'open' }, admission: { sourceRefs: ['message:source'] },
      } });
      assert.ok(Object.isFrozen(result));
      assert.ok(Object.isFrozen(result!.entrustedWork!.admission.sourceRefs));
    }
    task.entrustedWork.admission.sourceRefs.push('message:later');
    assert.deepEqual(results[0]!.entrustedWork!.admission.sourceRefs, ['message:source']);
  } finally { await activation.stop(); }
});

test('Task reads reject an undeclared owner projection instead of silently losing owned Tasks', async () => {
  const { context, activation } = await taskReadFixture(taskReadBase);
  try {
    await assert.rejects(() => context.tasks.get('read-task'), /Task read.*userId/);
    await assert.rejects(() => context.tasks.getBySubject('subject'), /Task read.*userId/);
    await assert.rejects(() => context.tasks.listByThread('thread-1'), /Task read.*userId/);
    await assert.rejects(() => context.tasks.listByKind('work'), /Task read.*userId/);
  } finally { await activation.stop(); }
});

test('Task reads accept explicit unowned null and reject malformed Work summaries', async () => {
  const legacy = await taskReadFixture({ ...taskReadBase, userId: null });
  try { assert.deepEqual(await legacy.context.tasks.get('read-task'), { ...taskReadBase, userId: null }); }
  finally { await legacy.activation.stop(); }
  for (const entrustedWork of [{ revision: -1, closure: { state: 'open' }, admission: { sourceRefs: [] } },
    { revision: 3, closure: { state: 'open' }, admission: { sourceRefs: ['message:source', 1] } }]) {
    const invalid = await taskReadFixture({ ...taskReadBase, userId: 'owner', entrustedWork });
    try { await assert.rejects(() => invalid.context.tasks.get('read-task'), /Task read.*entrustedWork/); }
    finally { await invalid.activation.stop(); }
  }
});


const publicWait = { pluginInstanceId: 'installed-instance', generation: 2,
  await: { generation: 2, expiresAt: 9000 },
  waitOutcome: { outcomeId: 'outcome-1', generation: 1, ownerFence: { kind: 'containing_task', generation: 1 },
    reason: 'matched', delivery: 'delivered' } } as const;

test('rich Host pluginWait is reduced to every declared neutral wait field on all four Task reads', async () => {
  const richWait = { ...publicWait, invalidated: true, userId: 'private-owner', catId: 'private-cat', threadId: 'private-thread',
    registration: { invocationId: 'private-invocation', source: { content: 'private-source' } },
    await: { ...publicWait.await, registration: { source: 'private-await-source' } },
    waitOutcome: { ...publicWait.waitOutcome, userId: 'private-owner', ownerFence: { ...publicWait.waitOutcome.ownerFence, source: 'private-fence' } } };
  const { context, activation } = await taskReadFixture({ ...taskReadBase, userId: 'owner', pluginWait: richWait });
  try {
    for (const task of [await context.tasks.get('read-task'), await context.tasks.getBySubject('subject'),
      ...(await context.tasks.listByThread('thread')), ...(await context.tasks.listByKind('work'))]) {
      assert.deepEqual(task!.pluginWait, publicWait);
      assert.ok(Object.isFrozen(task!.pluginWait!.await));
      assert.ok(Object.isFrozen(task!.pluginWait!.waitOutcome!.ownerFence));
    }
  } finally { await activation.stop(); }
});

test('Task wait projection rejects malformed declared nested fields without leaking a partial snapshot', async () => {
  for (const pluginWait of [{ ...publicWait, generation: -1 }, { ...publicWait, await: { generation: '2' } },
    { ...publicWait, waitOutcome: { ...publicWait.waitOutcome, reason: 'unknown-private-reason' } },
    { ...publicWait, waitOutcome: { ...publicWait.waitOutcome, ownerFence: { kind: 'foreign_scope', generation: 1 } } },
    { ...publicWait, waitOutcome: { ...publicWait.waitOutcome, delivery: 'invalid' } }]) {
    const { context, activation } = await taskReadFixture({ ...taskReadBase, userId: null, pluginWait });
    try { await assert.rejects(() => context.tasks.get('read-task'), /Task read.*pluginWait/); }
    finally { await activation.stop(); }
  }
});


if (process.env.C1_TASK_READ_HOST_MODULE) test('actual compiled Host rich wait crosses SDK as exactly the public neutral wait snapshot', async () => {
  const { createPluginTaskHost } = await import(process.env.C1_TASK_READ_HOST_MODULE!);
  const raw = { ...taskReadBase, userId: 'owner', pluginWait: { ...publicWait,
    userId: 'private-owner', catId: 'private-cat', threadId: 'private-thread', invalidated: true,
    registration: { invocationId: 'private-invocation', source: { content: 'private-source' } },
    await: { ...publicWait.await, registration: { source: 'private-await-source' } },
    waitOutcome: { ...publicWait.waitOutcome, ownerFence: { ...publicWait.waitOutcome.ownerFence, source: 'private-fence' } } } };
  const taskHost: ModulePluginHostShape['tasks'] = createPluginTaskHost({ pluginId: 'dev.clowder.module-fixture',
    ownerUserId: 'owner', readThreadStore: { async get(id: string) { return { id, createdBy: 'owner' }; } },
    effectiveGrants: ['task.read'], taskStore: { async get() { return raw; }, async getBySubject() { return raw; },
      async listByThread() { return [raw]; }, async listByKind() { return [raw]; } } });
  const { context, activation } = await taskReadFixture(undefined, taskHost);
  try {
    for (const task of [await context.tasks.get('read-task'), await context.tasks.getBySubject('subject'),
      ...(await context.tasks.listByThread('thread')), ...(await context.tasks.listByKind('work'))]) {
      assert.deepEqual(task!.pluginWait, publicWait);
      assert.deepEqual(Object.keys(task!.pluginWait!).sort(), ['await', 'generation', 'pluginInstanceId', 'waitOutcome']);
    }
  } finally { await activation.stop(); }
});


test('participantRoster opt-in exposes quota separately from unsupported native policy without changing default rows', async () => {
  const calls: unknown[] = [], row = { catId: 'cat', displayName: 'Cat', defaultModel: 'model', supported: false };
  const { context, activation } = await participantRosterFixture({ async listForNativeContribution(input: { contributionId: string; includeAvailability?: true }) {
    calls.push(input); return input.includeAvailability === true ? [{ ...row, available: true }] : [row];
  } });
  try {
    const request = { contributionId: 'native', includeAvailability: true as const };
    const rows = await context.participantRoster!.listForNativeContribution(request);
    assert.deepEqual(calls, [request]); assert.deepEqual(rows, [{ ...row, available: true }]);
    assert.ok(Object.isFrozen(rows)); assert.ok(Object.isFrozen(rows[0]));
    assert.deepEqual(await context.participantRoster!.listForNativeContribution({ contributionId: 'native' }), [row]);
  } finally { await activation.stop(); }
});
test('participantRoster quota opt-in refuses missing/malformed quota, extra authority, and false/undefined flags before Host effects', async () => {
  const row = { catId: 'cat', displayName: 'Cat', defaultModel: 'model', supported: true }; let result: unknown = [], calls = 0;
  const { context, activation } = await participantRosterFixture({ async listForNativeContribution() { calls++; return result; } });
  try {
    for (const value of [{ ...row }, { ...row, available: 'true' }, { ...row, available: null }, { ...row, available: true, grantRef: 'forged' }]) {
      result = [value];
      await assert.rejects(() => context.participantRoster!.listForNativeContribution({ contributionId: 'native', includeAvailability: true } as never), /PluginParticipant/);
    }
    const before = calls;
    for (const value of [{ contributionId: 'native', includeAvailability: false }, { contributionId: 'native', includeAvailability: undefined }]) {
      await assert.rejects(() => context.participantRoster!.listForNativeContribution(value as never), /PluginParticipantRosterInput/);
    }
    assert.equal(calls, before);
  } finally { await activation.stop(); }
});
