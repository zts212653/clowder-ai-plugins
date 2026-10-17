import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createInteractionDraftClient } from './interaction-client.mjs';

const action = JSON.parse(readFileSync(new URL('../../plugin-contract/drafts/fixtures/valid-action.json', import.meta.url)));

test('draft client forwards current FeatureBinding without accepting a plugin-chosen target', async () => {
  const binding = { pluginInstanceId: 'instance-1', featureId: 'board', executionLease: 'lease-9' };
  const accepted = new Map();
  let starts = 0;
  const host = {
    async openCurrentSelection(value) {
      assert.equal(value, binding);
      return { sessionHandle: 'session-alpha', bindingGeneration: 'binding-7' };
    },
    async acceptConfirmedAction(value, session, input) {
      assert.equal(value, binding);
      assert.equal(session.sessionHandle, 'session-alpha');
      if (input.confirmationHandle !== 'proof-001') throw new Error('unissued Host proof');
      const prior = accepted.get(input.actionId);
      if (prior && prior !== input.operationDigest) throw new Error('action content conflict');
      if (!prior) { accepted.set(input.actionId, input.operationDigest); starts++; }
      return { receiptId: 'receipt-1', status: 'accepted' };
    },
  };
  const client = createInteractionDraftClient(binding, host);
  await assert.rejects(() => client.acceptConfirmedAction(action), /no Host session/);
  await client.openCurrentSelection();
  assert.equal((await client.acceptConfirmedAction(action)).status, 'accepted');
  assert.equal((await client.acceptConfirmedAction(action)).receiptId, 'receipt-1');
  assert.equal(starts, 1);
  await assert.rejects(() => client.acceptConfirmedAction({ ...action, sessionHandle: 'other-session' }), /cross-session/);
  await assert.rejects(() => client.acceptConfirmedAction({ ...action, runtimeLease: 'lease-old' }), /stale/);
  await assert.rejects(() => client.acceptConfirmedAction({ ...action, confirmationHandle: 'made-up' }), /unissued/);
  await assert.rejects(() => client.acceptConfirmedAction({ ...action, operationDigest: 'c'.repeat(64) }), /content conflict/);
});
