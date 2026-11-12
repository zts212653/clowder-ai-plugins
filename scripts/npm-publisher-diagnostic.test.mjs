import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectPublisher } from './npm-publisher-diagnostic.mjs';

test('invalid Actions token is distinguished from OIDC and stops authenticated probing', async () => {
  const calls = [];
  const result = await inspectPublisher({ token: 'fixture-private-token', fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ error: 'fixture-private-token' }), { status: 401 });
  } });
  assert.equal(result.whoami.status, 401);
  assert.equal(calls.length, 1);
  assert.equal(JSON.stringify(result).includes('fixture-private-token'), false);
});

test('only registry GETs are made and raw credential/account payloads never escape', async () => {
  const calls = [];
  const responses = [
    { username: 'fixture-owner', token: 'fixture-private-token' },
    { 'fixture-owner': 'owner', 'unrelated-private-member': 'admin' },
    { '@clowder-ai/enterprise-workflow': 'read-write', '@unrelated/private': 'read-write' },
    { name: '@clowder-ai/enterprise-workflow', versions: {}, secret: 'fixture-private-token' },
  ];
  const result = await inspectPublisher({ token: 'fixture-private-token', fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(responses.shift()), { status: 200 });
  } });
  assert.equal(result.whoami.username, 'fixture-owner');
  assert.equal(result.organization.role, 'owner');
  assert.equal(result.packages.access['@clowder-ai/enterprise-workflow'], 'read-write');
  assert.equal(result.enterprise.status, 200);
  for (const { url, options } of calls) {
    assert.equal(new URL(url).origin, 'https://registry.npmjs.org');
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.authorization, 'Bearer fixture-private-token');
  }
  for (const privateValue of ['fixture-private-token', 'unrelated-private-member', '@unrelated/private']) {
    assert.equal(JSON.stringify(result).includes(privateValue), false);
  }
});

test('missing credential makes no requests', async () => {
  const result = await inspectPublisher({ token: '', fetchImpl: () => assert.fail('unexpected network') });
  assert.deepEqual(result, { configured: false });
});

test('transport exceptions cannot echo credentials', async () => {
  const result = await inspectPublisher({ token: 'fixture-private-token', fetchImpl: async () => {
    throw new Error('Bearer fixture-private-token');
  } });
  assert.equal(result.whoami.error, 'request_failed');
  assert.equal(JSON.stringify(result).includes('fixture-private-token'), false);
});
