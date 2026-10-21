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
      list: async () => [task],
      create: async (input: unknown, options?: unknown) => (calls.push({ operation: 'tasks.create', value: {input,options} }), task),
      update: async () => task,
      bindDataController: async () => { throw new Error('unused Task data-controller binding'); },
      revokeDataController: async () => { throw new Error('unused Task data-controller revocation'); },
    },
    threads: {
      get: async () => null,
      list: async () => [],
      readMessages: async () => [],
      getCats: async () => ({ participants: [], routableNow: [], routableNotJoined: [], notRoutable: [] }),
      create: async (input: unknown) => (calls.push({ operation: 'threads.create', value: input }), { id: 'thread-1', deepLinkUrl: 'https://owner.example/thread/thread-1', title: 'Fixture', createdAt: 1, lastActiveAt: 1, preferredCats: [], featureRefs: [] }),
      update: async () => ({ id: 'thread-1', deepLinkUrl: 'https://owner.example/thread/thread-1', title: 'Fixture', createdAt: 1, lastActiveAt: 1, preferredCats: [], featureRefs: [] }),
    addParticipants: async () => { throw new Error('unused fixture addParticipants'); },
},
    messaging: {get: async () => null,
      send: async (input: unknown) => {
        calls.push({ operation: 'messaging.send', value: input });
        if (sendError) throw sendError;
        return { messageId: 'message-1', threadId: 'thread-1' };
      },
      subscribe: async (input: unknown) => { calls.push({ operation: 'messaging.subscribe', value: input }); },
      unsubscribe: async (input: unknown) => { calls.push({ operation: 'messaging.unsubscribe', value: input }); },
    },
    streams: {read: async function*() {}},
    dataPath: dataDirectory ?? '/isolated/fixture',
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
  await runtime.stop({reason:'test'});
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
  await activation.stop({reason:'test'});
});

function moduleWithJourney(received: unknown[]) {
  return definePluginModule((candidate) => definePlugin({
    manifest: candidate,
    activate: {
      'feature-1': async (context: FeatureContext) => {
        assert.equal(await context.config.get('mode'), 'safe');
        assert.equal(await context.secrets.get('token'), 'secret');
        await context.messaging.subscribe('thread-1', { contributionId: 'outbound', includeOwnMessages: true });
        assert.deepEqual(await context.messaging.send('thread-1', {
          idempotencyKey: 'message-1',
          payload: {
            provenance: { epistemicStatus: 'observation' },
            elements: [{ elementId: 'text-1', kind: 'text', payload: { text: 'hello' } }],
          },
        }), { messageId: 'message-1', threadId: 'thread-1' });
        assert.deepEqual(await context.threads.create({ title: 'Fixture' }), {
          id: 'thread-1', deepLinkUrl: 'https://owner.example/thread/thread-1', title: 'Fixture', createdAt: 1, lastActiveAt: 1, preferredCats: [], featureRefs: [],
        });
        assert.deepEqual(await context.storage.compareAndSet('cursor', null, { sequence: 1 }), {
          applied: true, revision: 3,
        });
        assert.equal(Object.hasOwn(context,'state'), false);
        assert.equal((await context.tasks.create({
    threadId: 'thread-1', title: 'Fixture task', subjectKey: 'fixture:1',
}, { onConflict: "update" })).id, 'task-1');
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
  assert.equal(calls.some((call) => call.operation === 'threads.create'), true);
  assert.equal(calls.some((call) => call.operation === 'storage.compareAndSet'), true);
  assert.equal(calls.some((call) => call.operation === 'tasks.create'), true);
  assert.deepEqual(calls.find((call) => call.operation === 'log')?.value, {
    level: 'info', message: 'fixture started', fields: { featureId: 'feature-1' },
  });
  await activation.stop({reason:'test'});
  await activation.stop({reason:'test'});
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
  await activation.stop({reason:'test'});
});

test('a fresh module start replays subscriptions without an SDK registration store', async () => {
  const calls: Array<{ operation: string; value?: unknown }> = [];
  const entrypoint = moduleWithJourney([]);
  const first = await entrypoint.create(manifest()).start(host(calls));
  await first.stop({reason:'test'});
  const second = await entrypoint.create(manifest()).start(host(calls));
  await second.stop({reason:'test'});
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
  await activation.stop({reason:'test'});
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
    await activation.stop({reason:'test'});
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
  await activation.stop({reason:'test'});

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
  await activation.stop({reason:'test'});

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
  } finally { await active.stop({reason:'test'}); }
});


async function taskReadFixture(task: unknown, taskHost?: ModulePluginHostShape['tasks']) {
  let context!: FeatureContext;
  const runtimeHost: ModulePluginHostShape = { ...host([]), ...(taskHost ? { tasks: taskHost } : {}) };
  if (!taskHost) {
    runtimeHost.tasks.get = async () => task as never;
    runtimeHost.tasks.list = async () => [task] as never;
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
    const results = [await context.tasks.get({ id: 'read-task' }), await context.tasks.get({ subjectKey: 'subject' }),
      ...(await context.tasks.list({ threadId: 'thread-1' })), ...(await context.tasks.list({ kind: 'work' }))];
    for (const result of results) {
      assert.deepEqual(result, { ...taskReadBase, userId: 'local-owner', entrustedWork: {
        revision: 3, closure: { state: 'open' }, admission: { sourceRefs: ['message:source'] },
      } });
      assert.ok(Object.isFrozen(result));
      assert.ok(Object.isFrozen(result!.entrustedWork!.admission.sourceRefs));
    }
    task.entrustedWork.admission.sourceRefs.push('message:later');
    assert.deepEqual(results[0]!.entrustedWork!.admission.sourceRefs, ['message:source']);
  } finally { await activation.stop({reason:'test'}); }
});

test('Task reads reject an undeclared owner projection instead of silently losing owned Tasks', async () => {
  const { context, activation } = await taskReadFixture(taskReadBase);
  try {
    await assert.rejects(() => context.tasks.get({ id: 'read-task' }), /Task read.*userId/);
    await assert.rejects(() => context.tasks.get({ subjectKey: 'subject' }), /Task read.*userId/);
    await assert.rejects(() => context.tasks.list({ threadId: 'thread-1' }), /Task read.*userId/);
    await assert.rejects(() => context.tasks.list({ kind: 'work' }), /Task read.*userId/);
  } finally { await activation.stop({reason:'test'}); }
});

test('Task reads accept explicit unowned null and reject malformed Work summaries', async () => {
  const legacy = await taskReadFixture({ ...taskReadBase, userId: null });
  try { assert.deepEqual(await legacy.context.tasks.get({ id: 'read-task' }), { ...taskReadBase, userId: null }); }
  finally { await legacy.activation.stop({reason:'test'}); }
  for (const entrustedWork of [{ revision: -1, closure: { state: 'open' }, admission: { sourceRefs: [] } },
    { revision: 3, closure: { state: 'open' }, admission: { sourceRefs: ['message:source', 1] } }]) {
    const invalid = await taskReadFixture({ ...taskReadBase, userId: 'owner', entrustedWork });
    try { await assert.rejects(() => invalid.context.tasks.get({ id: 'read-task' }), /Task read.*entrustedWork/); }
    finally { await invalid.activation.stop({reason:'test'}); }
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
    for (const task of [await context.tasks.get({ id: 'read-task' }), await context.tasks.get({ subjectKey: 'subject' }),
      ...(await context.tasks.list({ threadId: 'thread' })), ...(await context.tasks.list({ kind: 'work' }))]) {
      assert.deepEqual(task!.pluginWait, publicWait);
      assert.ok(Object.isFrozen(task!.pluginWait!.await));
      assert.ok(Object.isFrozen(task!.pluginWait!.waitOutcome!.ownerFence));
    }
  } finally { await activation.stop({reason:'test'}); }
});

test('Task wait projection rejects malformed declared nested fields without leaking a partial snapshot', async () => {
  for (const pluginWait of [{ ...publicWait, generation: -1 }, { ...publicWait, await: { generation: '2' } },
    { ...publicWait, waitOutcome: { ...publicWait.waitOutcome, reason: 'unknown-private-reason' } },
    { ...publicWait, waitOutcome: { ...publicWait.waitOutcome, ownerFence: { kind: 'foreign_scope', generation: 1 } } },
    { ...publicWait, waitOutcome: { ...publicWait.waitOutcome, delivery: 'invalid' } }]) {
    const { context, activation } = await taskReadFixture({ ...taskReadBase, userId: null, pluginWait });
    try { await assert.rejects(() => context.tasks.get({ id: 'read-task' }), /Task read.*pluginWait/); }
    finally { await activation.stop({reason:'test'}); }
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
    for (const task of [await context.tasks.get({ id: 'read-task' }), await context.tasks.get({ subjectKey: 'subject' }),
      ...(await context.tasks.list({ threadId: 'thread' })), ...(await context.tasks.list({ kind: 'work' }))]) {
      assert.deepEqual(task!.pluginWait, publicWait);
      assert.deepEqual(Object.keys(task!.pluginWait!).sort(), ['await', 'generation', 'pluginInstanceId', 'waitOutcome']);
    }
  } finally { await activation.stop({reason:'test'}); }
});

if (process.env.C1_TASK_READ_HOST_MODULE) test('actual compiled Host controller mutations cross the SDK with one validated Task projection',async()=>{
  const hostUrl=new URL(process.env.C1_TASK_READ_HOST_MODULE!);
  const {createPluginTaskHost}=await import(hostUrl.href);
  const {transitionEntrustedTaskDataController}=await import(new URL(
    '../../../cats/services/stores/ports/TaskDataControllerTransition.js',hostUrl).href);
  const {withCurrentOwnerOperation}=await import(new URL('../../carrier/plugin-owner-operation-context.js',hostUrl).href);
  let raw={id:'legacy-task',kind:'work',threadId:'private',subjectKey:'entrusted:legacy',title:'Legacy Work',
    ownerCatId:'cat',status:'todo',why:'Continue',createdBy:'user',createdAt:1,updatedAt:1,userId:'owner',
    entrustedWork:{revision:1,admission:{basis:'authorized_source',sourceRefs:['message:first'],
      idempotencyKey:'original',receiptRef:'task:receipt:original',admittedAt:1,authorityRef:'message:admission'},
      intendedOutcome:'Continue',time:{},artifactRefs:[],closure:{state:'open',condition:'Accepted',
        expectedSignal:'accepted',evidenceRefs:[]}}};
  const taskStore={async get(id:string){return id===raw.id?structuredClone(raw):null;},
    async getBySubject(){return structuredClone(raw);},async listByThread(){return[structuredClone(raw)];},
    async listByKind(){return[structuredClone(raw)];},async transitionEntrustedTaskDataController(input:unknown){
      const result=transitionEntrustedTaskDataController(structuredClone(raw),input);
      if(result.kind==='bound'||result.kind==='revoked')raw=structuredClone(result.task);return result;}};
  const controller={pluginId:'official.collective-connector',pluginInstanceId:'installed-module-fixture',
    moduleRef:'plugin:official.collective-connector',lifecycleRevision:8,grantRevision:3,
    effectiveGrants:['task.read','task.write','task.admitEntrusted']};
  const taskHost:ModulePluginHostShape['tasks']=createPluginTaskHost({pluginId:controller.pluginId,
    pluginInstanceId:controller.pluginInstanceId,ownerUserId:'owner',effectiveGrants:controller.effectiveGrants,
    taskStore,readThreadStore:{async get(id:string){return{id,createdBy:'owner',participants:['cat']};}},
    admission:{messageStore:{},isCatAvailable:(catId:string)=>catId==='cat',assertCurrent:async()=>{},
      readCurrentDataControllerAuthority:async()=>controller,
      withCurrentDataControllerAuthority:async(run:(value:unknown)=>unknown)=>run(controller)}});
  const {context,activation}=await taskReadFixture(undefined,taskHost);
  const owner={kind:'owner-operation',userId:'owner',pluginInstanceId:controller.pluginInstanceId,
    operationKey:'work',actionId:'adopt-task',requestId:'owner-bind',confirmed:true,
    signal:new AbortController().signal,assertCurrent:async()=>{}};
  try{
    const bound=await withCurrentOwnerOperation(owner,()=>context.tasks.bindDataController({taskId:raw.id,
      expectedTaskRevision:1,operationId:'owner-bind-operation',expected:{ownerCatId:'cat',threadId:'private',
        subjectKey:'entrusted:legacy',firstSourceRef:'message:first',admissionAuthorityRef:'message:admission'}}));
    assert.equal(bound.disposition,'bound');assert.equal(bound.task.entrustedWork!.dataController!.currentForCaller,true);
    assert.equal('receipts' in bound.task.entrustedWork!.dataController!,false);
    const binding=bound.task.entrustedWork!.dataController!;
    const revoked=await withCurrentOwnerOperation({...owner,actionId:'revoke-task',requestId:'owner-revoke'},()=>
      context.tasks.revokeDataController({taskId:raw.id,expectedTaskRevision:2,
        expectedBindingRevision:binding.bindingRevision,expectedControllerReceiptRef:binding.binding.ownerOperationReceiptRef,
        operationId:'owner-revoke-operation'}));
    assert.equal(revoked.disposition,'revoked');assert.equal(revoked.task.entrustedWork!.dataController!.currentForCaller,false);
    assert.equal(revoked.task.entrustedWork!.dataController!.revocationReceiptRef,revoked.receiptRef);
  }finally{await activation.stop({reason:'test'});}
});


test('removed hidden queue ports are not exposed by feature or module activation', async () => {
  let context!: FeatureContext;
  let effects = 0;
  const legacy = { ...host([]), publicInvocations: { async enqueue() { effects++; throw new Error('retired queue'); } } };
  const entrypoint = definePluginModule(input => definePlugin({ manifest: input, activate: {
    'feature-1': value => {
      context = value;
      return { actions: { 'fixture.outbound': () => undefined, 'fixture.echo': () => undefined },
        publicInvocationVerifier: () => { effects++; return { current: true as const }; } };
    },
  } }));
  const active = await entrypoint.create(manifest()).start(legacy);
  try {
    assert.equal(Object.hasOwn(context, 'publicInvocations'), false);
    assert.equal(Object.hasOwn(active, 'publicInvocationVerifier'), false);
    assert.equal(effects, 0);
  } finally { await active.stop({reason:'test'}); }
});

test('current public thread surface matches the developer baseline', async () => {
  let context!: FeatureContext;
  const entrypoint = definePluginModule(input => definePlugin({ manifest: input, activate: {
    'feature-1': value => { context = value; return { actions: { 'fixture.outbound': () => undefined, 'fixture.echo': () => undefined } }; },
  } }));
  const active = await entrypoint.create(manifest()).start(host([]));
  try {
    const methods = ['get', 'list', 'readMessages', 'getCats', 'create', 'update', 'addParticipants'];
    assert.deepEqual(Object.keys(context.threads).sort(), methods.sort());
    const { readFile } = await import('node:fs/promises');
    const baseline = await readFile(new URL('../../../docs/plugin-development.md', import.meta.url), 'utf8');
    for (const method of methods) assert.ok(baseline.includes(`context.threads.${method}`), `Document threads.${method}`);
    assert.deepEqual([...baseline.matchAll(/^## (\d)\./gm)].map(match => match[1]), ['1', '2', '3']);
    for (const field of ['sourceFacts', 'nativeContext', 'participantRoster', 'ownerThreads', 'publicInvocations'])
      assert.equal(Object.hasOwn(context, field), false);
  } finally { await active.stop({reason:'test'}); }
});
