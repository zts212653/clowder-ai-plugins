import assert from 'node:assert/strict';
import test from 'node:test';
import { createConnectorPermissionActions } from './connector-permission-actions.js';
import type { PluginStorageHost } from './module-host.js';
import { createConnectorPermissionStore } from './connector-permissions.js';

// Published Host canonical vector. Raw JSON strings are deliberately not reparsed for hashing.
const input = { protocolVersion: 1,
  sourceDigest: '449c5887711ea90c6c14ff8f26adfeefc2d7f129f2bac9db59259c2915b5cad3',
  snapshot: { config: { whitelistEnabled: 'true', commandAdminOnly: 'false', adminOpenIds: '[]' },
    groups: { chat: '{"label":"Group","addedAt":12}' } } };
function host(): PluginStorageHost {
  const entries = new Map<string, { revision: number; value: unknown }>();
  let revision = 0;
  return {
    async get(key) { return entries.get(key); },
    async list() { return Object.fromEntries(entries); },
    async set(key, value) { const entry = { revision: ++revision, value }; entries.set(key, entry); return entry; },
    async compareAndSet(key, expected, value) {
      if ((entries.get(key)?.revision ?? null) !== expected) return { applied: false };
      const entry = { revision: ++revision, value }; entries.set(key, entry); return { applied: true, revision: entry.revision };
    },
    async delete(key) { return { deleted: entries.delete(key) }; },
  };
}
test('generic operation wrapper extracts only the raw envelope from stored configuration plus input', async () => {
  const storage = host();
  const actions = createConnectorPermissionActions(storage);
  const first = await actions['permissions.importLegacy']({ input: { appSecret: 'never-copy', ...input } });
  assert.equal(first.data.status, 'imported');
  assert.equal(first.data.sourceDigest, input.sourceDigest);
  assert.equal(JSON.stringify(first).includes('never-copy'), false);
  assert.equal(JSON.stringify(await storage.list()).includes('never-copy'), false);
  assert.equal((await actions['permissions.importLegacy']({ input })).data.status, 'already_applied');
});
test('operation wrapper rejects bare or malformed envelopes without initializing state', async () => {
  const storage = host(); const actions = createConnectorPermissionActions(storage);
  for (const params of [input, null, { input: [] }, { input: { ...input, sourceDigest: '0'.repeat(64) } }]) {
    await assert.rejects(actions['permissions.importLegacy'](params));
  }
  assert.deepEqual(await storage.list(), {});
});

test('owner read is side-effect free; only confirmed configure carrier initializes explicit policy', async () => {
  const storage = host(); const actions = createConnectorPermissionActions(storage);
  const initial = await actions['permissions.read']({});
  assert.equal(initial.data.status, 'uninitialized');
  assert.deepEqual(await storage.list(), {});
  assert.equal(initial.targetValues.permissionRevision, 'new');
  const result = await actions['permissions.configure']({ input: initial.targetValues });
  assert.equal(result.data.status, 'configured');
  const state = await createConnectorPermissionStore(storage).get();
  assert.equal(state.adminConfigured, true);
  assert.deepEqual(state.adminOpenIds, []);
  assert.equal(state.whitelistEnabled, false);
});
test('owner editing preserves imported groups/timestamps and clears explicit admins without reseeding', async () => {
  const storage = host(); const actions = createConnectorPermissionActions(storage);
  await actions['permissions.importLegacy']({ input });
  const current = await actions['permissions.read']({});
  assert.equal(current.targetValues.permissionAdminIdsJson, '[]');
  assert.equal(JSON.stringify(current.targetValues).includes('addedAt'), false);
  const edited = await actions['permissions.configure']({ input: { ...current.targetValues,
    permissionCommandAdminOnly: 'true', permissionAdminIdsJson: '[]', appSecret: 'do-not-copy', owner: true } });
  assert.equal(edited.data.status, 'configured');
  const value = await createConnectorPermissionStore(storage).get();
  assert.deepEqual(value.allowedGroups, [{ externalChatId: 'chat', label: 'Group', addedAt: 12 }]);
  assert.deepEqual(value.adminOpenIds, []);
  assert.equal(value.commandAdminOnly, true);
  assert.equal(JSON.stringify(value).includes('do-not-copy'), false);
  assert.equal((await actions['permissions.importLegacy']({ input })).data.status, 'preserved_existing');
});
test('stale owner forms cannot overwrite a concurrent group mutation or new policy', async () => {
  const storage = host(); const actions = createConnectorPermissionActions(storage);
  const initial = await actions['permissions.read']({});
  await actions['permissions.configure']({ input: initial.targetValues });
  await assert.rejects(actions['permissions.configure']({ input: initial.targetValues }), /changed.*reload/i);
  const current = await actions['permissions.read']({});
  await storage.set('connector.permissions.v1', { ...(await createConnectorPermissionStore(storage).get()),
    allowedGroups: [{ externalChatId: 'new-group', addedAt: 5 }] });
  await assert.rejects(actions['permissions.configure']({ input: current.targetValues }), /changed.*reload/i);
  assert.equal((await createConnectorPermissionStore(storage).get()).allowedGroups.length, 1);
});
test('malformed, partial and oversized owner forms fail before permission state creation', async () => {
  const valid = { permissionRevision: 'new', permissionWhitelistEnabled: 'false', permissionCommandAdminOnly: 'false',
    permissionAdminIdsJson: '[]', permissionGroupsJson: '[]' };
  for (const input of [{}, { ...valid, permissionRevision: '0' }, { ...valid, permissionWhitelistEnabled: true },
    { ...valid, permissionAdminIdsJson: '["a","a"]' }, { ...valid, permissionGroupsJson: '[{"externalChatId":"a","owner":true}]' },
    { ...valid, permissionGroupsJson: '[{"externalChatId":"a"},{"externalChatId":"a"}]' },
    { ...valid, permissionAdminIdsJson: ' '.repeat(256 * 1024) }]) {
    const storage = host(); const actions = createConnectorPermissionActions(storage);
    await assert.rejects(actions['permissions.configure']({ input }));
    assert.deepEqual(await storage.list(), {});
  }
});

test('configure refuses a CAS race instead of retrying over a newer owner policy', async () => {
  const storage = host(); const actions = createConnectorPermissionActions(storage);
  const form = await actions['permissions.read']({});
  const realCas = storage.compareAndSet.bind(storage);
  storage.compareAndSet = async (key, expected, value) => {
    await storage.set(key, { v: 1, whitelistEnabled: true, commandAdminOnly: true,
      adminConfigured: true, adminOpenIds: [], allowedGroups: [] });
    return realCas(key, expected, value);
  };
  await assert.rejects(actions['permissions.configure']({ input: form.targetValues }), /changed.*reload/i);
  assert.equal((await createConnectorPermissionStore(storage).get()).whitelistEnabled, true);
  assert.equal((await createConnectorPermissionStore(storage).get()).commandAdminOnly, true);
});
test('owner read and configure reject corrupt stored policy without restoring defaults', async () => {
  const storage = host(); const actions = createConnectorPermissionActions(storage);
  const initial = await actions['permissions.read']({});
  await storage.set('connector.permissions.v1', { v: 1 });
  await assert.rejects(actions['permissions.read']({}));
  await assert.rejects(actions['permissions.configure']({ input: initial.targetValues }));
  assert.deepEqual((await storage.get('connector.permissions.v1'))!.value, { v: 1 });
});

test('oversized state has explicit bounded owner recovery, never silent truncation or reset', async () => {
  const storage = host(); const actions = createConnectorPermissionActions(storage);
  const oversized = { v: 1, whitelistEnabled: true, commandAdminOnly: true,
    adminConfigured: true, adminOpenIds: ['admin'],
    allowedGroups: Array.from({ length: 5001 }, (_, i) => ({ externalChatId: `g${i}`, label: `Group ${i}`, addedAt: i })) };
  await storage.set('connector.permissions.v1', oversized);
  const before = await storage.list();
  const read = await actions['permissions.read']({});
  assert.equal(read.data.status, 'recovery_required');
  assert.equal(read.data.groupCount, 5001);
  assert.equal(read.targetValues.permissionGroupsJson, ''); // Invalid until explicitly supplied by owner.
  assert.equal(read.targetValues.permissionAdminIdsJson, '["admin"]');
  assert.ok(Buffer.byteLength(JSON.stringify(read)) < 4096);
  assert.deepEqual(await storage.list(), before);
  await assert.rejects(actions['permissions.configure']({ input: read.targetValues }));
  await assert.rejects(actions['permissions.configure']({ input: { ...read.targetValues,
    permissionGroupsJson: JSON.stringify(oversized.allowedGroups.map(({ externalChatId }) => ({ externalChatId }))) } }));
  assert.deepEqual(await storage.list(), before);
  const recovered = await actions['permissions.configure']({ input: { ...read.targetValues,
    permissionGroupsJson: '[{"externalChatId":"g4999","label":"Kept"}]' } });
  assert.equal(recovered.data.status, 'configured');
  const state = await createConnectorPermissionStore(storage).get();
  assert.equal(state.whitelistEnabled, true); assert.equal(state.commandAdminOnly, true);
  assert.deepEqual(state.adminOpenIds, ['admin']);
  assert.deepEqual(state.allowedGroups, [{ externalChatId: 'g4999', label: 'Kept', addedAt: 4999 }]);
  await assert.rejects(actions['permissions.configure']({ input: { ...read.targetValues, permissionGroupsJson: '[]' } }), /changed.*reload/);
  assert.deepEqual((await createConnectorPermissionStore(storage).get()).allowedGroups, state.allowedGroups);
});

test('oversized owner recovery still refuses malformed state and concurrent replacement', async () => {
  const storage = host(); const actions = createConnectorPermissionActions(storage);
  const oversized = { v: 1, whitelistEnabled: true, commandAdminOnly: true, adminConfigured: true, adminOpenIds: [],
    allowedGroups: Array.from({ length: 5001 }, (_, i) => ({ externalChatId: `g${i}`, addedAt: i })) };
  await storage.set('connector.permissions.v1', oversized);
  const read = await actions['permissions.read']({});
  const realCas = storage.compareAndSet.bind(storage);
  storage.compareAndSet = async (key, expected, value) => {
    await storage.set(key, { ...oversized, allowedGroups: [{ externalChatId: 'owner-new', addedAt: 3 }] });
    return realCas(key, expected, value);
  };
  await assert.rejects(actions['permissions.configure']({ input: { ...read.targetValues,
    permissionGroupsJson: '[]' } }), /changed.*reload/);
  assert.equal((await createConnectorPermissionStore(storage).get()).allowedGroups[0]?.externalChatId, 'owner-new');
  await storage.set('connector.permissions.v1', { ...oversized, adminOpenIds: [12] });
  const before = await storage.list();
  await assert.rejects(actions['permissions.read']({}));
  await assert.rejects(actions['permissions.configure']({ input: { ...read.targetValues,
    permissionRevision: String((await storage.get('connector.permissions.v1'))!.revision), permissionGroupsJson: '[]' } }));
  assert.deepEqual(await storage.list(), before);
});
