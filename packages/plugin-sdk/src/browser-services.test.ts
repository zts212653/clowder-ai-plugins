import assert from 'node:assert/strict';
import test from 'node:test';
import { definePlugin, FeaturePermissionError, FeatureContextRevokedError, type PluginActionHandler } from './feature-context.js';
import { definePluginModule } from './module-plugin.js';
import { BROWSER_SERVICE_LIMITS, type BrowserServiceDispatchContext, type PluginOwnerOperationContext } from './browser-services.js';
import type { ModulePluginHostShape } from './module-host.js';

const manifest = {
  pluginId: 'test.context-lanes', name: 'Context lanes', version: '1.0.0', contractVersion: '0.1.0',
  runtime: { transport: 'builtin', entrypoint: 'dist/index.js' },
  configuration: [{ key: 'recovery', label: 'Recovery', kind: 'operation', required: false, actions: [
    { id: 'resume', label: 'Resume', render: 'button', action: { method: 'test.resume' } },
    { id: 'outbound', label: 'Outbound', render: 'button', action: { method: 'test.outbound' } },
  ] }],
  features: [{ id: 'main', name: 'Main', resources: [], capabilities: [], contributions: [
    { type: 'browser-service', id: 'api' }, { type: 'message-subscription', id: 'outbound' },
  ] }],
  contributions: [
    { type: 'browser-service', id: 'api', action: { method: 'test.http' },
      routes: [{ method: 'GET', path: '/api/health', browser: 'service', local: 'omit-origin' }], credentials: { bearer: false, cookies: [] } },
    { type: 'message-subscription', id: 'outbound', binding: 'fixture', action: { method: 'test.outbound' }, presentation: 'v1' },
  ],
};
function fixtureHost(): ModulePluginHostShape {
  return { pluginInstanceId: 'installed-browser-fixture', config: { async get() {} }, secrets: { async get() { return undefined; } }, storage: {} as never, tasks: {} as never,
    threads: {} as never, messaging: {} as never, media: {} as never, log() {}, browserServices: {
      async getBinding(id) { return { contributionId: id, origin: 'http://127.0.0.1:5271', parentOrigin: 'http://localhost:5172',
        clientBuildId: 'fixture', assetDigest: 'a'.repeat(64), limits: BROWSER_SERVICE_LIMITS, async assertCurrent() {} }; },
      async dispatchLocal() { return { kind: 'response', response: { status: 200, headers: [], bodyBase64: '' } }; },
    } };
}
const owner = (): PluginOwnerOperationContext => ({ kind: 'owner-operation', userId: 'owner', pluginInstanceId: 'instance',
  operationKey: 'recovery', actionId: 'resume', requestId: 'request', signal: new AbortController().signal, async assertCurrent() {} });
const http = (): BrowserServiceDispatchContext => ({ kind: 'http', lane: 'local', contributionId: 'api', requestId: 'request',
  signal: new AbortController().signal, async assertCurrent() {} });
async function fixture() {
  const seen: unknown[] = []; let savedBinding: Awaited<ReturnType<NonNullable<ModulePluginHostShape['browserServices']>['getBinding']>>;
  let savedPort: NonNullable<ModulePluginHostShape['browserServices']>;
  const module = definePluginModule(() => definePlugin({ manifest, activate: { main: async context => {
    savedPort = context.browserServices!; savedBinding = await savedPort.getBinding('api');
    return { actions: Object.fromEntries(['test.http', 'test.resume', 'test.outbound'].map(method => [method,
      (async (_input, native, caller) => { seen.push({ method, native, caller }); return 'accepted'; }) satisfies PluginActionHandler])) };
  } } }));
  const active = await module.create(manifest).start(fixtureHost());
  return { active, seen, binding: savedBinding!, port: savedPort! };
}
test('private HTTP and owner operations preserve distinct third contexts and reject ordinary/native mismatches', async () => {
  const f = await fixture(); const caller = http(); const operation = owner();
  try {
    await assert.rejects(async () => f.active.actions['test.http']!({}), FeaturePermissionError);
    await assert.rejects(async () => f.active.actions['test.http']!({}, undefined, operation), FeaturePermissionError);
    await assert.rejects(async () => f.active.actions['test.http']!({}, {} as never, caller), FeaturePermissionError);
    await assert.rejects(async () => f.active.actions['test.http']!({}, undefined, { ...caller, contributionId: 'other' }), FeaturePermissionError);
    await assert.rejects(async () => f.active.actions['test.resume']!({}, undefined, caller), FeaturePermissionError);
    await assert.rejects(async () => f.active.actions['test.resume']!({}, undefined, { ...operation, actionId: 'outbound' }), FeaturePermissionError);
    await assert.rejects(async () => f.active.actions['test.resume']!({}, undefined, { ...operation, kind: 'ambient-owner' } as never), FeaturePermissionError);
    await assert.rejects(async () => f.active.actions['test.http']!({}, undefined, { ...caller, lane: 'native' } as never), FeaturePermissionError);
    assert.equal(f.seen.length, 0);
    await f.active.actions['test.http']!({}, undefined, caller);
    await f.active.actions['test.resume']!({}, undefined, operation);
    assert.deepEqual(f.seen, [{ method: 'test.http', native: undefined, caller }, { method: 'test.resume', native: undefined, caller: operation }]);
  } finally { await f.active.stop(); }
});
test('saved binding, port and handlers are revoked by stop; stale and aborted calls never enter', async () => {
  const f = await fixture(); const stale = { ...owner(), async assertCurrent() { throw new Error('grant expired'); } };
  await assert.rejects(async () => f.active.actions['test.resume']!({}, undefined, stale), /grant expired/);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(async () => f.active.actions['test.resume']!({}, undefined, { ...owner(), signal: aborted.signal }), /abort/i);
  await assert.rejects(() => f.port.getBinding('other'), FeaturePermissionError);
  await f.active.stop();
  await assert.rejects(() => f.binding.assertCurrent(), FeatureContextRevokedError);
  await assert.rejects(() => f.port.getBinding('api'), FeatureContextRevokedError);
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
  } finally { await f.active.stop(); }
});
