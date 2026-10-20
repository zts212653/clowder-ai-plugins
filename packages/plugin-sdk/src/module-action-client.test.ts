import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import test from 'node:test';
import { createModuleActionClient } from './module-action-client.js';

test('action transport refreshes credentials per call, preserves input, and never retries unknown writes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plugin-action-'));
  const file = join(dir, 'credentials.json');
  const requests: { headers: Record<string, unknown>; body: unknown }[] = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ headers: req.headers, body: JSON.parse(body) });
    if (requests.length === 3) { res.writeHead(503); res.end('secret-token-do-not-echo'); return; }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ result: requests.length }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const client = createModuleActionClient({ env: {
    CAT_CAFE_API_URL: `http://127.0.0.1:${address.port}`, CAT_CAFE_CREDENTIAL_FILE: file,
    CLOWDER_PLUGIN_ACTION_TOKEN: 'activation', CLOWDER_PLUGIN_ACTION_PATH: '/api/plugin-runtime/action',
    CAT_CAFE_INVOCATION_ID: 'stale', CAT_CAFE_CALLBACK_TOKEN: 'stale-secret',
  } });
  try {
    await writeFile(file, JSON.stringify({ invocationId: 'first', callbackToken: 'token1' }));
    assert.equal(await client.invoke('own.method', { registrationId: 'one' }), 1);
    await writeFile(file, JSON.stringify({ invocationId: 'second', callbackToken: 'token2' }));
    assert.equal(await client.invoke('own.method', { registrationId: 'one' }), 2);
    assert.deepEqual(requests[0]?.body, { method: 'own.method', input: { registrationId: 'one' } });
    assert.equal(requests[0]?.headers['x-invocation-id'], 'first');
    assert.equal(requests[1]?.headers['x-invocation-id'], 'second');
    assert.equal(requests[1]?.headers['x-clowder-plugin-action-token'], 'activation');
    await assert.rejects(client.invoke('own.method', {}), error => {
      assert.ok(error instanceof Error); assert.match(error.message, /503/);
      assert.doesNotMatch(error.message, /secret-token|token2/); return true;
    });
    assert.equal(requests.length, 3);
    await writeFile(file, 'invalid');
    await assert.rejects(client.invoke('own.method', {}), /credentials/i);
    assert.equal(requests.length, 3, 'invalid refresh file must not fall back to launch credentials');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true }); }
});

test('native MCP uses exact runtime turn metadata, rechecks projection after admission and isolates concurrent calls', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plugin-native-action-'));
  const file = join(dir, 'native.json');
  const projection = { v: 1, connectionId: 'connection', nativeThreadId: 'native_thread', turns: [
    { nativeTurnId: 'turn1', invocationId: 'invocation1', callbackToken: 'token1' },
    { nativeTurnId: 'turn2', invocationId: 'invocation2', callbackToken: 'token2' },
  ] };
  const calls: { url: string; headers: Headers }[] = [];
  let revoke = false;
  const client = createModuleActionClient({ env: {
    CAT_CAFE_API_URL: 'http://127.0.0.1:1', CLOWDER_PLUGIN_ACTION_TOKEN: 'activation',
    CLOWDER_PLUGIN_ACTION_PATH: '/api/plugin-runtime/action',
    CAT_CAFE_NATIVE_TURN_CREDENTIAL_FILE: file, CAT_CAFE_NATIVE_CONNECTION_ID: 'connection',
    CAT_CAFE_INVOCATION_ID: 'wrong', CAT_CAFE_CALLBACK_TOKEN: 'wrong',
  }, fetch: async (url, init) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers) });
    if (String(url).endsWith('native-turn-admission')) {
      if (revoke) await writeFile(file, JSON.stringify({ ...projection, turns: [] }));
      return new Response(null, { status: 204 });
    }
    return Response.json({ result: new Headers(init?.headers).get('x-invocation-id') });
  } });
  const options = (turn: string) => ({ _meta: { threadId: 'native_thread',
    'x-codex-turn-metadata': { thread_id: 'native_thread', turn_id: turn } } });
  try {
    await writeFile(file, JSON.stringify(projection));
    await assert.rejects(client.invoke('method', {}), /exact turn/);
    await assert.rejects(client.invoke('method', {}, options('absent')), /exact turn/);
    assert.equal(calls.length, 0);
    assert.deepEqual(await Promise.all([
      client.invoke('method', { catId: 'untrusted-input' }, options('turn1')),
      client.invoke('method', {}, options('turn2')),
    ]), ['invocation1', 'invocation2']);
    const writes = () => calls.filter(call => call.url.endsWith('/action')).length;
    assert.equal(writes(), 2);
    revoke = true;
    await assert.rejects(client.invoke('method', {}, options('turn1')), /exact turn/);
    assert.equal(writes(), 2);
    const abort = new AbortController(); abort.abort();
    await assert.rejects(client.invoke('method', {}, { ...options('turn1'), signal: abort.signal }));
    assert.equal(writes(), 2);
  } finally { await rm(dir, { recursive: true }); }
});
