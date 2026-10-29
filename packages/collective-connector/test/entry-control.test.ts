import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import * as entry from '../src/entry-control.js';
const rows = [{ catId: 'cat-b', displayName: 'Cat', defaultModel: 'model', available: true },
  { catId: 'cat-a', displayName: 'Cat', defaultModel: 'model', available: true }];
const intent = { serviceInstanceId: 'svc_aaaaaaaa', collectiveId: 'col_aaaaaaaa', pairingIntentId: 'pair_aaaaaaaa',
  hostOrigin: 'http://localhost:5172', nonce: '0123456789abcdef', expiresAt: '2030-01-01T00:00:00.000Z' };
function fixture() {
  assert.equal(typeof entry.createCollectiveEntryCaller, 'function', 'the original entry caller must be migrated');
  const calls: unknown[] = []; let current = rows;
  const connector = { async pair(input: unknown) { calls.push(input); return { connectionId: 'con_aaaaaaaa' }; } };
  const caller = entry.createCollectiveEntryCaller({ async assertCurrent() {}, members: {async get(){return null;},async list(){calls.push(['roster']);return current;}}, connector: connector as never });
  return { caller, calls, change() { current = rows.map(row => ({ ...row, displayName: 'Changed' })); },
    setRows(value: typeof rows) { current = value; }, connector };
}
test('entry caller preserves qualification/disambiguation, sorting, eligible projection and fingerprint', async () => {
  const f = fixture(), roster = await f.caller.entryRoster(async () => {});
  assert.deepEqual(roster.cats, [
    { id: 'cat-a', displayName: 'Cat（model） · cat-a', eligible: true, defaultModel: 'model' },
    { id: 'cat-b', displayName: 'Cat（model） · cat-b', eligible: true, defaultModel: 'model' },
  ]);
  assert.equal(roster.fingerprint, createHash('sha256').update(JSON.stringify(roster.cats)).digest('hex'));
  assert.deepEqual(f.calls, [['roster']]);
});
test('entry roster offers only Host-enabled members, including after all members were disabled', async () => {
  const f = fixture();
  f.setRows(rows.map(row => ({ ...row, available: row.catId === 'cat-a' })));
  const enabled = await f.caller.entryRoster(async () => {});
  assert.deepEqual(enabled.cats.map(cat => cat.id), ['cat-a']);
  f.setRows(rows.map(row => ({ ...row, available: false })));
  const empty = await f.caller.entryRoster(async () => {});
  assert.deepEqual(empty.cats, []);
  assert.notEqual(empty.fingerprint, enabled.fingerprint);
  f.setRows(rows);
  const restored = await f.caller.entryRoster(async () => {});
  assert.deepEqual(restored.cats.map(cat => cat.id), ['cat-a', 'cat-b']);
});
test('disabling a member after preview rejects the stale confirmation before any pairing effect', async () => {
  const f = fixture(), preview = await f.caller.entryRoster(async () => {});
  const body = { serviceUrl: 'http://127.0.0.1:5271', endpointLabel: 'Owner', intent,
    rosterFingerprint: preview.fingerprint, excludedCatIds: [] };
  f.setRows(rows.map(row => ({ ...row, available: row.catId === 'cat-a' })));
  const result = await f.caller.pair(body, intent.hostOrigin, async () => {});
  assert.equal(result.status, 409);
  assert.deepEqual(result.body, { code: 'ENTRY_ROSTER_CHANGED', error: '伙伴名单已更新，请重新确认。' });
  assert.ok(f.calls.every(call => Array.isArray(call)), 'no Connector pair effect after the Host disabled a member');
  const fresh = await f.caller.entryRoster(async () => {});
  assert.deepEqual(fresh.cats.map(cat => cat.id), ['cat-a']);
  assert.equal((await f.caller.pair({ ...body, rosterFingerprint: fresh.fingerprint }, intent.hostOrigin, async () => {})).status, 200);
});
test('pair rereads the actual Host roster before Connector effects and retains exclusion payload', async () => {
  const f = fixture(), roster = await f.caller.entryRoster(async () => {});
  const body = { serviceUrl: 'http://127.0.0.1:5271', endpointLabel: 'Owner', intent, rosterFingerprint: roster.fingerprint, excludedCatIds: ['cat-b'] };
  const result = await f.caller.pair(body, intent.hostOrigin, async () => {});
  assert.equal(result.status, 200);
  assert.deepEqual(f.calls.at(-1), { serviceUrl: body.serviceUrl, endpointLabel: body.endpointLabel, intent, initialExcludedCatIds: ['cat-b'] });
  assert.equal(f.calls.filter(call => Array.isArray(call) && call[0] === 'roster').length, 2);
  f.change(); const before = f.calls.length;
  assert.equal((await f.caller.pair(body, intent.hostOrigin, async () => {})).status, 409);
  assert.equal(f.calls.length, before + 1, 'changed roster must not enter Connector pair');
});
test('pair preserves invalid/origin/unknown exclusion and duplicate error responses', async () => {
  const f = fixture(), roster = await f.caller.entryRoster(async () => {});
  const body = { serviceUrl: 'http://127.0.0.1:5271', endpointLabel: 'Owner', intent, rosterFingerprint: roster.fingerprint, excludedCatIds: [] };
  assert.equal((await f.caller.pair({ ...body, userId: 'forged' }, intent.hostOrigin, async () => {})).status, 400);
  assert.equal((await f.caller.pair(body, undefined, async () => {})).status, 403);
  assert.equal((await f.caller.pair(body, 'http://foreign.invalid', async () => {})).status, 403);
  assert.equal((await f.caller.pair({ ...body, excludedCatIds: ['unknown'] }, intent.hostOrigin, async () => {})).status, 409);
  f.connector.pair = async () => { throw new Error('This Café is already connected to this Collective'); };
  assert.deepEqual(await f.caller.pair(body, intent.hostOrigin, async () => {}), { status: 409, body: { code: 'COLLECTIVE_ALREADY_CONNECTED', error: '这台 Café 已连接此 Collective。' } });
});
test('roster Host refusal propagates and cannot become available or a cached pairing roster', async () => {
  assert.equal(typeof entry.createCollectiveEntryCaller, 'function');
  const refusal = new Error('DELIVERY_REJECTED'); let paired = false;
  const caller = entry.createCollectiveEntryCaller({ async assertCurrent() {}, members: {async get(){return null;},async list(){throw refusal;}}, connector: { async pair() { paired = true; } } as never });
  await assert.rejects(() => caller.entryRoster(async () => {}), error => error === refusal);
  assert.equal(paired, false);
});

test('pairing rechecks the Host binding after roster reads before entering Connector effects', async () => {
  let revoked = false, paired = false;
  const current = async () => { if (revoked) throw new Error('Owner binding expired'); };
  const caller = entry.createCollectiveEntryCaller({ assertCurrent: current,
    members: {async get(){return null;},async list(){revoked=true;return rows;}},
    connector: { async pair() { paired = true; return { connectionId: 'con_aaaaaaaa' }; } } as never });
  const roster = entry.entryRoster(entry.registeredCollectiveCats(rows.map(({catId,...row})=>({...row,id:catId}))));
  const body = { serviceUrl: 'http://127.0.0.1:5271', endpointLabel: 'Owner', intent, rosterFingerprint: roster.fingerprint, excludedCatIds: [] };
  await assert.rejects(() => caller.pair(body, intent.hostOrigin, async () => {}), /binding expired/);
  assert.equal(paired, false, 'lost binding must refuse before Connector pair enters');
});
test('pairing keeps a late effect honest when the Host binding expires during Connector pair', async () => {
  let revoked = false, paired = 0;
  const caller = entry.createCollectiveEntryCaller({ assertCurrent: async () => { if (revoked) throw new Error('Owner binding expired'); },
    members: {async get(){return null;},async list(){return rows;}},
    connector: { async pair() { paired++; revoked = true; return { connectionId: 'con_aaaaaaaa' }; } } as never });
  const roster = await caller.entryRoster(async () => {});
  const body = { serviceUrl: 'http://127.0.0.1:5271', endpointLabel: 'Owner', intent, rosterFingerprint: roster.fingerprint, excludedCatIds: [] };
  await assert.rejects(() => caller.pair(body, intent.hostOrigin, async () => {}), /binding expired/);
  assert.equal(paired, 1, 'currentness failure does not claim to roll back an already entered pair');
});
