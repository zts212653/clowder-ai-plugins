import assert from 'node:assert/strict';
import test from 'node:test';
import { connectorCommandFacts } from './command-ingress.js';
import type { WeComAgentHostInboundMessage } from './runtime.js';

const message: WeComAgentHostInboundMessage = { externalConversationId: 'group-looking-id', providerMessageId: 'provider-event', text: '/where', externalSenderId: 'admin' };
test('wecom-agent command normalization preserves explicit provider identity and event key', () => {
  assert.deepEqual(connectorCommandFacts(message), { chatId: 'group-looking-id', providerMessageId: 'provider-event', text: '/where', group: false, senderId: 'admin' });
});
test('wecom-agent remains direct-only at the existing provider support boundary', () => {
  assert.equal(connectorCommandFacts({ ...message, externalConversationId: 'group:fake' }).group, false);
});
