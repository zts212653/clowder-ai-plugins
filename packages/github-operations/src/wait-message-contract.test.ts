import assert from 'node:assert/strict';
import test from 'node:test';
import { validateMessagingRowInput } from '@clowder-ai/plugin-contract';
import { deliverConnectorMessage } from './business/domains/github-signals/wait-ports.js';

for (const length of [80, 150, 250]) test(`notification key length ${length} satisfies the actual message contract and remains replay-stable`, async () => {
  const sent: any[] = [];
  const input = { threadId: 'thread', userId: 'owner', catId: 'cat', content: 'GitHub changed',
    idempotencyKey: 'k'.repeat(length), source: { connector: 'github-wait', label: 'GitHub', icon: 'github', url: 'https://github.com/org/repo/issues/1', meta: {} } };
  const deps = { messaging: { send: async (draft: any) => { sent.push(draft); return { messageId: 'message', threadId: 'thread' }; } } };
  await deliverConnectorMessage(deps, input); await deliverConnectorMessage(deps, input);
  const value = { address: { kind: 'thread_handle', handle: 'fixture-handle' }, idempotencyKey: sent[0].idempotencyKey, payload: sent[0].payload };
  const checked = validateMessagingRowInput('messaging.send', value);
  assert.equal(checked.valid, true, JSON.stringify(checked));
  assert.deepEqual(sent[0], sent[1]);
  if (length <= 128) assert.equal(sent[0].payload.elements[0].elementId, input.idempotencyKey);
  if (length <= 200) assert.equal(sent[0].idempotencyKey, input.idempotencyKey, 'previously valid delivery keys retain their receipt identity');
});
