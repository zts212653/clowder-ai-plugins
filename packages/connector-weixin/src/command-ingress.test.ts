import assert from 'node:assert/strict';
import test from 'node:test';
import { connectorCommandFacts } from './command-ingress.js';
import type { WeixinHostInboundMessage } from './runtime.js';

const message: WeixinHostInboundMessage = { externalConversationId: 'group-looking-id', providerMessageId: 'provider-event', text: '/where', externalSenderId: 'admin' };
test('weixin command normalization preserves explicit provider identity and event key', () => {
  assert.deepEqual(connectorCommandFacts(message), { chatId: 'group-looking-id', providerMessageId: 'provider-event', text: '/where', group: false, senderId: 'admin' });
});
test('weixin remains direct-only at the existing provider support boundary', () => {
  assert.equal(connectorCommandFacts({ ...message, externalConversationId: 'group:fake' }).group, false);
});
