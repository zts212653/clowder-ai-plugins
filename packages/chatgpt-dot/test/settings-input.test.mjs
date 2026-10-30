import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDotPlugin } from '../src/plugin-entrypoint.ts';
import { fixture } from './fixture.mjs';

test('prepare accepts the Host operation envelope and cannot be used to force a reconnect', async (t) => {
  const f = fixture(t);
  const settings = await createDotPlugin({ sendWebhook: f.sendWebhook }).settings(f.host);
  t.after(() => settings.dispose());
  const params = { input: { webhookProxyUrl: '' }, operationState: { currentAction: 'status', updatedAt: 1 } };
  const first = (await settings.actions['dot.begin'](params, undefined, f.owner)).data;
  assert.equal(first.external.endpoint, f.host.external.endpoint);
  assert.equal(first.external.token, f.host.external.token);
  assert.ok(first.pairingCode);
  const repeated = (await settings.actions['dot.begin'](params, undefined, f.owner)).data;
  assert.equal(repeated.attemptId, first.attemptId);
  // Only the separately declared, owner-confirmed reconnect action may rotate a pairing.
  for (const input of [{ reconnect: true }, { input: { reconnect: true } }]) {
    const result = (await settings.actions['dot.begin'](input, undefined, f.owner)).data;
    assert.equal(result.attemptId, first.attemptId);
  }
  const renewed = (await settings.actions['dot.reconnect'](params, undefined, f.owner)).data;
  assert.notEqual(renewed.attemptId, first.attemptId);
});
