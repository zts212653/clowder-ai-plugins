import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { NativeClient } from '../src/native-client.mjs';

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
