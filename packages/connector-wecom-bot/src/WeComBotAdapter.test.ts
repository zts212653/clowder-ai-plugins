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

test('formatted replies above the 112-character recommendation keep the complete media notice', async () => {
  const subject = adapter();
  const cards: unknown[] = [];
  const messages: Array<{ chatId: string; body: Record<string, unknown> }> = [];
  subject._setLastFrame('group-1', { headers: { req_id: 'request-1' } });
  subject._injectReplyTemplateCard(async (_frame, card) => { cards.push(card); });
  subject._injectSendMessage(async (chatId, body) => { messages.push({ chatId, body }); });
  const notice = '⚠️ 媒体不可用：diagram.png（无法获取）';
  const body = `${'正'.repeat(112)}\n\n${notice}`;
  assert.ok(Array.from(body).length > 112 && Array.from(body).length <= 200);

  await subject.sendFormattedReply('group-1', {
    header: 'Cat', body, origin: 'direct',
  });

  assert.deepEqual(cards, []);
  assert.equal(messages.length, 1);
  assert.equal(JSON.stringify(messages[0]).includes(notice), true);
});

test('SDK and download logging never expose media URLs or AES keys on success or failure', async () => {
  const entries: unknown[] = [];
  const recording: ConnectorLogger = {
    info: (...args) => { entries.push(args); },
    warn: (...args) => { entries.push(args); },
    error: (...args) => { entries.push(args); },
    debug: (...args) => { entries.push(args); },
  };
  const subject = new WeComBotAdapter(recording, { botId: 'bot-id', secret: 'bot-secret' });
  const internal = subject as unknown as {
    sdkLogger(): { info(message: string): void; warn(message: string): void };
  };
  const privateUrl = 'https://media.example/download?locator=private';
  const aesKey = 'private-aes-key';
  internal.sdkLogger().info(`download ${privateUrl} aeskey=${aesKey}`);
  internal.sdkLogger().warn(`body={"aeskey":"${aesKey}","url":"${privateUrl}"}`);
  subject._injectDownloadFile(async () => ({ buffer: Buffer.from('bytes'), filename: 'media.bin' }));
  await subject.downloadMedia(privateUrl, aesKey);
  subject._injectDownloadFile(async () => { throw new Error('provider failed'); });
  await assert.rejects(subject.downloadMedia(privateUrl, aesKey), /provider failed/u);

  const observable = JSON.stringify(entries);
  assert.equal(observable.includes(privateUrl), false);
  assert.equal(observable.includes(aesKey), false);
  assert.deepEqual(entries, []);
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

test('blocked lifecycle bypasses stream throttling and finishes with the recovery text', async () => {
  const subject = adapter();
  const calls: Array<{ content: string; finish?: boolean }> = [];
  subject._setLastFrame('user-1', { headers: { req_id: 'request-1' } });
  subject._injectGenerateReqId(() => 'stream-1');
  subject._injectReplyStream(async (_frame, _streamId, content, finish) => { calls.push({ content, finish }); });
  const streamId = await subject.sendPlaceholder('user-1', 'thinking');
  assert.equal(await subject.editMessage('user-1', streamId, 'recovery', { bypassThrottle: true }), true);
  await subject.deleteMessage(streamId);
  assert.deepEqual(calls, [
    { content: 'thinking', finish: false },
    { content: 'recovery', finish: false },
    { content: 'recovery', finish: true },
  ]);
  assert.equal(await subject.editMessage('user-1', streamId, 'late recovery', { bypassThrottle: true }), false);
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
