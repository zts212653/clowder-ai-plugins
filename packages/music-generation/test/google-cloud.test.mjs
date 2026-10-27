import assert from 'node:assert/strict';
import { mkdtemp, chmod, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { googleCloudDependencies } from '../dist/google-cloud.js';
import { musicInput } from '../dist/types.js';

const grant = { type: 'authorized_user', client_id: 'fixture-client', client_secret: 'fixture-only', refresh_token: 'fixture-grant', quota_project_id: 'project-one' };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const auth = () => json({ token_type: 'Bearer', access_token: 'fixture-access', expires_in: 3600 });

test('the production client refreshes once and sends exactly one project-scoped Cloud request', async () => {
  const calls = [];
  const client = googleCloudDependencies(async (url, options) => {
    calls.push({ url, options });
    if (url === 'https://oauth2.googleapis.com/token') return auth();
    assert.equal(url, 'https://aiplatform.googleapis.com/v1beta1/projects/project-one/locations/global/interactions');
    assert.equal(options.headers.authorization, 'Bearer fixture-access');
    assert.equal(options.headers['x-goog-user-project'], 'project-one');
    assert.equal(options.headers['x-goog-api-key'], undefined);
    assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body);
    assert.equal(body.store, false);
    assert.equal(body.model, 'lyria-3-clip-preview');
    assert.match(body.input[0].text, /Instrumental only/);
    return json({ status: 'completed', model: body.model, id: 'provider-one', outputs: [{ type: 'audio', mime_type: 'audio/mpeg', data: Buffer.from('ID3fixture').toString('base64') }] });
  });
  const result = await client.generate(musicInput({ prompt: 'Piano' }), grant, new AbortController().signal);
  assert.equal(result.bytes.toString(), 'ID3fixture');
  assert.equal(calls.length, 2);
});

test('quota, safety, invalid media and lost responses are structured and never retried', async () => {
  const cases = [
    [() => json({ private: 'do-not-reflect' }, 429), 'quota_exhausted', false],
    [() => json({ status: 'failed', errors: [{ code: 'SAFETY_BLOCK' }] }), 'safety_refused', false],
    [() => json({ status: 'completed', outputs: [{ type: 'audio', mime_type: 'audio/mpeg', data: 'YmFk' }] }), 'invalid_response', true],
    [() => { throw new Error('do-not-reflect'); }, 'provider_unavailable', true],
  ];
  for (const [response, code, uncertain] of cases) {
    let generated = 0;
    const client = googleCloudDependencies(async url => {
      if (url === 'https://oauth2.googleapis.com/token') return auth();
      generated++; return response();
    });
    await assert.rejects(client.generate(musicInput({ prompt: 'Piano' }), grant, new AbortController().signal), error => {
      assert.equal(error.code, code); assert.equal(error.uncertain, uncertain);
      assert.equal(error.message.includes('do-not-reflect'), false); return true;
    });
    assert.equal(generated, 1);
  }
});

test('a rejected OAuth refresh makes zero generation calls; connection tests only use read APIs', async () => {
  const calls = [];
  let rejectGrant = true;
  const client = googleCloudDependencies(async url => {
    calls.push(url);
    if (url === 'https://oauth2.googleapis.com/token') return rejectGrant ? json({}, 400) : auth();
    if (url === 'https://cloudbilling.googleapis.com/v1/projects/project-one/billingInfo') return json({ billingEnabled: true });
    if (url === 'https://serviceusage.googleapis.com/v1/projects/project-one/services/aiplatform.googleapis.com') return json({ state: 'ENABLED' });
    throw new Error('unexpected endpoint');
  });
  await assert.rejects(client.generate(musicInput({ prompt: 'Piano' }), grant, new AbortController().signal), { code: 'oauth_authorization_required' });
  assert.deepEqual(calls, ['https://oauth2.googleapis.com/token']);
  rejectGrant = false;
  assert.deepEqual(await client.verifyConnection(grant), { projectId: 'project-one', billingEnabled: true, vertexEnabled: true });
  assert.equal(calls.some(url => url.includes('/interactions')), false);
});

test('explicit ADC reuse accepts only a private authorized-user file and refuses symlinks', async t => {
  const root = await mkdtemp(join(tmpdir(), 'music-adc-fixture-'));
  const original = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  t.after(async () => { if (original === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS; else process.env.GOOGLE_APPLICATION_CREDENTIALS = original; await rm(root, { recursive: true, force: true }); });
  const file = join(root, 'adc.json');
  await writeFile(file, JSON.stringify(grant), { mode: 0o600 });
  process.env.GOOGLE_APPLICATION_CREDENTIALS = file;
  const client = googleCloudDependencies(async () => { throw new Error('no network during ADC import'); });
  assert.deepEqual(await client.readAdc(), grant);
  await chmod(file, 0o644);
  await assert.rejects(client.readAdc());
  await chmod(file, 0o600);
  await symlink(file, join(root, 'linked.json'));
  process.env.GOOGLE_APPLICATION_CREDENTIALS = join(root, 'linked.json');
  await assert.rejects(client.readAdc());
  process.env.GOOGLE_APPLICATION_CREDENTIALS = file;
  await writeFile(file, JSON.stringify({ ...grant, type: 'service_account' }));
  await assert.rejects(client.readAdc());
});
