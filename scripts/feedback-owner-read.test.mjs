import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectIdentityOnly } from './feedback-owner-read.mjs';

test('a valid credential causes only one fixed GET and returns only the username', async () => {
  const calls = [];
  const result = await inspectIdentityOnly({ token: 'fixture-private-token', fetchImpl: async (url, options) => {
    calls.push({ url, method: options.method, redirect: options.redirect });
    return new Response(JSON.stringify({ username: 'fixture_owner', token: 'fixture-private-token' }), { status: 200 });
  } });
  assert.deepEqual(calls, [{ url: 'https://registry.npmjs.org/-/whoami', method: 'GET', redirect: 'error' }]);
  assert.deepEqual(result, { configured: true, status: 200, username: 'fixture_owner', actualRequests: 1 });
  assert.doesNotMatch(JSON.stringify(result), /fixture-private-token/);
});

test('missing or rejected credentials cannot trigger extra requests or reveal response details', async () => {
  const missing = await inspectIdentityOnly({ token: '', fetchImpl: () => assert.fail('unexpected request') });
  assert.equal(missing.actualRequests, 0);
  const rejected = await inspectIdentityOnly({ token: 'fixture-private-token', fetchImpl: async () =>
    new Response(JSON.stringify({ error: 'fixture-private-token' }), { status: 401 }) });
  assert.deepEqual(rejected, { configured: true, status: 401, username: null, actualRequests: 1 });
  assert.doesNotMatch(JSON.stringify(rejected), /fixture-private-token/);
});
