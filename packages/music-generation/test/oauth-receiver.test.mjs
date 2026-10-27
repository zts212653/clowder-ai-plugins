import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runOAuthReceiver } from '../dist/oauth-receiver.js';
import { readPrivateJson, writeNew } from '../dist/private-files.js';

test('the receiver survives its initiating request and rejects wrong state before exchanging a code', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'music-consent-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let exchanges = 0;
  await writeNew(join(directory, 'request.json'), JSON.stringify({ flowId: 'flow-one', projectId: 'project-one', expiresAt: Date.now() + 60_000,
    clientId: 'fixture.apps.googleusercontent.com', clientSecret: 'fixture-desktop-secret' }));
  const receiver = await runOAuthReceiver(directory, async (_url, init) => {
    exchanges++;
    const form = new URLSearchParams(init.body);
    assert.equal(form.get('code'), 'fixture-consent-code');
    assert.ok(form.get('code_verifier').length >= 43);
    return new Response(JSON.stringify({ token_type: 'Bearer', refresh_token: 'fixture-consented-grant', scope: 'openid https://www.googleapis.com/auth/cloud-platform' }));
  });
  t.after(() => receiver.close());
  const status = await readPrivateJson(join(directory, 'status.json'));
  assert.equal(status.state, 'pending');
  const url = new URL(status.authorizationUrl);
  const callback = new URL(url.searchParams.get('redirect_uri'));
  assert.equal(callback.hostname, '127.0.0.1');
  assert.equal(url.hostname, 'accounts.google.com');
  const wrong = new URL(callback);
  wrong.searchParams.set('state', 'wrong'); wrong.searchParams.set('code', 'fixture-consent-code');
  assert.equal((await fetch(wrong)).status, 400);
  assert.equal(exchanges, 0);
  callback.searchParams.set('state', url.searchParams.get('state')); callback.searchParams.set('code', 'fixture-consent-code');
  const response = await fetch(callback);
  assert.equal(response.status, 200);
  assert.equal((await response.text()).includes('fixture-consented-grant'), false);
  const completed = await readPrivateJson(join(directory, 'completed.json'));
  assert.equal(completed.flowId, 'flow-one');
  assert.equal(completed.grant.quota_project_id, 'project-one');
  assert.equal(exchanges, 1);
});

test('cancel and missing Cloud consent cannot produce an adoptable grant', async t => {
  for (const cancel of [true, false]) {
    const directory = await mkdtemp(join(tmpdir(), 'music-consent-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await writeNew(join(directory, 'request.json'), JSON.stringify({ flowId: 'flow-one', projectId: 'project-one', expiresAt: Date.now() + 60_000,
      clientId: 'fixture.apps.googleusercontent.com', clientSecret: 'fixture' }));
    const receiver = await runOAuthReceiver(directory, async () => new Response(JSON.stringify({ token_type: 'Bearer', refresh_token: 'fixture', scope: 'openid' })));
    t.after(() => receiver.close());
    const status = await readPrivateJson(join(directory, 'status.json'));
    if (cancel) await writeNew(join(directory, 'canceled.json'), '{}');
    const url = new URL(status.authorizationUrl);
    const callback = new URL(url.searchParams.get('redirect_uri'));
    callback.searchParams.set('state', url.searchParams.get('state')); callback.searchParams.set('code', 'fixture-code');
    assert.ok((await fetch(callback)).status >= 400);
    await assert.rejects(readFile(join(directory, 'completed.json')), { code: 'ENOENT' });
  }
});
