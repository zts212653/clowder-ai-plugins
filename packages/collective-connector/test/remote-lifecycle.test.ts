import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ModulePluginHostShape, PluginModuleActivationShape } from '@clowder-ai/plugin-sdk';
import { parse } from 'yaml';
import entrypoint from '../src/plugin-entrypoint.js';
import { memoryStorage, ownerCaller, serviceHostConfig } from './runtime-fixture.js';
import { CollectiveServiceStore } from '../src/business/service/store.js';
import { startCollectiveServer } from '../src/business/service/http-server.js';

const manifest = parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8'));
function host(directory: string, config: ModulePluginHostShape['config']): ModulePluginHostShape {
  return {
    pluginInstanceId: 'installed-instance',
    dataPath: directory,
    config,
    secrets: { get: async () => undefined },
    storage: memoryStorage(),
    tasks: { list: async () => [] } as never,
    threads: {} as never,
    streams: { read: async function* () {} },
    messaging: { get: async () => null, subscribe: async () => {}, unsubscribe: async () => {} } as never,
    members: { get: async () => null, list: async () => [] },
    log() {},
  };
}
async function control(active: PluginModuleActivationShape, path: string, method = 'GET') {
  return (await active.actions['collective.control.http']!(
    {
      request: {
        method,
        path,
        query: {},
        headers: { origin: 'http://localhost:5182' },
        principal: { kind: 'owner', id: 'owner' },
      },
    },
    undefined,
    ownerCaller('owner', method),
  )) as {
    status: number;
    body: {
      localService?: { serviceInstanceId: string };
      remoteService?: { state: string; serviceUrl: string; serviceInstanceId?: string };
      code?: string;
    };
  };
}

test('remote activation needs no local port or Service directory and never provisions on an outage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'collective-remote-module-'));
  let active: PluginModuleActivationShape | undefined;
  try {
    const remoteUrl = 'http://127.0.0.1:1';
    active = await entrypoint
      .create(manifest)
      .start(
        host(directory, {
          get: async (key) => ({ serviceMode: 'remote', remoteServiceUrl: remoteUrl, servicePort: '3001' })[key],
        }),
      );
    const status = await control(active, 'connections');
    assert.equal(status.status, 200);
    assert.equal(status.body.localService, undefined);
    assert.deepEqual(status.body.remoteService, { state: 'offline', serviceUrl: remoteUrl });
    const refused = await control(active, 'service/provision', 'POST');
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'COLLECTIVE_REMOTE_MODE');
    await assert.rejects(readFile(join(directory, 'service', 'collective-service.json')), { code: 'ENOENT' });
    await active.stop({ reason: 'owner_disabled' });
    active = undefined;
  } finally {
    await active?.stop({ reason: 'test' });
    await rm(directory, { recursive: true, force: true });
  }
});

test('switching to remote and back keeps the old embedded instance and remote status survives restarts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'collective-mode-switch-'));
  const remoteData = await mkdtemp(join(tmpdir(), 'collective-remote-service-'));
  const remote = await CollectiveServiceStore.open({ dataDirectory: remoteData });
  let server = await startCollectiveServer({ store: remote.store, port: 0 });
  const port = server.port;
  let active: PluginModuleActivationShape | undefined;
  let mode = 'embedded';
  const local = serviceHostConfig();
  const source = host(directory, {
    async get(key) {
      return key === 'serviceMode' ? mode : key === 'remoteServiceUrl' ? server.url : local.get(key);
    },
  });
  try {
    const module = entrypoint.create(manifest);
    active = await module.start(source);
    const oldId = (await control(active, 'connections')).body.localService?.serviceInstanceId;
    assert.ok(oldId);
    await active.stop({ reason: 'owner_disabled' });
    active = undefined;
    mode = 'remote';
    active = await module.start(source);
    let result = await control(active, 'connections');
    assert.equal(result.body.localService, undefined);
    assert.equal(result.body.remoteService?.state, 'setup_required');
    assert.equal(result.body.remoteService?.serviceInstanceId, remote.store.serviceInstanceId);
    await server.close();
    assert.equal((await control(active, 'connections')).body.remoteService?.state, 'offline');
    server = await startCollectiveServer({
      store: (await CollectiveServiceStore.open({ dataDirectory: remoteData })).store,
      port,
    });
    result = await control(active, 'connections');
    assert.equal(result.body.remoteService?.serviceInstanceId, remote.store.serviceInstanceId);
    await active.stop({ reason: 'owner_disabled' });
    active = undefined;
    mode = 'embedded';
    active = await module.start(source);
    assert.equal((await control(active, 'connections')).body.localService?.serviceInstanceId, oldId);
  } finally {
    await active?.stop({ reason: 'test' });
    await server.close();
    await rm(directory, { recursive: true, force: true });
    await rm(remoteData, { recursive: true, force: true });
  }
});
