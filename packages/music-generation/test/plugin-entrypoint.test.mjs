import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createMusicPlugin } from '../dist/plugin-entrypoint.js';

const grant = () => ({ type: 'authorized_user', client_id: 'fixture-client', client_secret: 'fixture-only', refresh_token: 'fixture-grant', quota_project_id: 'project-one' });
async function setup(t, overrides = {}) {
  const dataPath = await mkdtemp(join(tmpdir(), 'music-plugin-'));
  t.after(() => rm(dataPath, { recursive: true, force: true }));
  const counters = { imports: 0, checks: 0, generations: 0 };
  const config = new Map([['projectId', 'project-one']]);
  const secrets = new Map();
  const host = { pluginInstanceId: 'music-install-one', dataPath, config: { get: async key => config.get(key) }, secrets: { get: async key => secrets.get(key) }, log() {} };
  const dependencies = {
    readAdc: async () => { counters.imports++; return grant(); },
    verifyConnection: async () => { counters.checks++; return { projectId: 'project-one', billingEnabled: true, vertexEnabled: true }; },
    generate: async () => { counters.generations++; return { bytes: Buffer.from('ID3fixture-audio'), responseId: 'provider-one', modelVersion: 'lyria-3-clip-preview' }; },
    ...overrides,
  };
  const definition = createMusicPlugin(dependencies).create({});
  const call = { assertCurrent: async () => {} };
  const action = { ...call, catId: 'cat-one', threadId: 'thread-one', userId: 'owner-one', invocationId: 'invocation-one', outputOperation: { id: 'host-output-one' } };
  return { definition, host, counters, config, secrets, call, action, dataPath };
}

test('installation and settings inspection do not import credentials or generate', async t => {
  const h = await setup(t);
  const settings = await h.definition.settings(h.host);
  const result = await settings.actions['music.check']({}, undefined, h.call);
  assert.equal(result.ok, false);
  assert.equal(result.details.status, 'configuration_required');
  assert.deepEqual(h.counters, { imports: 0, checks: 0, generations: 0 });
});

test('explicit reuse verifies the exact selected Cloud project and returns secrets only through targetValues', async t => {
  const h = await setup(t);
  const settings = await h.definition.settings(h.host);
  const result = await settings.actions['music.import-adc']({}, undefined, h.call);
  assert.equal(result.data.status, 'connected');
  assert.equal(JSON.parse(result.targetValues.googleCredentials).refresh_token, 'fixture-grant');
  assert.equal(JSON.stringify(result.data).includes('fixture-grant'), false);
  assert.deepEqual(h.counters, { imports: 1, checks: 1, generations: 0 });
  h.config.set('projectId', 'project-two');
  const mismatch = await settings.actions['music.import-adc']({}, undefined, h.call);
  assert.equal(mismatch.targetValues, undefined);
  assert.equal(mismatch.data.code, 'oauth_project_mismatch');
});

test('an expired owner operation cannot commit credentials after an awaited check', async t => {
  let valid = true;
  const h = await setup(t, { verifyConnection: async () => { valid = false; return { projectId: 'project-one', billingEnabled: true, vertexEnabled: true }; } });
  const call = { assertCurrent: async () => { if (!valid) throw new Error('request ended'); } };
  const settings = await h.definition.settings(h.host);
  await assert.rejects(settings.actions['music.import-adc']({}, undefined, call), /request ended/);
  assert.equal(h.counters.generations, 0);
});

test('enable validates the managed credential, never imports ambient ADC or generates', async t => {
  const h = await setup(t);
  await assert.rejects(h.definition.start(h.host), /configuration_required/);
  h.secrets.set('googleCredentials', JSON.stringify(grant()));
  const runtime = await h.definition.start(h.host);
  t.after(() => runtime.stop({ reason: 'test' }));
  assert.equal(h.counters.imports, 0);
  assert.equal(h.counters.checks, 1);
  assert.equal(h.counters.generations, 0);
  await assert.rejects(runtime.actions['music.generate']({ prompt: 'Quiet piano' }, { ...h.action, outputOperation: undefined }), /host_output_required/);
  assert.equal(h.counters.generations, 0);
});

test('one admitted operation retains its audio and provenance across module reconstruction', async t => {
  const h = await setup(t);
  h.secrets.set('googleCredentials', JSON.stringify(grant()));
  const runtime = await h.definition.start(h.host);
  const input = { prompt: 'Quiet piano', instrumental: true };
  const begun = await runtime.actions['music.generate'](input, h.action);
  assert.equal(begun.state, 'pending');
  await runtime.actions['music.generate'](input, h.action);
  await runtime.drain();
  const result = await runtime.actions['music.result']({}, h.action);
  assert.equal(result.state, 'produced');
  assert.equal(result.media.mimeType, 'audio/mpeg');
  assert.equal(result.provenance.cost.actualChargedUsd, null);
  assert.equal(result.provenance.cost.creditDeductionVerified, false);
  assert.equal(JSON.stringify(result).includes('fixture-grant'), false);
  assert.equal(h.counters.generations, 1);
  const chunks = [];
  for await (const chunk of runtime.streams.read(result.media.reference)) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), 'ID3fixture-audio');
  await runtime.stop({ reason: 'upgrade' });
  const next = await h.definition.start(h.host);
  t.after(() => next.stop({ reason: 'test' }));
  assert.deepEqual(await next.actions['music.result']({}, h.action), result);
  assert.equal(h.counters.generations, 1);
  await assert.rejects(next.actions['music.generate']({ prompt: 'Different request' }, h.action), /operation_conflict/);
  assert.equal(h.counters.generations, 1);
  await assert.rejects(async () => { for await (const _ of next.streams.read('pmr_music_unknown')) {} }, /media_unavailable/);
});

test('a lost provider result remains unknown and repeated actions never redispatch it', async t => {
  const h = await setup(t, { generate: async () => { h.counters.generations++; throw new Error('private upstream diagnostic'); } });
  h.secrets.set('googleCredentials', JSON.stringify(grant()));
  const runtime = await h.definition.start(h.host);
  const input = { prompt: 'Soft strings' };
  await runtime.actions['music.generate'](input, h.action);
  await runtime.drain();
  const first = await runtime.actions['music.result']({}, h.action);
  assert.equal(first.state, 'generation_unknown');
  assert.equal(JSON.stringify(first).includes('private upstream'), false);
  await runtime.actions['music.generate'](input, h.action);
  assert.equal(h.counters.generations, 1);
  await runtime.stop({ reason: 'disable' });
  await assert.rejects(runtime.actions['music.generate'](input, h.action), /plugin_stopped/);
  assert.equal(h.counters.generations, 1);
});
test('a restart after durable audio but before its result record recovers delivery without generation', async t => {
  const h = await setup(t);
  h.secrets.set('googleCredentials', JSON.stringify(grant()));
  const runtime = await h.definition.start(h.host);
  await runtime.actions['music.generate']({ prompt: 'Piano' }, h.action);
  await runtime.drain();
  const [id] = await readdir(join(h.dataPath, 'music-jobs'));
  await unlink(join(h.dataPath, 'music-jobs', id, 'result.json'));
  await runtime.stop({ reason: 'restart' });
  const next = await h.definition.start(h.host);
  t.after(() => next.stop({ reason: 'test' }));
  const result = await next.actions['music.result']({}, h.action);
  assert.equal(result.state, 'produced');
  assert.equal(result.provenance.recoveredFromRetainedAudio, true);
  assert.equal(result.provenance.providerResponseId, undefined);
  assert.equal(h.counters.generations, 1);
});
