import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemberClient } from './members.js';
const member = { catId: 'sol', displayName: '砚砚', defaultModel: 'model', available: true };
test('one member directory returns detached public facts without plugin contribution filtering', async () => {
  const client = createMemberClient({ async list() { return [member]; }, async get() { return member; } }, () => {});
  assert.deepEqual(await client.list(), [member]);
  const value = await client.get('sol'); assert.ok(Object.isFrozen(value)); assert.notEqual(value, member);
  await assert.rejects(client.get('other'), /another member/);
});
test('member facts reject plugin policy fields and preserve unavailable quota without inventing support', async () => {
  const client = createMemberClient({ async list() { return [{ ...member, available: false }]; }, async get() { return null; } }, () => {});
  assert.deepEqual(await client.list(), [{ ...member, available: false }]); assert.equal(await client.get('absent'), null);
  const invalid = createMemberClient({ async list() { return [{ ...member, supported: true }]; }, async get() { return null; } }, () => {});
  await assert.rejects(invalid.list(), /PluginMember/);
});
test('revoked member clients reject both new calls and late Host results', async () => {
  let active = true; let reads = 0; let finish!: (value: typeof member[]) => void;
  const client = createMemberClient({ async list() { reads++; return new Promise(resolve => { finish = resolve; }); }, async get() { reads++; return member; } },
    () => { if (!active) throw new Error('revoked'); });
  const pending = client.list(); active = false; finish([member]); await assert.rejects(pending, /revoked/);
  await assert.rejects(client.get('sol'), /revoked/); assert.equal(reads, 1);
});
