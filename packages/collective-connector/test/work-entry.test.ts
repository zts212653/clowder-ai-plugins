import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { BROWSER_SERVICE_LIMITS, type ModulePluginHostShape } from '@clowder-ai/plugin-sdk';
import entrypoint from '../src/plugin-entrypoint.js';
const manifest = parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8'));

test('production Work module owns one private MCP and rejects untrusted calls before private effects', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'collective-work-entry-'));
  let effects = 0;
  const unexpected = async () => { effects++; throw new Error('Private effect before authenticated Work'); };
  const host: ModulePluginHostShape = {
    pluginInstanceId: 'installed-instance',
    dataDirectory: directory, config: {get: async () => undefined}, secrets: {get: async () => undefined},
    storage: {get: unexpected, compareAndSet: unexpected} as never,
    tasks: {get: unexpected, listByKind: async () => [], prepareEntrusted: unexpected, dispatchEntrusted: unexpected} as never,
    messaging: {get: unexpected, send: unexpected} as never, threads: {} as never, media: {} as never, log() {},
    nativeContext: {current: unexpected},
    participantRoster: {listForNativeContribution: async () => []},
    ownerThreads: {get: unexpected, create: unexpected, addParticipants: unexpected},
    browserServices: {getBinding: async id => ({contributionId: id, origin: 'http://127.0.0.1:5271',
      parentOrigin: 'http://localhost:5172', clientBuildId: 'collective-client-v2', assetDigest: 'a'.repeat(64),
      limits: BROWSER_SERVICE_LIMITS, assertCurrent: async () => {}}), dispatchLocal: unexpected},
  };
  const active = await entrypoint.create(manifest).start(host);
  try {
    const work = manifest.features.find((feature: {id: string}) => feature.id === 'collective-work');
    assert.ok(work, 'Work must enter through an owned production feature');
    const taskMcp = manifest.contributions.filter((contribution: {type: string; id: string}) =>
      contribution.type === 'mcp' && manifest.features.some((feature: {capabilities: string[]; contributions: {type: string; id: string}[]}) =>
        feature.capabilities.includes('task.admitEntrusted') && feature.contributions.some(ref => ref.type === 'mcp' && ref.id === contribution.id)));
    assert.equal(taskMcp.length, 1);
    assert.equal(taskMcp[0].id, 'collective-work-native');
    assert.deepEqual(taskMcp[0].actions.map((action: {method: string}) => action.method).sort(),
      ['collective.work.context.current', 'collective.work.context.read', 'collective.work.progress',
        'collective.work.artifact.read', 'collective.work.artifact.register', 'collective.work.reply.submit'].sort());
    assert.equal(manifest.features.find((feature: {id: string}) => feature.id === 'collective-backend').capabilities.includes('task.admitEntrusted'), false);
    for (const method of taskMcp[0].actions.map((action: {method: string}) => action.method)) {
      assert.equal(typeof active.actions[method], 'function');
      await assert.rejects(() => Promise.resolve(active.actions[method]!({})));
    }
    assert.equal(typeof active.actions['collective.work.control.http'], 'function');
    await assert.rejects(() => Promise.resolve(active.actions['collective.work.control.http']!({request: {
      method: 'POST', path: 'connections/c1/work/admit', principal: {kind: 'owner', id: 'forged-owner'},
      body: {sourceMessageId: 'source', requestId: 'e2ecbb52-969e-4b98-a24d-eb54c55b01ef'}, headers: {}}})));
    const method = 'collective.work.context.current';
    const native = { toolExecutionPolicy: { mode: 'plugin_native', contributionId: 'collective-work-native',
      actionMethods: [method] }, assertCurrent: async () => {} } as never;
    await assert.rejects(() => Promise.resolve(active.actions[method]!({taskId: 'body-forged-task'}, native)));
    await assert.rejects(() => Promise.resolve(active.actions[method]!({}, {
      toolExecutionPolicy: {mode: 'plugin_native', contributionId: 'collective-native', actionMethods: [method]},
    } as never)));
    const expired = {kind: 'owner-operation' as const, userId: 'owner', pluginInstanceId: 'instance',
      requestId: 'expired-owner-operation', operationKey: 'work', actionId: 'list',
      signal: new AbortController().signal, assertCurrent: async () => {throw new Error('Owner operation ended');}};
    await assert.rejects(() => Promise.resolve(active.actions['collective.work.owner.connections']!({input: {}}, undefined, expired)), /ended/);
    await assert.rejects(() => Promise.resolve(active.actions['collective.work.owner.sync']!({input: {connectionId: 'c1'}}, undefined, {...expired, actionId: 'sync'})), /ended/);
    assert.equal(effects, 0);
    await active.stop();
    await assert.rejects(() => Promise.resolve(active.actions['collective.work.context.current']!({})));
    assert.equal(effects, 0);
  } finally {await active.stop();await rm(directory, {recursive: true, force: true});}
});
