import assert from 'node:assert/strict';
import test from 'node:test';

import { WeComBotAdapter } from './WeComBotAdapter.js';
import type { ConnectorLogger } from './types.js';

const noop = () => undefined;
const logger: ConnectorLogger = { info: noop, warn: noop, error: noop, debug: noop };

function adapter(options: ConstructorParameters<typeof WeComBotAdapter>[1] = {
  botId: 'bot-id',
  secret: 'bot-secret',
}) {
  return new WeComBotAdapter(logger, options);
}

test('parses direct and group messages while keeping provider routing facts', () => {
  const subject = adapter();
  assert.deepEqual(subject.parseEvent({
    headers: { req_id: 'request-direct' },
    body: {
      msgtype: 'text',
      chattype: 'single',
      from: { userid: 'user-1' },
      msgid: 'message-1',
      text: { content: ' hello ' },
    },
  }), {
    chatId: 'user-1',
    text: 'hello',
    messageId: 'message-1',
    senderId: 'user-1',
    chatType: 'p2p',
  });
  assert.deepEqual(subject.parseEvent({
    headers: { req_id: 'request-group' },
    body: {
      msgtype: 'text',
      chattype: 'group',
      chatid: 'group-1',
      from: { userid: 'user-2' },
      msgid: 'message-2',
      text: { content: '@bot hello group' },
    },
  }), {
    chatId: 'group-1',
    text: 'hello group',
    messageId: 'message-2',
    senderId: 'user-2',
    chatType: 'group',
  });
  assert.ok(subject._getGroupChatIds().has('group-1'));
});

test('proactive replies preserve the Host-selected external chat destination', async () => {
  const subject = adapter();
  const calls: Array<{ chatId: string; body: Record<string, unknown> }> = [];
  subject._injectSendMessage(async (chatId, body) => {
    calls.push({ chatId, body });
  });
  await subject.sendReply('user-1', 'hello');
  assert.deepEqual(calls, [{
    chatId: 'user-1',
    body: { msgtype: 'markdown', markdown: { content: 'hello' } },
  }]);
});

test('frame-bound stream is explicitly finished and removed during settlement', async () => {
  const subject = adapter();
  const calls: Array<{ streamId: string; content: string; finish?: boolean }> = [];
  subject._setLastFrame('user-1', { headers: { req_id: 'request-1' } });
  subject._injectGenerateReqId(() => 'stream-1');
  subject._injectReplyStream(async (_frame, streamId, content, finish) => {
    calls.push({ streamId, content, finish });
  });
  const streamId = await subject.sendPlaceholder('user-1', 'thinking');
  assert.equal(streamId, 'stream-1');
  assert.equal(subject._getActiveStreams().size, 1);
  await subject.deleteMessage(streamId);
  assert.deepEqual(calls.map(call => call.finish), [false, true]);
  assert.equal(subject._getActiveStreams().size, 0);
});

test('drain clears stale provider frames and active streams', async () => {
  const subject = adapter();
  subject._setLastFrame('user-1', { headers: { req_id: 'request-1' } });
  subject._injectGenerateReqId(() => 'stream-1');
  subject._injectReplyStream(async () => undefined);
  await subject.sendPlaceholder('user-1', 'thinking');
  assert.equal(subject._getActiveStreams().size, 1);
  await subject.stopStream();
  assert.equal(subject._getActiveStreams().size, 0);
  assert.equal(subject.getConnectionState(), 'disconnected');
});

test('drain clears stale state even when provider disconnect rejects', async () => {
  const subject = adapter();
  subject._setLastFrame('user-1', { headers: { req_id: 'request-1' } });
  subject._injectGenerateReqId(() => 'stream-1');
  subject._injectReplyStream(async () => undefined);
  await subject.sendPlaceholder('user-1', 'thinking');
  const internal = subject as unknown as {
    stopFn: (() => Promise<void>) | null;
    wsClient: unknown;
  };
  internal.stopFn = async () => {
    throw new Error('provider disconnect failed');
  };
  internal.wsClient = { connected: true };

  await assert.rejects(() => subject.stopStream(), /provider disconnect failed/u);
  assert.equal(subject._getActiveStreams().size, 0);
  assert.equal(subject.getConnectionState(), 'disconnected');
  assert.equal(internal.stopFn, null);
  assert.equal(internal.wsClient, null);
});

test('provider disconnect during drain cannot re-arm the reconnect timer', async () => {
  const subject = adapter();
  const internal = subject as unknown as {
    stopFn: (() => Promise<void>) | null;
    reconnectTimer: ReturnType<typeof setTimeout> | null;
    scheduleReconnect(client: { connect(): void }): void;
  };
  const client = { connect() {} };
  internal.stopFn = async () => {
    internal.scheduleReconnect(client);
  };

  await subject.stopStream();

  assert.equal(internal.reconnectTimer, null);
});
