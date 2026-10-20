import assert from 'node:assert/strict';import test from 'node:test';
import {createConnectorPermissionStore,evaluateConnectorPermission,parseConnectorCommand,type ConnectorPermissions} from './connector-permissions.js';
import type {PluginStorageHost} from './module-host.js';
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

const defaultPolicy=():ConnectorPermissions=>({v:1,whitelistEnabled:false,commandAdminOnly:false,adminConfigured:false,adminOpenIds:[],allowedGroups:[]});
const configuredPolicy=():ConnectorPermissions=>({v:1,whitelistEnabled:true,commandAdminOnly:true,adminConfigured:true,adminOpenIds:['admin'],allowedGroups:[{externalChatId:'group',label:'Kept',addedAt:123}]});
function policyWithGroups(count:number):ConnectorPermissions{return {...configuredPolicy(),allowedGroups:Array.from({length:count},(_,i)=>({externalChatId:'g'+i,label:'Group '+i,addedAt:i}))};}
test('shared durable group bound refuses group 5001 but permits replacement at capacity', async () => {
  const host = storage(); const store = createConnectorPermissionStore(host);
  await host.set('connector.permissions.v1',policyWithGroups(5000));
  const before = await host.list();
  await assert.rejects(store.allowGroup('g5000', 'overflow', 5000), /group bound/);
  assert.deepEqual(await host.list(), before);
  await store.allowGroup('g4999', 'Replacement', 6000);
  assert.equal((await store.get()).allowedGroups.length, 5000);
  assert.deepEqual((await store.get()).allowedGroups.at(-1), { externalChatId: 'g4999', label: 'Replacement', addedAt: 6000 });
});

test('concurrent last-slot admissions persist exactly one distinct group', async () => {
  const host = storage(); const store = createConnectorPermissionStore(host);
  await host.set('connector.permissions.v1',policyWithGroups(4999));
  const results = await Promise.allSettled([store.allowGroup('a'), store.allowGroup('b')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((await store.get()).allowedGroups.length, 5000);
});

test('concurrent allow operations do not lose either group', async () => {
  const store = createConnectorPermissionStore(storage());

  await Promise.all([store.allowGroup('a', 'A', 5), store.allowGroup('b', 'B', 6)]);
  assert.deepEqual((await store.get()).allowedGroups.map(g => g.externalChatId).sort(), ['a', 'b']);
});

test('blocked groups reject commands and ordinary messages before thread/send side effects', () => {
  const config = configuredPolicy();
  for (const text of ['hello', '/where', '/deny-group', '/allow-group-more']) {
    assert.equal(evaluateConnectorPermission(config, { chatId: 'other', group: true, senderId: 'admin', text }), 'group_not_allowed');
  }
});

test('only the exact allow-group command by a known admin bypasses group allowlist', () => {
  const config = configuredPolicy();
  assert.equal(evaluateConnectorPermission(config, { chatId: 'other', group: true, senderId: 'admin', text: ' /ALLOW-GROUP other ' }), 'allowed');
  for (const senderId of ['guest', undefined]) {
    assert.equal(evaluateConnectorPermission(config, { chatId: 'other', group: true, senderId, text: '/allow-group' }), 'group_not_allowed');
  }
});

test('admin-only slash guard rejects missing identity; ordinary group messages and direct chat remain allowed', () => {
  const config = configuredPolicy();
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
test('missing state is an unrestricted read-only default and commands persist only their own changes',async()=>{
 const host=storage(),store=createConnectorPermissionStore(host);assert.deepEqual(await store.get(),defaultPolicy());assert.deepEqual(await host.list(),{});
 await Promise.all([store.allowGroup('a','A',5),store.allowGroup('b','B',6)]);assert.deepEqual((await store.get()).allowedGroups.map(g=>g.externalChatId).sort(),['a','b']);
 assert.equal((await store.get()).whitelistEnabled,false);assert.equal((await store.get()).adminConfigured,false);
});
test('corrupt and oversized policy fails closed without resetting stored data',async()=>{
 for(const bad of [{v:1},policyWithGroups(5001),{...configuredPolicy(),adminOpenIds:[12]}]){
  const host=storage(),store=createConnectorPermissionStore(host);await host.set('connector.permissions.v1',bad);const before=await host.list();
  await assert.rejects(store.get());await assert.rejects(store.allowGroup('x'));await assert.rejects(store.denyGroup('group'));assert.deepEqual(await host.list(),before);
 }
});
test('permission mutations preserve contention errors',async()=>{const host=storage();host.compareAndSet=async()=>({applied:false});await assert.rejects(createConnectorPermissionStore(host).allowGroup('a'),/contention/);});
