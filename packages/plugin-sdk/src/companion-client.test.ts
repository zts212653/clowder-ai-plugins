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

test('passive bubble layout stays a bounded presentation request', async () => {
  const calls: CompanionCommand[] = [];
  const client = createCompanionClient({ request: async command => {
    calls.push(command);
    return { kind: 'layout', pet: { x: 0, y: 0 }, panel: { x: 120, y: 0, width: 240, height: 80 }, width: 360, height: 130 };
  }, subscribe: () => () => {} });
  await client.layout('bubble', 240, 80);
  assert.deepEqual(calls, [{ kind: 'view.layout', panel: 'bubble', width: 240, height: 80 }]);
});

test('decision reading requests a page without a writer or owner selector', async () => {
  const calls: CompanionCommand[] = [];
  const client = createCompanionClient({ request: async command => {
    calls.push(command);
    return { kind: 'decisions', status: 'available', approvalCount: 0, needsMeCount: 0,
      otherNeedsMeCount: 0, approvals: [], otherNeedsMe: [],
      page: { offset: 0, limit: 10, hasMoreApprovals: false, hasMoreNeedsMe: false } };
  }, subscribe: () => () => {} });
  await client.readDecisions(0, 10);
  assert.deepEqual(calls, [{ kind: 'decisions.read', offset: 0, limit: 10 }]);
});

test('F221 inspection requests a Host dialog trial without an approval payload', async () => {
  const calls: CompanionCommand[] = [];
  const client = createCompanionClient({ request: async command => {
    calls.push(command); return { kind: 'decision-trial', status: 'dismissed' };
  }, subscribe: () => () => {} });
  await client.inspectF221('11111111-1111-4111-8111-111111111111');
  assert.deepEqual(calls, [{ kind: 'f221.inspect', proposalId: '11111111-1111-4111-8111-111111111111' }]);
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
