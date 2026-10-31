import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDotPlugin } from '../src/plugin-entrypoint.ts';
import { fixture } from './fixture.mjs';

test('prepare accepts the Host operation envelope and cannot be used to force a reconnect', async (t) => {
  const f = fixture(t);
  const settings = await createDotPlugin({ sendWebhook: f.sendWebhook }).settings(f.host);
  t.after(() => settings.dispose());
  const params = { input: { webhookProxyUrl: '' }, operationState: { currentAction: 'status', updatedAt: 1 } };
  const first = await settings.actions['dot.begin'](params, undefined, f.owner);
  assert.equal(first.render, 'rows');
  assert.equal(JSON.stringify(first).includes(f.host.external.token), false);
  const firstState = structuredClone(f.records.get('dot/connection/v1').value);
  assert.ok(firstState.pairingCode);
  await settings.actions['dot.begin'](params, undefined, f.owner);
  const repeated = structuredClone(f.records.get('dot/connection/v1').value);
  assert.equal(repeated.attemptId, firstState.attemptId);
  // Only the separately declared, owner-confirmed reconnect action may rotate a pairing.
  for (const input of [{ reconnect: true }, { input: { reconnect: true } }]) {
    await settings.actions['dot.begin'](input, undefined, f.owner);
    assert.equal(f.records.get('dot/connection/v1').value.attemptId, firstState.attemptId);
  }
  const renewed = (await settings.actions['dot.reconnect'](params, undefined, f.owner)).data;
  assert.notEqual(renewed.attemptId, firstState.attemptId);
});

test('shared confirmation is rendered byte-for-byte and the selected proposal ref reaches the fixed bind port', async (t) => {
  const f = fixture(t);
  const presentation = {
    key: 'proposal-a',
    label: 'Connect existing cloud link',
    detail: 'Tools (1): dot_read; events (1): dot.summoned',
    actions: [
      {
        action: 'bind-shared',
        label: 'Connect',
        confirm: 'Connect this exact surface?',
        input: { proposalRef: 'proposal-a' },
      },
    ],
  };
  let bound;
  f.host.external.shared = {
    status: async () => ({ state: 'unbound' }),
    prepare: async () => ({
      proposalRef: 'proposal-a',
      expiresAt: 100,
      presentation,
      connection: { state: 'pending' },
    }),
    bind: async (proposalRef) => {
      bound = proposalRef;
      return { state: 'active', endpoint: '/mcp', principal: 'gpt-pro', revision: 1, scope: { tools: 1, events: 1 } };
    },
    unbind: async () => assert.fail('unexpected unbind'),
  };
  const settings = await createDotPlugin({ sendWebhook: f.sendWebhook }).settings(f.host);
  t.after(() => settings.dispose());

  const prepared = await settings.actions['dot.begin']({}, undefined, f.owner);
  assert.deepEqual(prepared, { render: 'rows', data: { rows: [presentation] } });
  assert.equal(JSON.stringify(prepared).includes(f.host.external.token), false);
  const connected = await settings.actions['dot.bind-shared'](
    { input: { proposalRef: 'proposal-a' } },
    undefined,
    f.owner,
  );
  assert.equal(bound, 'proposal-a');
  assert.equal(connected.data.state, 'active');
  assert.match(connected.data.instructions, /pairing_code=/);
});

test('owner disconnect revokes the approved shared slot before revoking the Dot pairing', async (t) => {
  const f = fixture(t);
  const calls = [];
  f.host.external.shared = {
    status: async () => ({
      state: 'active', endpoint: '/mcp', principal: 'gpt-pro', revision: 7, scope: { tools: 4, events: 1 },
    }),
    prepare: async () => ({
      proposalRef: '',
      expiresAt: 0,
      presentation: { key: 'already-bound', label: 'Connected', detail: 'Shared connection active.', actions: [] },
      connection: {
        state: 'active', endpoint: '/mcp', principal: 'gpt-pro', revision: 7, scope: { tools: 4, events: 1 },
      },
    }),
    bind: async () => assert.fail('unexpected bind'),
    unbind: async (revision) => {
      calls.push({ kind: 'unbind', revision });
      return { state: 'revoked', endpoint: '/mcp', principal: 'gpt-pro', revision: 8, scope: { tools: 0, events: 0 } };
    },
  };
  const settings = await createDotPlugin({ sendWebhook: f.sendWebhook }).settings(f.host);
  t.after(() => settings.dispose());
  await settings.actions['dot.begin']({}, undefined, f.owner);
  const original = f.host.storage.compareAndSet.bind(f.host.storage);
  f.host.storage.compareAndSet = async (...args) => {
    calls.push({ kind: 'pairing-revoked' });
    return original(...args);
  };

  await settings.actions['dot.disconnect']({}, undefined, f.owner);

  assert.deepEqual(calls, [
    { kind: 'unbind', revision: 7 },
    { kind: 'pairing-revoked' },
  ]);
});
