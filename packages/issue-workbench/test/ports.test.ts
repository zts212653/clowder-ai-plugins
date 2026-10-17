import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSourceClient, type WorkbenchHost } from '../src/ports/host';
const storage = { getItem: () => null, setItem: () => {} };
function host(repo: string, scope = 'owner'): WorkbenchHost {
  return { repo, dataScope: scope, storage, request: async () => new Response('{}'), confirm: async () => false };
}
test('repositories and owners have distinct persistent keys and transports', async () => {
  const a = createSourceClient(host('team/a')); const b = createSourceClient(host('team/b'));
  const c = createSourceClient(host('team/a','other-owner'));
  assert.notEqual(a.storageKey,b.storageKey); assert.notEqual(a.storageKey,c.storageKey);
  await assert.rejects(a.fetch('/api/issue-source?repo=team%2Fb'), /outside/);
  await assert.rejects(a.fetch('https://evil.test/api/issue-source?repo=team%2Fa'), /outside/);
  await assert.rejects(a.fetch('/api/session?repo=team%2Fa'), /outside/);
  await assert.rejects(a.fetch('/api/issue-source?repo=team%2Fa', {method:'POST'}), /outside/);
  assert.equal((await a.fetch('/api/issue-source?repo=team%2Fa')).status,200);
});
test('unauthorized response is preserved without private session recovery or retries', async () => {
  let calls = 0;
  const a = createSourceClient({...host('team/a'), request: async () => { calls++; return new Response('',{status:401}); }});
  assert.equal((await a.fetch('/api/issue-source?repo=team%2Fa')).status,401);
  assert.equal(calls,1);
});
