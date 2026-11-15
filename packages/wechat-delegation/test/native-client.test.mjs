import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { NativeClient } from '../src/native-client.mjs';

test('targets use a complete current-account directory, never the mixed historical contact cache', async () => {
  const calls = [];
  const items = Array.from({ length: 22 }, (_, i) => ({ id: `current-${i}`, kind: 'direct', displayName: `好友${i}` }));
  items.push({ id: 'current-room@chatroom', kind: 'group', displayName: '当前群' });
  const client = new NativeClient({ baseUrl: 'http://127.0.0.1:1/', token: 'a'.repeat(64), fetch: async (url, request) => {
    calls.push([url.pathname, request.method]);
    if (url.pathname.endsWith('/contact-sync')) {
      assert.equal(url.searchParams.get('directory'), 'true');
      return Response.json({ id: 'directory-op', accountId: 'account', kind: 'metadata', state: 'running' });
    }
    if (url.pathname.endsWith('/operations/directory-op')) return Response.json({ id: 'directory-op', accountId: 'account', kind: 'metadata', state: 'succeeded', result: {
      directory: { version: 1, source: 'wechat.initcontact', accountId: 'account', accountIdentity: 'owner', catalogComplete: true, items }
    } });
    if (url.pathname === '/v1/status') return Response.json({ serverId: 'server', version: { product: 'agent-wechat', backend: 'native', apiVersion: 1 } });
    if (url.pathname === '/v1/accounts/account') return Response.json({ id: 'account', ownUsername: 'owner', authenticated: true, connection: 'online' });
    throw Error('mixed contact cache must not be queried as an address book');
  } });
  const pending = await client.targets('account');
  assert.equal(pending.pending, true);
  const ready = await client.targets('account');
  assert.deepEqual(ready.items.map(x => x.id), items.map(x => x.id));
  assert.equal(ready.pending, false);
  assert.equal(calls.filter(([p, m]) => p.endsWith('/contact-sync') && m === 'POST').length, 1);
  assert.ok(!ready.items.some(x => x.id === 'old-friend' || x.id === 'group-only-member'));
});

test('current directory pagination is complete and its continuation stays with the same account and snapshot', async () => {
  const requests = [];
  const items = Array.from({ length: 73 }, (_, i) => ({ id: `person-${i}`, kind: 'direct', displayName: `好友${i}` }));
  const client = new NativeClient({ baseUrl: 'http://127.0.0.1:1/', token: 'a'.repeat(64), fetch: async url => {
    requests.push(String(url));
    if (url.pathname.endsWith('/contact-sync')) return Response.json({ id: 'directory-op', accountId: 'account', kind: 'metadata', state: 'running' });
    if (url.pathname.endsWith('/operations/directory-op')) return Response.json({ id: 'directory-op', accountId: 'account', kind: 'metadata', state: 'succeeded', result: { directory: {
      version: 1, source: 'wechat.initcontact', accountId: 'account', accountIdentity: 'owner', catalogComplete: true, items
    } } });
    if (url.pathname === '/v1/status') return Response.json({ serverId: 'server', version: { product: 'agent-wechat', backend: 'native', apiVersion: 1 } });
    if (url.pathname === '/v1/accounts/account') return Response.json({ id: 'account', ownUsername: 'owner', authenticated: true, connection: 'online' });
    throw Error('unexpected native route');
  } });
  await client.targets('account');
  const first = await client.targets('account');
  assert.equal(first.items.length, 50);
  assert.ok(first.nextCursor);
  const second = await client.targets('account', first.nextCursor);
  assert.deepEqual([...first.items, ...second.items].map(item => item.id), items.map(item => item.id));
  assert.equal(second.nextCursor, null);
  const before = requests.length;
  await assert.rejects(client.targets('foreign-account', first.nextCursor), /cursor/);
  assert.equal(requests.length, before);
  client.refreshTargets('account');
  await assert.rejects(client.targets('account', first.nextCursor), /cursor expired/);
});

test('old component counts, incomplete inventories and changed accounts never become selectable recipients', async () => {
  for (const scenario of ['old-component', 'incomplete', 'foreign-account']) {
    let starts = 0;
    const client = new NativeClient({ baseUrl: 'http://127.0.0.1:1/', token: 'a'.repeat(64), fetch: async url => {
      if (url.pathname.endsWith('/contact-sync')) { starts++; return Response.json({ id: 'op', accountId: 'account', kind: 'metadata', state: 'running' }); }
      if (url.pathname.endsWith('/operations/op')) return Response.json({ id: 'op', accountId: 'account', kind: 'metadata', state: 'succeeded', result: scenario === 'old-component' ? { complete: true, recordCount: 22 } : {
        directory: { version: 1, source: 'wechat.initcontact', accountId: 'account', accountIdentity: 'owner', catalogComplete: scenario !== 'incomplete', items: [{ id: 'person', kind: 'direct' }] }
      } });
      if (url.pathname.endsWith('/status')) return Response.json({ serverId: 'server', version: { product: 'agent-wechat', backend: 'native', apiVersion: 1 } });
      return Response.json({ id: 'account', ownUsername: 'different-owner', authenticated: true, connection: 'online' });
    } });
    await client.targets('account');
    await assert.rejects(client.targets('account'), scenario === 'foreign-account' ? /identity changed/ : /完整当前通讯录/);
    await assert.rejects(client.targets('account'));
    assert.equal(starts, 1, 'a failed read is not silently restarted every UI poll');
  }
});

test('real loopback HTTP uses the pinned text-send contract, stable key and exact canonical message for inspection', async t => {
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization, key: req.headers['idempotency-key'], body: raw });
    res.setHeader('content-type', 'application/json');
    if (req.url.endsWith('/messages/local')) return res.end(JSON.stringify({ id: 'local', accountId: 'account', threadId: 'room@chatroom', direction: 'outgoing', serverId: '123', body: '你好' }));
    res.end(JSON.stringify({ id: 'send1', accountId: 'account', destination: 'room@chatroom', state: 'accepted', localMessageId: 'local', serverId: '123' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const client = new NativeClient({ baseUrl: `http://127.0.0.1:${server.address().port}/`, token: 'a'.repeat(64) });
  const run = { id: 'stable', accountId: 'account', conversationId: 'room@chatroom', text: '你好' };
  const submitted = await client.submit(run);
  assert.equal(submitted.state, 'accepted');
  const inspected = await client.inspect({ ...run, sendId: submitted.sendId });
  assert.equal(inspected.verified, true);
  assert.equal(requests[0].key, 'stable');
  assert.equal(requests[0].authorization, `Bearer ${'a'.repeat(64)}`);
  assert.deepEqual(JSON.parse(requests[0].body), { threadId: 'room@chatroom', text: '你好' });
  assert.equal(requests.filter(r => r.method === 'POST').length, 1);
});

test('transport refuses arbitrary origins, redirects, cross-account receipts and oversized responses', async () => {
  for (const baseUrl of ['https://example.com/', 'http://localhost:80/', 'http://127.0.0.1:80/path', 'http://user:secret@127.0.0.1/'])
    assert.throws(() => new NativeClient({ baseUrl, token: 'a'.repeat(64) }));
  let requests = 0;
  const client = new NativeClient({ baseUrl: 'http://127.0.0.1:1/', token: 'a'.repeat(64), fetch: async (_url, input) => {
    requests++;
    assert.equal(input.redirect, 'error');
    return Response.json({ id: 'foreign', accountId: 'other', destination: 'friend', state: 'accepted' });
  } });
  await assert.rejects(client.submit({ id: 'key', accountId: 'account', conversationId: 'friend', text: 'hello' }), /identity/);
  assert.equal(requests, 1);
  const huge = new NativeClient({ baseUrl: 'http://127.0.0.1:1/', token: 'a'.repeat(64), fetch: async () => new Response('x'.repeat(1024 * 1024 + 1)) });
  await assert.rejects(huge.status(), /bound/);
});

test('uncertain send inspection is a GET on the original idempotency key and cancellation retains exact scope', async () => {
  const requests = [];
  const client = new NativeClient({ baseUrl: 'http://127.0.0.1:1/', token: 'a'.repeat(64), fetch: async (url, input) => {
    requests.push({ url: String(url), method: input.method });
    return Response.json({ id: 'native', accountId: 'account', destination: 'friend', state: 'cancelled' });
  } });
  const run = { id: 'original-key', accountId: 'account', conversationId: 'friend', text: 'hello' };
  assert.equal((await client.inspect(run)).state, 'cancelled');
  assert.match(requests[0].url, /sends\/by-idempotency-key\?key=original-key$/);
  assert.equal(requests[0].method, 'GET');
  await client.cancel({ ...run, sendId: 'native' });
  assert.match(requests[1].url, /sends\/native\/cancel$/);
});

test('a cached snapshot is discarded if the same native account slot changes owner', async () => {
  let ownerIdentity = 'first-owner', starts = 0;
  const client = new NativeClient({ baseUrl: 'http://127.0.0.1:1/', token: 'a'.repeat(64), fetch: async url => {
    if (url.pathname.endsWith('/contact-sync')) { starts++; return Response.json({ id: 'op', accountId: 'account', kind: 'metadata' }); }
    if (url.pathname.endsWith('/operations/op')) return Response.json({ id: 'op', accountId: 'account', kind: 'metadata', state: 'succeeded', result: { directory: {
      version: 1, source: 'wechat.initcontact', accountId: 'account', accountIdentity: 'first-owner', catalogComplete: true, unverifiedCount: 2, items: [{ id: 'first-friend', kind: 'direct' }]
    } } });
    if (url.pathname.endsWith('/status')) return Response.json({ serverId: 'server', version: { product: 'agent-wechat', backend: 'native', apiVersion: 1 } });
    return Response.json({ id: 'account', ownUsername: ownerIdentity, authenticated: true, connection: 'online' });
  } });
  await client.targets('account');
  const ready = await client.targets('account');
  assert.equal(ready.items[0].id, 'first-friend');
  assert.equal(ready.unverifiedCount, 2);
  ownerIdentity = 'second-owner';
  await assert.rejects(client.targets('account'), /identity changed/);
  assert.equal((await client.targets('account')).pending, true);
  assert.equal(starts, 2);
});
