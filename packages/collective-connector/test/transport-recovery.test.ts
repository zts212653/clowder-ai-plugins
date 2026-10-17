import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BROWSER_SERVICE_LIMITS, type BrowserServiceBinding, type BrowserServiceContribution, type BrowserServiceDispatchContext,
  type BrowserServiceHost } from '@clowder-ai/plugin-sdk';
import { parse } from 'yaml';
import { CollectiveServiceStore } from '../src/business/service/store.js';
import { CollectiveServiceClient, ConnectorTransportError } from '../src/business/connector/service-client.js';
import { createNodeHttpAdapter } from '../src/node-http-adapter.js';
import { createLocalServiceTransport } from '../src/local-service-transport.js';

const manifest = parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8'));
const contribution = manifest.contributions.find((value: BrowserServiceContribution) => value.type === 'browser-service') as BrowserServiceContribution;
const binding: BrowserServiceBinding = { contributionId: 'collective-client-api', origin: 'http://127.0.0.1:5271', parentOrigin: 'http://localhost:5172',
  clientBuildId: 'collective-client-v2', assetDigest: 'a'.repeat(64), limits: BROWSER_SERVICE_LIMITS, async assertCurrent() {} };
const caller = (lane: 'browser' | 'local'): BrowserServiceDispatchContext => ({ kind: 'http', lane, contributionId: binding.contributionId,
  requestId: 'fixture', signal: new AbortController().signal, async assertCurrent() {} });
const wire = (method: 'GET' | 'POST', path: string, body = '', headers: Array<{ name: string; value: string }> = [], rawQuery = '') =>
  ({ request: { version: 1, method, path, rawQuery, headers, rawBodyBase64: Buffer.from(body).toString('base64') } });
test('exact-origin local refusal preserves typed effects, rejects malformed replies and never falls back to remote fetch', async () => {
  let dispatches = 0, network = 0;
  let outcome: unknown = { kind: 'transport-error', code: 'BROWSER_SERVICE_TIMEOUT', effect: 'unknown', automaticRetry: false };
  const host: BrowserServiceHost = { async getBinding() { return binding; }, async dispatchLocal() { dispatches++; return outcome as never; } };
  const transport = createLocalServiceTransport(host, binding, {} as CollectiveServiceStore);
  const client = new CollectiveServiceClient(async () => { network++; return Response.json({ serviceInstanceId: 'remote', clientBuildId: 'remote-build' }); }, 10000, transport);
  for (const result of [outcome, { ...outcome as object, automaticRetry: true }, null, { kind: 'response', response: { status: 200, headers: [], bodyBase64: 'YQ' } }]) {
    outcome = result;
    await assert.rejects(() => client.readMetadata(binding.origin), (error: unknown) => error instanceof ConnectorTransportError &&
      error.automaticRetry === false && error.effect === 'unknown' && error.retryable === false);
  }
  assert.equal(network, 0); assert.equal(dispatches, 4);
  assert.deepEqual(await client.readMetadata('https://remote.example'), { serviceInstanceId: 'remote', clientBuildId: 'remote-build' });
  assert.equal(network, 1); assert.equal(dispatches, 4);
  const revoked = createLocalServiceTransport(host, { ...binding, async assertCurrent() { throw new Error('revoked'); } }, {} as CollectiveServiceStore);
  await assert.rejects(() => revoked.fetch(binding.origin), (error: unknown) => error instanceof ConnectorTransportError && error.effect === 'not_started');
  assert.equal(dispatches, 4);
});
test('Node adapter enforces declared lanes and origins before effects, and preserves actual callback cookie scope/clear', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'collective-http-adapter-'));
  try {
    const { store, bootstrapSecret } = await CollectiveServiceStore.open({ dataDirectory: dir, humanAuthRedirectUri: binding.origin + '/api/auth/github/callback',
      humanAuthProvider: { id: 'github', readiness: { ready: true }, authorizationUrl: () => 'https://github.test/auth',
        async authenticate() { return { providerSubject: 'owner', handle: 'owner', displayName: 'Owner' }; } } });
    const dispatch = createNodeHttpAdapter({ store, allowedHostOrigins: [binding.parentOrigin, binding.origin] }, binding, contribution);
    const bytes = await readFile(join(dir, 'collective-service.json'));
    for (const headers of [[], [{ name: 'origin', value: binding.parentOrigin }], [{ name: 'origin', value: 'https://evil.example' }]])
      await assert.rejects(() => dispatch(wire('POST', '/api/bootstrap', JSON.stringify({ secret: bootstrapSecret, displayName: 'Owner' }), headers), undefined, caller('browser')), /admitted/);
    await assert.rejects(() => dispatch(wire('GET', '/api/meta', '', [{ name: 'origin', value: binding.origin }]), undefined, caller('local')), /admitted/);
    await assert.rejects(() => dispatch(wire('POST', '/api/connections/exchange', '{}'), undefined, caller('local')), /admitted/);
    await assert.rejects(() => dispatch(wire('GET', '/api/meta', '', [{ name: 'cookie', value: 'collective_auth_completion=' + 'a'.repeat(43) }]), undefined, caller('browser')), /admitted/);
    await assert.rejects(() => dispatch(wire('POST', '/api/bootstrap', 'a'.repeat(262145), [{ name: 'origin', value: binding.origin }]), undefined, caller('browser')), /admitted/);
    assert.deepEqual(await readFile(join(dir, 'collective-service.json')), bytes);
    const bootstrap = await store.consumeBootstrap({ secret: bootstrapSecret!, displayName: 'Owner' });
    const attempt = await store.beginHumanAuth({ provider: 'github', intent: { kind: 'bind' }, sessionToken: bootstrap.sessionToken });
    const callback = await dispatch(wire('GET', '/api/auth/github/callback', '', [], new URLSearchParams({ state: attempt.state, code: 'code' }).toString()), undefined, caller('browser'));
    assert.equal(callback.status, 303);
    const cookie = callback.headers.find(header => header.name === 'set-cookie')!.value;
    assert.match(cookie, /^collective_auth_completion=[A-Za-z0-9_-]{43};/);
    assert.match(cookie, /HttpOnly; SameSite=Strict; Path=\/api\/auth\/completions\/exchange; Max-Age=300$/);
    assert.equal(/Domain=/i.test(cookie), false);
    const exchanged = await dispatch(wire('POST', '/api/auth/completions/exchange', '{}', [
      { name: 'origin', value: binding.origin }, { name: 'content-type', value: 'application/json' }, { name: 'cookie', value: cookie.split(';')[0]! },
    ]), undefined, caller('browser'));
    assert.equal(exchanged.status, 200);
    assert.match(exchanged.headers.find(header => header.name === 'set-cookie')!.value, /^collective_auth_completion=;.*Max-Age=0$/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('late abort cannot turn an already committed business mutation into a successful response or rollback claim', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'collective-late-abort-'));
  try {
    const { store, bootstrapSecret } = await CollectiveServiceStore.open({ dataDirectory: dir });
    const abort = new AbortController(); const original = store.consumeBootstrap.bind(store);
    store.consumeBootstrap = async input => { const committed = await original(input); abort.abort(); return committed; };
    const dispatch = createNodeHttpAdapter({ store, allowedHostOrigins: [binding.origin, binding.parentOrigin] }, binding, contribution);
    await assert.rejects(() => dispatch(wire('POST', '/api/bootstrap', JSON.stringify({ secret: bootstrapSecret, displayName: 'Owner' }), [
      { name: 'origin', value: binding.origin }, { name: 'content-type', value: 'application/json' },
    ]), undefined, { ...caller('browser'), signal: abort.signal }), /abort/i);
    assert.equal(store.getMetadata().bootstrapNeeded, false, 'effect remains committed; lifetime refusal cannot assert rollback');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
