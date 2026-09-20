import assert from 'node:assert/strict';
import test from 'node:test';

import { FeishuAdapter } from './FeishuAdapter.js';
import type { ConnectorLogger } from './types.js';

const noop = () => undefined;
const logger: ConnectorLogger = { info: noop, warn: noop, error: noop, debug: noop };

test('parses authenticated direct text without deriving Host wake authority', () => {
  const subject = new FeishuAdapter('app-id', 'app-secret', logger, { verificationToken: 'verify-me' });
  const event = {
    header: { event_type: 'im.message.receive_v1', event_id: 'evt-001', token: 'verify-me' },
    event: {
      sender: { sender_id: { open_id: 'ou_sender_123' }, sender_type: 'user' },
      message: {
        message_id: 'om_msg_456',
        chat_id: 'oc_chat_789',
        chat_type: 'p2p',
        content: JSON.stringify({ text: '@agent ordinary provider text' }),
        message_type: 'text',
      },
    },
  };
  assert.equal(subject.verifyEventToken(event), true);
  assert.deepEqual(subject.parseEvent(event), {
    chatId: 'oc_chat_789',
    text: '@agent ordinary provider text',
    messageId: 'om_msg_456',
    senderId: 'ou_sender_123',
    chatType: 'p2p',
  });
  assert.equal(subject.verifyEventToken({ header: { token: 'wrong' } }), false);
});

test('sends configured mention aliases as provider-native mentions', async () => {
  const subject = new FeishuAdapter('app-id', 'app-secret', logger, {
    groupBotMentions: { helper: { openId: 'ou_helper', displayName: 'Helper' } },
  });
  const calls: Array<{ chatId: string; content: string; msgType: string }> = [];
  subject._injectSendMessage(async params => { calls.push(params); });
  await subject.sendReply('oc_group', '@helper inspect this');
  assert.equal(calls.length, 1);
  const payload = JSON.parse(calls[0]?.content ?? '{}') as { text?: string };
  assert.equal(payload.text, '<at user_id="ou_helper">Helper</at> inspect this');
});
