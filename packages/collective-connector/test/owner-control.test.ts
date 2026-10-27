import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { type ModulePluginHostShape } from '@clowder-ai/plugin-sdk';
import { parse } from 'yaml';
import { createOwnerControlHttp } from '../src/owner-control-http.js';
import entrypoint from '../src/plugin-entrypoint.js';
import { memoryStorage, ownerAction, ownerCaller, serviceHostConfig } from './runtime-fixture.js';

const manifest = parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8'));
const fixtureHost = (directory: string): ModulePluginHostShape => ({
  pluginInstanceId: 'installed-instance',
  dataPath: directory ?? '',
  config: serviceHostConfig(),
  secrets: {
    async get() {
      return undefined;
    },
  },
  storage: memoryStorage(),
  tasks: { list: async () => [] } as never,
  threads: {} as never,
  streams: {
    read: async function* () {
      throw new Error('Unused stream port');
    },
  },
  messaging: {} as never,
  log() {},
  members: {
    async get() {
      return null;
    },
    async list() {
      return [];
    },
  },
});
const ownerRequest = (method: string, path: string, body?: unknown) => ({
  request: {
    method,
    path,
    query: {},
    headers: { origin: 'http://localhost:5172' },
    principal: { kind: 'owner', id: 'fixture-owner' },
    ...(body === undefined ? {} : { body }),
  },
});

test('authenticated owner HTTP facts reach the original control caller and expired or mismatched requests have no effects', async () => {
  const port = controlledPort();
  const controller = new AbortController();
  const caller = {
    kind: 'owner-http-request' as const,
    userId: 'fixture-owner',
    pluginInstanceId: 'instance',
    operation: 'read' as const,
    signal: controller.signal,
    async assertCurrent() {
      controller.signal.throwIfAborted();
    },
  };
  const result = await port.invoke(ownerRequest('GET', 'connections'), undefined, caller);
  assert.equal(result.status, 200);
  assert.deepEqual(port.calls, ['list']);
  await assert.rejects(
    () => port.invoke(ownerRequest('GET', 'connections'), undefined, { ...caller, userId: 'foreign' }),
    /webhook/,
  );
  await assert.rejects(
    () => port.invoke(ownerRequest('GET', 'connections'), undefined, { ...caller, operation: 'write' }),
    /webhook/,
  );
  assert.equal(port.calls.length, 1);
  controller.abort(new Error('HTTP request ended'));
  await assert.rejects(() => port.invoke(ownerRequest('GET', 'connections'), undefined, caller), /request ended/);
  assert.equal(port.calls.length, 1);
});
test('retained connections and provision callers resolve non-anonymous owner declarations and real handlers', async () => {
  for (const [path, verb] of [
    ['connections', 'GET'],
    ['service/provision', 'POST'],
  ]) {
    const declaration = manifest.contributions.find(
      (item: { type: string; path?: string; methods?: string[] }) =>
        item.type === 'webhook' && item.path === path && item.methods?.includes(verb!),
    );
    assert.ok(declaration, 'missing retained owner declaration: ' + path);
    assert.equal(declaration.verificationSecretRef, undefined);
    assert.equal(declaration.action.method, 'collective.control.http');
    assert.ok(
      manifest.features[0].contributions.some(
        (ref: { type: string; id: string }) => ref.type === 'webhook' && ref.id === declaration.id,
      ),
    );
  }
  const directory = await mkdtemp(join(tmpdir(), 'collective-owner-control-'));
  const active = await entrypoint.create(manifest).start(fixtureHost(directory));
  try {
    const invoke = ownerAction(active.actions['collective.control.http']!, 'fixture-owner');
    assert.equal(typeof invoke, 'function');
    const read = (await invoke(ownerRequest('GET', 'connections'))) as {
      status: number;
      body: {
        runtimeStatus: string;
        connections: unknown[];
        localService: { state: string; bootstrapNeeded: boolean; serviceUrl: string; setupStep: string };
      };
    };
    assert.equal(read.status, 200);
    assert.equal(read.body.runtimeStatus, 'active');
    assert.deepEqual(read.body.connections, []);
    assert.equal(read.body.localService.state, 'setup_required');
    assert.equal(read.body.localService.bootstrapNeeded, true);
    assert.equal(read.body.localService.setupStep, 'github_app');
    assert.match(read.body.localService.serviceUrl, /^http:\/\/127.0.0.1:\d+$/);
    const origin = read.body.localService.serviceUrl;
    assert.equal(JSON.stringify(read).includes('bootstrap='), false);
    const launch = (await invoke(ownerRequest('POST', 'service/provision'))) as {
      status: number;
      body: { launchUrl: string; service: typeof read.body.localService };
    };
    const secret = (await readFile(join(directory, 'service', 'owner-bootstrap.secret'), 'utf8')).trim();
    assert.equal(launch.status, 200);
    assert.equal(launch.body.service.state, 'setup_required');
    assert.equal(launch.body.launchUrl, origin + '#bootstrap=' + secret);
    const bootstrapped = await fetch(origin + '/api/bootstrap', {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ secret, displayName: 'Fixture owner' }),
    });
    assert.equal(bootstrapped.status, 201);
    const claimed = (await invoke(ownerRequest('POST', 'service/provision'))) as typeof launch;
    assert.equal(claimed.body.launchUrl, origin);
    assert.equal(claimed.body.service.bootstrapNeeded, false);
    assert.equal(claimed.body.service.state, 'setup_required', 'claiming bootstrap does not complete onboarding');
    await active.stop({ reason: 'test' });
    await assert.rejects(async () => invoke(ownerRequest('GET', 'connections')), /revoked|stopped/);
  } finally {
    await active.stop({ reason: 'test' });
    await rm(directory, { recursive: true, force: true });
  }
});

test('implemented owner method/path pairs and ordinary native methods are advertised', () => {
  const expected = [
    'POST connections/:connectionId/artifacts/share-media/context',
    'GET connections/:connectionId/artifacts/retained-media',
    'POST connections/:connectionId/artifacts/share-media',
    'GET connections/:connectionId/artifacts/:artifactId/media/:ownerRevision',
    'GET connections',
    'GET connections/:connectionId/inbox',
    'GET connections/:connectionId/route',
    'PUT connections/:connectionId/route',
    'POST connections/:connectionId/reconnect',
    'POST connections/:connectionId/revoke',
    'GET connections/:connectionId/listening',
    'POST connections/:connectionId/listening',
    'GET connections/:connectionId/work-policy',
    'POST connections/:connectionId/work-policy/adopt',
    'POST connections/:connectionId/work-policy/revoke',
    'POST service/provision',
    'GET entry-roster',
    'POST pair',
    'POST connections/:connectionId/participation/reconcile',
    'PUT connections/:connectionId/participation/policy',
    'GET connections/:connectionId/participation',
    'PUT connections/:connectionId/participation',
  ];
  const backend = manifest.features.find((item: { id: string }) => item.id === 'collective-backend');
  const owned = new Set(
    backend.contributions
      .filter((item: { type: string }) => item.type === 'webhook')
      .map((item: { id: string }) => item.id),
  );
  const webhooks = manifest.contributions.filter(
    (item: { type: string; id: string }) => item.type === 'webhook' && owned.has(item.id),
  );
  assert.deepEqual(
    webhooks
      .flatMap((item: { path: string; methods: string[] }) => item.methods.map((method) => method + ' ' + item.path))
      .sort(),
    expected.sort(),
  );
  for (const item of webhooks) {
    assert.equal(item.verificationSecretRef, undefined);
    assert.equal(
      item.action.method,
      item.id.startsWith('collective-media-') ? 'collective.media.http' : 'collective.control.http',
    );
  }
  assert.deepEqual(
    manifest.contributions
      .find((item: { type: string; id: string }) => item.type === 'mcp' && item.id === 'collective-native')
      .actions.map((item: { method: string }) => item.method)
      .sort(),
    [
      'collective.context.current',
      'collective.context.read',
      'collective.sticker.prepare',
      'collective.artifact.command',
      'collective.work.suggest-project',
      'collective.project.context',
      'collective.material.read',
      'collective.material.suggest',
      'collective.work.suggest-time',
      'collective.participation.set-interest',
      'collective.reply.submit',
      'collective.work.propose',
      'collective.work.accept',
      'collective.work.continue',
    ].sort(),
  );
});
function controlledPort() {
  const calls: unknown[] = [];
  let owner = 'fixture-owner';
  let stale = false;
  const route = () => ({
    localOwnerUserId: owner,
    channelListening: { channel: { mode: 'all' } },
    attentionRevision: 4,
  });
  const origin = 'http://127.0.0.1:5271';
  const projection = { authorityStatus: 'connected', recovery: { held: 1 }, lastError: 'Held local effect' };
  const invoke = createOwnerControlHttp({
    async admitOwnerOrigin(value) {
      const url = new URL(value);
      if (url.origin !== value || !['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid origin');
    },
    assertActive() {
      if (stale) throw new Error('owner expired');
    },
    status: () => ({
      state: 'ready',
      serviceUrl: origin,
      dataDirectory: '/fixture',
      serviceInstanceId: 'fixture-service',
      bootstrapNeeded: false,
    }),
    async launch() {
      calls.push('launch');
      return {
        service: {
          state: 'ready',
          serviceUrl: origin,
          dataDirectory: '/fixture',
          serviceInstanceId: 'fixture-service',
          bootstrapNeeded: false,
        },
        launchUrl: origin,
      };
    },
    connector: {
      async listConnections() {
        calls.push('list');
        return [];
      },
      async listInbox(id: string) {
        calls.push(['inbox', id]);
        return [];
      },
      async getHostRoute() {
        return route();
      },
      async setChannelListening(id: string, who: string, input: unknown) {
        calls.push(['listening', id, who, input]);
        return route();
      },
      async readWorkPolicyStatus(id: string) {
        calls.push(['policy', id]);
        return { revision: 5 };
      },
      async adoptWorkPolicy(id: string, who: string, revision: number) {
        calls.push(['adopt', id, who, revision]);
        return { revision };
      },
      async revokeWorkGrants(id: string, who: string, refs: string[]) {
        calls.push(['grants', id, who, refs]);
      },
      async sync(id: string) {
        calls.push(['sync', id]);
        return projection;
      },
      async revoke(id: string) {
        calls.push(['revoke', id]);
        return { ...projection, authorityStatus: 'revoking' };
      },
    } as never,
  });
  return {
    invoke: (input: any, native?: unknown, caller?: unknown) =>
      invoke(input, native, caller ?? ownerCaller('fixture-owner', input.request.method)),
    calls,
    foreign() {
      owner = 'another-owner';
    },
    expireOwner() {
      stale = true;
    },
  };
}
test('owner webhook rejects native/HTTP/Settings lanes and absent principal before entering business', async () => {
  const port = controlledPort();
  const req = ownerRequest('POST', 'service/provision');
  await assert.rejects(() => port.invoke(req, { catId: 'cat' }), /webhook/);
  await assert.rejects(() => port.invoke(req, undefined, { kind: 'http' }), /webhook/);
  await assert.rejects(() => port.invoke(req, undefined, { kind: 'owner-operation' }), /webhook/);
  await assert.rejects(() =>
    port.invoke({ request: { ...req.request, principal: undefined, body: { userId: 'fixture-owner' } } }),
  );
  await assert.rejects(
    () => port.invoke({ request: { ...req.request, headers: { origin: 'javascript:invalid' } } }),
    /origin/,
  );
  assert.deepEqual(port.calls, []);
  port.expireOwner();
  await assert.rejects(() => port.invoke(req), /expired/);
  assert.deepEqual(port.calls, []);
});
test('owner-scoped listening and work-policy controls preserve current owner, revision and original validation', async () => {
  const port = controlledPort();
  const listening = await port.invoke(ownerRequest('GET', 'connections/c1/listening'));
  assert.deepEqual(listening.body, { channelListening: { channel: { mode: 'all' } }, attentionRevision: 4 });
  const update = { mode: 'mentions', channelId: 'channel', expectedAttentionRevision: 4 };
  assert.equal((await port.invoke(ownerRequest('POST', 'connections/c1/listening', update))).status, 200);
  assert.deepEqual(port.calls.at(-1), ['listening', 'c1', 'fixture-owner', update]);
  assert.equal(
    (await port.invoke(ownerRequest('POST', 'connections/c1/listening', { ...update, expectedAttentionRevision: -1 })))
      .status,
    400,
  );
  const read = await port.invoke(ownerRequest('GET', 'connections/c1/work-policy'));
  assert.deepEqual(read.body, { revision: 5 });
  const adopted = await port.invoke(
    ownerRequest('POST', 'connections/c1/work-policy/adopt', { expectedPolicyRevision: 7 }),
  );
  assert.equal(adopted.status, 200);
  assert.deepEqual(port.calls.at(-1), ['adopt', 'c1', 'fixture-owner', 7]);
  const invalid = await port.invoke(
    ownerRequest('POST', 'connections/c1/work-policy/adopt', { expectedPolicyRevision: 0 }),
  );
  assert.equal(invalid.status, 400);
  const revoked = await port.invoke(
    ownerRequest('POST', 'connections/c1/work-policy/revoke', { grantRefs: ['grant-1'] }),
  );
  assert.deepEqual(revoked.body, { disposition: 'revocation_confirmed' });
  assert.deepEqual(port.calls.at(-1), ['grants', 'c1', 'fixture-owner', ['grant-1']]);
  const before = port.calls.length;
  port.foreign();
  for (const path of ['route', 'listening', 'work-policy', 'work-policy/adopt', 'work-policy/revoke']) {
    const result = await port.invoke(
      ownerRequest(path.includes('/') ? 'POST' : 'GET', 'connections/c1/' + path, { expectedPolicyRevision: 7 }),
    );
    assert.equal(result.status, 403);
  }
  assert.equal(port.calls.length, before, 'foreign route owner cannot enter any protected business operation');
});
test('reconnect and revoke retain visible unknown holds without retries or fabricated completion', async () => {
  const port = controlledPort();
  const reconnect = await port.invoke(ownerRequest('POST', 'connections/c1/reconnect'));
  assert.equal(reconnect.status, 409);
  assert.equal((reconnect.body as { code: string }).code, 'COLLECTIVE_RECOVERY_REQUIRED');
  const revoke = await port.invoke(ownerRequest('POST', 'connections/c1/revoke'));
  assert.equal(revoke.status, 409);
  assert.equal((revoke.body as { code: string }).code, 'COLLECTIVE_REVOCATION_UNCONFIRMED');
  assert.deepEqual(port.calls, [
    ['sync', 'c1'],
    ['revoke', 'c1'],
  ]);
  assert.equal((await port.invoke(ownerRequest('GET', 'connections/c1/reconnect'))).status, 405);
  assert.equal((await port.invoke(ownerRequest('GET', 'connections/c1/participation'))).status, 404);
});

test('unpublished reconsideration has no owner endpoint or installation declaration', async () => {
  const port = controlledPort();
  const controller = new AbortController();
  const owner = {
    kind: 'owner-http-request' as const,
    userId: 'fixture-owner',
    pluginInstanceId: 'instance',
    operation: 'write' as const,
    signal: controller.signal,
    async assertCurrent() {
      controller.signal.throwIfAborted();
    },
  };
  const result = await port.invoke(
    ownerRequest('POST', 'connections/connection/work/reconsider', {}),
    undefined,
    owner,
  );
  assert.equal(result.status, 404);
  assert.deepEqual(port.calls, []);
  assert.equal(
    manifest.contributions.some(
      (item: { type: string; path?: string }) =>
        item.type === 'webhook' && item.path === 'connections/:connectionId/work/reconsider',
    ),
    false,
  );
});
