import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createConnectorPermissionStore,
  decodeLegacyConnectorPermissions,
  evaluateConnectorPermission,
  parseConnectorCommand,
} from './connector-permissions.js';
import type { PluginStorageHost } from './module-host.js';
import { createHash } from 'node:crypto';
import { canonicalJson } from './feature-context.js';

function storage(): PluginStorageHost {
  const entries = new Map<string, { revision: number; value: unknown }>();
  let revision = 0;
  return {
    async get(key) { return entries.get(key); },
    async list() { return Object.fromEntries(entries); },
    async set(key, value) { const item = { revision: ++revision, value }; entries.set(key, item); return item; },
    async compareAndSet(key, expected, value) {
      if ((entries.get(key)?.revision ?? null) !== expected) return { applied: false };
      const item = { revision: ++revision, value }; entries.set(key, item);
      return { applied: true, revision: item.revision };
    },
    async delete(key) { return { deleted: entries.delete(key) }; },
  };
}
const legacy = {
  config: { whitelistEnabled: 'true', commandAdminOnly: 'true', adminOpenIds: '["admin"]' },
  groups: { group: '{"label":"Kept","addedAt":123}' },
};

function envelope(snapshot: unknown = legacy) {
  return { protocolVersion: 1, sourceDigest: createHash('sha256').update(canonicalJson(snapshot)).digest('hex'), snapshot };
}

function policyWithGroups(count: number) {
  return { ...decodeLegacyConnectorPermissions(legacy),
    allowedGroups: Array.from({ length: count }, (_, i) => ({ externalChatId: `g${i}`, label: `Group ${i}`, addedAt: i })) };
}

test('shared durable group bound refuses group 5001 but permits replacement at capacity', async () => {
  const host = storage(); const store = createConnectorPermissionStore(host);
  await store.initialize(policyWithGroups(5000));
  const before = await host.list();
  await assert.rejects(store.allowGroup('g5000', 'overflow', 5000), /group bound/);
  assert.deepEqual(await host.list(), before);
  await store.allowGroup('g4999', 'Replacement', 6000);
  assert.equal((await store.get()).allowedGroups.length, 5000);
  assert.deepEqual((await store.get()).allowedGroups.at(-1), { externalChatId: 'g4999', label: 'Replacement', addedAt: 6000 });
});

test('concurrent last-slot admissions persist exactly one distinct group', async () => {
  const host = storage(); const store = createConnectorPermissionStore(host);
  await store.initialize(policyWithGroups(4999));
  const results = await Promise.allSettled([store.allowGroup('a'), store.allowGroup('b')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((await store.get()).allowedGroups.length, 5000);
});

test('oversized stored state fails closed on runtime, import and initialization without mutation', async () => {
  const host = storage(); const store = createConnectorPermissionStore(host);
  const oversized = policyWithGroups(5001);
  await host.set('connector.permissions.v1', oversized);
  const before = await host.list();
  await assert.rejects(store.get(), /group bound/);
  await assert.rejects(store.allowGroup('g0'), /group bound/);
  await assert.rejects(store.denyGroup('g5000'), /group bound/);
  await assert.rejects(store.importLegacy(envelope()), /group bound/);
  await assert.rejects(store.initialize(policyWithGroups(0)), /group bound/);
  assert.throws(() => evaluateConnectorPermission(oversized, { chatId: 'direct', group: false, text: 'hello' }), /group bound/);
  assert.deepEqual(await host.list(), before);
  const empty = storage();
  await assert.rejects(createConnectorPermissionStore(empty).initialize(oversized), /group bound/);
  assert.deepEqual(await empty.list(), {});
});

test('frozen raw snapshot UTF-8 digest vector matches owner cutover bytes', async () => {
  const snapshot = { config: { whitelistEnabled: 'false', commandAdminOnly: 'true', adminOpenIds: '[]' },
    groups: { '群': '{"label":"测试","addedAt":3}', 'chat-2': '{"label":"B","addedAt":2}', 'chat-10': '{"label":"A","addedAt":1}' } };
  const bytes = canonicalJson(snapshot);
  assert.equal(Buffer.byteLength(bytes, 'utf8'), 228);
  assert.equal(createHash('sha256').update(bytes, 'utf8').digest('hex'), 'bc388bb1b9bbd528cb3cf12623e07e7929125cce0e24400edee3eb3e464a5339');
  const store = createConnectorPermissionStore(storage());
  assert.equal((await store.importLegacy({ protocolVersion: 1,
    sourceDigest: 'bc388bb1b9bbd528cb3cf12623e07e7929125cce0e24400edee3eb3e464a5339', snapshot })).data.status, 'imported');
  assert.deepEqual((await store.get()).adminOpenIds, []);
  assert.equal((await store.get()).allowedGroups.find(g => g.externalChatId === '群')?.label, '测试');
});

test('legacy import action returns bounded receipts and never exposes provider identities', async () => {
  const store = createConnectorPermissionStore(storage());
  const input = envelope();
  const first = await store.importLegacy(input);
  assert.equal(first.render, 'status');
  assert.deepEqual(first.data, { status: 'imported', protocolVersion: 1, sourceDigest: input.sourceDigest,
    stateRevision: 1, settingsFieldCount: 3, groupCount: 1 });
  assert.equal(JSON.stringify(first).includes('adminOpenIds'), false);
  assert.equal((await store.importLegacy(input)).data.status, 'already_applied');
  await store.denyGroup('group');
  assert.equal((await store.importLegacy(input)).data.status, 'preserved_existing');
  assert.deepEqual((await store.get()).allowedGroups, []);
});
test('different snapshot and fresh owner state are preserved, including explicit empty admin list', async () => {
  const store = createConnectorPermissionStore(storage());
  await store.importLegacy(envelope({ config: { adminOpenIds: '[]' }, groups: {} }));
  assert.equal((await store.importLegacy(envelope())).data.status, 'preserved_existing');
  assert.deepEqual((await store.get()).adminOpenIds, []);
  const initialized = createConnectorPermissionStore(storage());
  await initialized.initialize(decodeLegacyConnectorPermissions({ config: {}, groups: {} }));
  assert.equal((await initialized.importLegacy(envelope())).data.status, 'preserved_existing');
});
test('raw snapshot import validates digest, closed schema, bounds and decoded state before CAS', async () => {
  for (const input of [
    { ...envelope(), protocolVersion: 2 }, { ...envelope(), sourceDigest: '0'.repeat(64) },
    { ...envelope(), owner: true }, envelope({ config: { surprise: 'true' }, groups: {} }),
    envelope({ config: { adminOpenIds: '[]' }, groups: { g: '{"addedAt":2,"extra":true}' } }),
    envelope({ config: {}, groups: { g: 'x'.repeat(256 * 1024) } }),
    envelope({ config: {}, groups: Object.fromEntries(Array.from({ length: 5001 }, (_, i) => [`g${i}`, '{"addedAt":1}'])) }),
  ]) {
    const host = storage();
    await assert.rejects(createConnectorPermissionStore(host).importLegacy(input));
    assert.deepEqual(await host.list(), {});
  }
});
test('concurrent import publishes one atomic permission state and matching receipt revision', async () => {
  const store = createConnectorPermissionStore(storage());
  const results = await Promise.all([store.importLegacy(envelope()), store.importLegacy(envelope())]);
  assert.deepEqual(results.map(r => r.data.status).sort(), ['already_applied', 'imported']);
  assert.deepEqual(results.map(r => r.data.stateRevision), [1, 1]);
});

test('offline Redis snapshot preserves flags, explicit admins, group labels and original timestamps', () => {
  assert.deepEqual(decodeLegacyConnectorPermissions(legacy), {
    v: 1, whitelistEnabled: true, commandAdminOnly: true, adminConfigured: true,
    adminOpenIds: ['admin'], allowedGroups: [{ externalChatId: 'group', label: 'Kept', addedAt: 123 }],
  });
});
test('explicit empty admins differ from never configured; neither silently gains an admin', () => {
  assert.equal(decodeLegacyConnectorPermissions({ config: {}, groups: {} }).adminConfigured, false);
  const explicit = decodeLegacyConnectorPermissions({ config: { adminOpenIds: '[]' }, groups: {} });
  assert.equal(explicit.adminConfigured, true);
  assert.deepEqual(explicit.adminOpenIds, []);
});
test('malformed persisted permissions fail closed rather than resetting to permissive defaults', () => {
  for (const config of [{ whitelistEnabled: 'wat' }, { adminOpenIds: '{' }, { adminOpenIds: '[12]' }]) {
    assert.throws(() => decodeLegacyConnectorPermissions({ config, groups: {} }));
  }
  assert.throws(() => decodeLegacyConnectorPermissions({ config: {}, groups: { group: '{"addedAt":-1}' } }));
});
test('uninitialized permissions refuse routing until migration or explicit fresh initialization', async () => {
  await assert.rejects(createConnectorPermissionStore(storage()).get(), /initialized/);
});
test('migration is insert-only and never overwrites later owner changes', async () => {
  const store = createConnectorPermissionStore(storage());
  await store.initialize(decodeLegacyConnectorPermissions(legacy));
  await store.denyGroup('group');
  await store.initialize(decodeLegacyConnectorPermissions(legacy));
  assert.deepEqual((await store.get()).allowedGroups, []);
});
test('concurrent allow operations do not lose either group', async () => {
  const store = createConnectorPermissionStore(storage());
  await store.initialize(decodeLegacyConnectorPermissions({ config: {}, groups: {} }));
  await Promise.all([store.allowGroup('a', 'A', 5), store.allowGroup('b', 'B', 6)]);
  assert.deepEqual((await store.get()).allowedGroups.map(g => g.externalChatId).sort(), ['a', 'b']);
});
test('corrupt plugin state and persistent CAS conflicts fail closed', async () => {
  const host = storage();
  const store = createConnectorPermissionStore(host);
  await store.initialize(decodeLegacyConnectorPermissions(legacy));
  const key = Object.keys(await host.list())[0]!;
  await host.set(key, { v: 1 });
  await assert.rejects(store.get());
  const conflicting = storage();
  conflicting.compareAndSet = async () => ({ applied: false });
  await assert.rejects(createConnectorPermissionStore(conflicting).initialize(decodeLegacyConnectorPermissions(legacy)), /contention/);
});
test('blocked groups reject commands and ordinary messages before thread/send side effects', () => {
  const config = decodeLegacyConnectorPermissions(legacy);
  for (const text of ['hello', '/where', '/deny-group', '/allow-group-more']) {
    assert.equal(evaluateConnectorPermission(config, { chatId: 'other', group: true, senderId: 'admin', text }), 'group_not_allowed');
  }
});
test('only the exact allow-group command by a known admin bypasses group allowlist', () => {
  const config = decodeLegacyConnectorPermissions(legacy);
  assert.equal(evaluateConnectorPermission(config, { chatId: 'other', group: true, senderId: 'admin', text: ' /ALLOW-GROUP other ' }), 'allowed');
  for (const senderId of ['guest', undefined]) {
    assert.equal(evaluateConnectorPermission(config, { chatId: 'other', group: true, senderId, text: '/allow-group' }), 'group_not_allowed');
  }
});
test('admin-only slash guard rejects missing identity; ordinary group messages and direct chat remain allowed', () => {
  const config = decodeLegacyConnectorPermissions(legacy);
  for (const senderId of ['guest', undefined]) {
    assert.equal(evaluateConnectorPermission(config, { chatId: 'group', group: true, senderId, text: '/where' }), 'command_admin_only');
  }
  assert.equal(evaluateConnectorPermission(config, { chatId: 'group', group: true, text: 'hello' }), 'allowed');
  assert.equal(evaluateConnectorPermission(config, { chatId: 'direct', group: false, text: '/where' }), 'allowed');
});
test('shared command recognition covers exactly the fourteen migrated commands, not prefix lookalikes', () => {
  for (const name of ['where', 'new', 'threads', 'use', 'thread', 'commands', 'cats', 'status', 'history', 'unbind', 'allow-group', 'deny-group', 'focus', 'ask']) {
    assert.deepEqual(parseConnectorCommand(` /${name.toUpperCase()} arg `), { name, args: 'arg' });
  }
  for (const value of ['/where-more', '/allow-group-more', 'hello', '/unknown']) assert.equal(parseConnectorCommand(value), null);
});
