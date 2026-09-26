import assert from 'node:assert/strict';
import test from 'node:test';

import {
  definePlugin,
  type FeatureContext,
} from './feature-context.js';
import { definePluginModule } from './module-plugin.js';

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

function host(calls: Array<{ operation: string; value?: unknown }>, sendError?: Error) {
  const task = {
    id: 'task-1', kind: 'work', threadId: 'thread-1', subjectKey: 'fixture:1', title: 'Fixture task',
    ownerCatId: null, status: 'todo', why: '', createdBy: 'system', createdAt: 1, updatedAt: 1,
  } as const;
  return {
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
    },
    threads: {
      get: async () => null,
      create: async () => ({ id: 'thread-1', title: 'Fixture', createdAt: 1, lastActiveAt: 1 }),
      update: async () => ({ id: 'thread-1', title: 'Fixture', createdAt: 1, lastActiveAt: 1 }),
      findByKey: async () => null,
      ensureByKey: async (key: string, input: unknown) => {
        calls.push({ operation: 'threads.ensureByKey', value: { key, input } });
        return { id: 'thread-1', title: 'Fixture', createdAt: 1, lastActiveAt: 1 };
      },
      bind: async () => ({ key: 'fixture', threadId: 'thread-1', createdAt: 1 }),
      unbind: async () => true,
      listBindings: async () => [],
      ensureSystemThread: async () => ({ id: 'system-thread', title: 'System', createdAt: 1, lastActiveAt: 1 }),
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
    log: (level: string, message: string, fields?: Readonly<Record<string, unknown>>) => {
      calls.push({ operation: 'log', value: { level, message, fields } });
    },
  };
}

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
          id: 'thread-1', title: 'Fixture', createdAt: 1, lastActiveAt: 1,
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
