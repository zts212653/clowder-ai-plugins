import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ConnectorOutboundDeliveryError,
  requireConnectorOutboundDelivery,
} from './connector-runtime.js';

const DELIVERY = {
  deliveryId: 'delivery-1',
  externalConversationId: 'provider-chat-1',
  presentation: {
    header: 'Maine Coon',
    subtitle: 'Thread title',
    body: 'hello',
    footer: 'Open in Clowder AI',
    origin: 'agent',
    cardActions: [{ label: 'Open', value: { command: 'open' } }],
  },
  richBlocks: [{ kind: 'checklist', items: [{ text: 'ship', checked: true }] }],
  media: [{ type: 'image', reference: 'https://example.test/image.png', fileName: 'image.png' }],
  metadata: { replyToProviderMessageId: 'provider-message-1' },
} as const;

test('connector delivery validates and snapshots the portable Host-to-package call', () => {
  const result = requireConnectorOutboundDelivery(DELIVERY);
  assert.deepEqual(result, DELIVERY);
  assert.notEqual(result, DELIVERY);
});

test('connector delivery rejects missing targets, open members, and malformed presentation data', () => {
  for (const input of [
    { ...DELIVERY, externalConversationId: '' },
    { ...DELIVERY, authority: 'plugin' },
    { ...DELIVERY, presentation: { ...DELIVERY.presentation, origin: 'unknown' } },
    { ...DELIVERY, media: [{ type: 'image', reference: '' }] },
  ]) {
    assert.throws(() => requireConnectorOutboundDelivery(input), ConnectorOutboundDeliveryError);
  }
});
