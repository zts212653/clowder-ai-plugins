import assert from 'node:assert/strict';
import test from 'node:test';
import { definePlugin, FeaturePermissionError, FeatureContextRevokedError, type PluginActionHandler } from './feature-context.js';
import { definePluginModule } from './module-plugin.js';
import { type PluginOwnerOperationContext } from './host-action-context.js';
import type { ModulePluginHostShape } from './module-host.js';

const manifest = {
  pluginId: 'test.context-lanes', name: 'Context lanes', version: '1.0.0', contractVersion: '0.1.0',
  runtime: { transport: 'builtin', entrypoint: 'dist/index.js' },
  configuration: [{ key: 'recovery', label: 'Recovery', kind: 'operation', required: false, actions: [
    { id: 'resume', label: 'Resume', render: 'button', action: { method: 'test.resume' } },
    { id: 'outbound', label: 'Outbound', render: 'button', action: { method: 'test.outbound' } },
  ] }],
  features: [{ id: 'main', name: 'Main', resources: [], capabilities: [], contributions: [
    { type: 'message-subscription', id: 'outbound' },
  ] }],
  contributions: [
    { type: 'message-subscription', id: 'outbound', binding: 'fixture', action: { method: 'test.outbound' }, presentation: 'v1' },
  ],
};
function fixtureHost(): ModulePluginHostShape {
  return { pluginInstanceId: 'installed-browser-fixture', config: { async get() {} }, secrets: { async get() { return undefined; } }, storage: {} as never, tasks: {} as never,
    threads: {} as never, messaging: {} as never, streams: {} as never, dataPath: '/isolated/browser-fixture', log() {} };
}
const owner = (): PluginOwnerOperationContext => ({ kind: 'owner-operation', userId: 'owner', pluginInstanceId: 'instance',
  operationKey: 'recovery', actionId: 'resume', requestId: 'request', signal: new AbortController().signal, async assertCurrent() {} });
async function fixture() {
  const seen: unknown[] = [];
  const module = definePluginModule(() => definePlugin({ manifest, activate: { main: async context => {
    return { actions: Object.fromEntries(['test.resume', 'test.outbound'].map(method => [method,
      (async (_input, native, caller) => { seen.push({ method, native, caller }); return 'accepted'; }) satisfies PluginActionHandler])) };
  } } }));
  const active = await module.create(manifest).start(fixtureHost());
  return { active, seen };
}
test('owner operations preserve their authenticated third context and reject native/mismatched calls', async () => {
  const f = await fixture(); const operation=owner();
  try {
    await assert.rejects(async()=>f.active.actions['test.resume']!({},{} as never,operation),FeaturePermissionError);
    await assert.rejects(async()=>f.active.actions['test.resume']!({},undefined,{...operation,actionId:'outbound'}),FeaturePermissionError);
    await assert.rejects(async()=>f.active.actions['test.resume']!({},undefined,{...operation,kind:'ambient-owner'} as never),FeaturePermissionError);
    assert.equal(f.seen.length,0);
    await f.active.actions['test.resume']!({},undefined,operation);
    assert.deepEqual(f.seen,[{method:'test.resume',native:undefined,caller:operation}]);
  } finally {await f.active.stop({reason:'test'});}
});
test('handlers are revoked by stop; stale and aborted calls never enter', async () => {
  const f = await fixture(); const stale = { ...owner(), async assertCurrent() { throw new Error('grant expired'); } };
  await assert.rejects(async () => f.active.actions['test.resume']!({}, undefined, stale), /grant expired/);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(async () => f.active.actions['test.resume']!({}, undefined, { ...owner(), signal: aborted.signal }), /abort/i);
  await f.active.stop({reason:'test'});
  await assert.rejects(async () => f.active.actions['test.resume']!({}, undefined, owner()), FeatureContextRevokedError);
  assert.equal(f.seen.length, 0);
});
test('presentation wrapper still validates input before forwarding the owner third argument', async () => {
  const f = await fixture(); const caller = { ...owner(), actionId: 'outbound' };
  try {
    await assert.rejects(async () => f.active.actions['test.outbound']!({}, undefined, caller), /presentation/i);
    assert.equal(f.seen.length, 0);
    await f.active.actions['test.outbound']!({ deliveryId: 'delivery-1', threadId: 'thread-1', envelope: { messageId: 'message-1' },
      presentation: { actor: { displayName: 'Fixture', emoji: '🐱' }, thread: { shortId: 'abc123' } } }, undefined, caller);
    assert.deepEqual(f.seen, [{ method: 'test.outbound', native: undefined, caller }]);
  } finally { await f.active.stop({reason:'test'}); }
});
