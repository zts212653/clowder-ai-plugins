import assert from 'node:assert/strict';
import test from 'node:test';
import type { CompanionCommand, CompanionReply } from '@clowder-ai/plugin-contract';
import { CompanionRequestError, createCompanionClient } from './companion-client.js';

test('companion client relays declared actions; no Host or identity arguments are constructed', async () => {
  const calls: CompanionCommand[] = [];
  const client = createCompanionClient({ request: async (command) => { calls.push(command); return { kind: 'ok' }; }, subscribe: () => () => {} });
  await client.stop(); await client.resize(true); await client.screenClose();
  assert.deepEqual(calls, [{ kind: 'stop' }, { kind: 'view.resize', expanded: true }, { kind: 'screen.close' }]);
});
test('audio controls expose no generic provider event or SDP operation', async () => {
  const calls: CompanionCommand[] = [];
  const client = createCompanionClient({ request: async command => { calls.push(command); return { kind: 'ok' }; }, subscribe: () => () => {} });
  await client.connectAudio(); await client.muteMicrophone(true); await client.muteSpeaker(false); await client.closeAudio();
  assert.deepEqual(calls, [{ kind: 'audio.connect' }, { kind: 'audio.microphone', muted: true }, { kind: 'audio.speaker', muted: false }, { kind: 'audio.close' }]);
  assert.equal('offer' in client, false);
});

test('unconfirmed text is retained for an explicit retry with the same caller id', async () => {
  const calls: CompanionCommand[] = [];
  let response: CompanionReply = { kind: 'delivery', delivery: 'unconfirmed' };
  const client = createCompanionClient({ request: async (command) => { calls.push(command); return response; }, subscribe: () => () => {} });
  const id = '863adf11-9fa3-4156-93af-94f7d6022d85';
  await assert.rejects(client.text('new thought', id), (error) => error instanceof CompanionRequestError && error.code === 'unconfirmed');
  response = { kind: 'delivery', delivery: 'accepted' };
  await client.text('new thought', id);
  assert.equal(calls.length, 2); assert.deepEqual(calls[0], calls[1]);
});

test('unexpected replies and declared errors never become apparent UI success', async () => {
  let response: CompanionReply = { kind: 'ok' };
  const client = createCompanionClient({ request: async () => response, subscribe: () => () => {} });
  await assert.rejects(client.prepare(), (error) => error instanceof CompanionRequestError && error.code === 'unavailable');
  response = { kind: 'error', code: 'permission_required' };
  await assert.rejects(client.prepare(), (error) => error instanceof CompanionRequestError && error.code === 'permission_required');
});
