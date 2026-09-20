import assert from 'node:assert/strict';
import test from 'node:test';

import { DingTalkAdapter } from './DingTalkAdapter.js';
import type { ConnectorLogger } from './types.js';

const noop = () => undefined;
const logger: ConnectorLogger = { info: noop, warn: noop, error: noop, debug: noop };

function adapter() {
  return new DingTalkAdapter(logger, { appKey: 'app-key', appSecret: 'app-secret' });
}

test('parses direct and group text while preserving provider routing facts', () => {
  const subject = adapter();
  assert.deepEqual(subject.parseEvent({
    msgtype: 'text',
    conversationType: '1',
    conversationId: 'conversation-1',
    msgId: 'message-1',
    senderStaffId: 'staff-1',
    text: { content: '  hello  ' },
  }), {
    chatId: 'staff-1',
    conversationId: 'conversation-1',
    text: 'hello',
    messageId: 'message-1',
    senderId: 'staff-1',
    chatType: 'p2p',
    senderNick: undefined,
    conversationTitle: undefined,
  });
  const group = subject.parseEvent({
    msgtype: 'text',
    conversationType: '2',
    conversationId: 'conversation-group',
    openConversationId: 'open-group-1',
    conversationTitle: 'Project',
    msgId: 'message-2',
    senderStaffId: 'staff-2',
    senderNick: 'Alice',
    text: { content: 'group hello' },
  });
  assert.equal(group?.chatId, 'open-group-1');
  assert.equal(group?.chatType, 'group');
  assert.equal(subject.resolveSenderName('staff-2'), 'Alice');
  assert.equal(subject.resolveConversationTitle('open-group-1'), 'Project');
});

test('parses rich text and media without inventing unsupported content', () => {
  const subject = adapter();
  const rich = subject.parseEvent({
    msgtype: 'richText',
    conversationType: '1',
    conversationId: 'conversation-1',
    msgId: 'message-1',
    senderStaffId: 'staff-1',
    richText: [{ text: 'look ' }, { type: 'picture', downloadCode: 'download-1' }],
  });
  assert.equal(rich?.text, 'look ');
  assert.deepEqual(rich?.attachments, [{ type: 'image', downloadCode: 'download-1' }]);
  assert.equal(subject.parseEvent({ msgtype: 'interactive', conversationType: '1' }), null);
  assert.equal(subject.parseEvent({ msgtype: 'text', conversationType: '3', text: { content: 'x' } }), null);
});

test('group replies mention only the authenticated sender metadata supplied by Host', async () => {
  const subject = adapter();
  const calls: Array<{ chatId: string; content: string; msgType: string; chatType?: 'p2p' | 'group' }> = [];
  subject._injectSendMessage(async input => {
    calls.push(input);
  });

  await subject.sendReply('open-group-1', 'answer', {
    chatType: 'group',
    replyToSender: { id: 'staff-2', name: 'Alice' },
  });
  await subject.sendReply('staff-1', 'direct answer', {
    chatType: 'p2p',
    replyToSender: { id: 'staff-1', name: 'Bob' },
  });

  assert.match(calls[0]?.content ?? '', /@Alice answer/);
  assert.equal(calls[0]?.chatType, 'group');
  assert.doesNotMatch(calls[1]?.content ?? '', /@Bob/);
  assert.equal(calls[1]?.chatType, 'p2p');
});

test('AI Card failure falls back to one markdown send', async () => {
  const subject = adapter();
  subject.parseEvent({
    msgtype: 'text',
    conversationType: '1',
    conversationId: 'conversation-1',
    msgId: 'message-1',
    senderStaffId: 'staff-1',
    text: { content: 'seed' },
  });
  subject._injectCreateCard(async () => {
    throw new Error('provider unavailable');
  });
  const sends: string[] = [];
  subject._injectSendMessage(async input => {
    sends.push(input.msgType);
  });

  await subject.sendFormattedReply('staff-1', {
    header: 'Cat',
    body: 'Answer',
    origin: 'direct',
  });
  assert.deepEqual(sends, ['markdown']);
});

test('group routing is learned only from authenticated provider metadata in the live session', async () => {
  const subject = adapter();
  subject.parseEvent({
    msgtype: 'text',
    conversationType: '2',
    conversationId: 'conversation-group',
    openConversationId: 'open-group-current',
    msgId: 'message-1',
    senderStaffId: 'staff-1',
    text: { content: 'hello' },
  });
  const calls: Array<{ chatType?: 'p2p' | 'group' }> = [];
  subject._injectSendMessage(async input => {
    calls.push(input);
  });
  await subject.sendReply('open-group-current', 'current');
  assert.equal(calls[0]?.chatType, 'group');
});

test('start and stop use the injected DingTalk stream SDK only through explicit lifecycle calls', async () => {
  const subject = adapter();
  await subject.stopStream();
  assert.equal(subject.connectorId, 'dingtalk');
});

// N5: startStream must not report success over a dead connection. The fake
// module replaces the dynamic `dingtalk-stream` import; the short timeout is
// injected through DingTalkAdapterOptions instead of fake timers.
function fakeStreamModule(options: {
  connect?: (client: { connected: boolean; registered: boolean }) => void;
}): {
  module: ConstructorParameters<typeof DingTalkAdapter.prototype._injectStreamModule>[0];
  configs: Array<Record<string, unknown>>;
  instances: Array<{ connected: boolean; registered: boolean }>;
} {
  const configs: Array<Record<string, unknown>> = [];
  const instances: Array<{ connected: boolean; registered: boolean }> = [];
  class FakeDWClient {
    connected = false;
    registered = false;
    constructor(config: Record<string, unknown>) {
      configs.push(config);
      instances.push(this);
    }
    registerCallbackListener() { /* noop */ }
    async connect() {
      options.connect?.(this);
    }
    disconnect() {
      this.connected = false;
      this.registered = false;
    }
    socketCallBackResponse() { /* noop */ }
  }
  return {
    module: {
      DWClient: FakeDWClient as never,
      EventAck: { SUCCESS: 'SUCCESS' },
      TOPIC_ROBOT: 'TOPIC_ROBOT',
    },
    configs,
    instances,
  };
}

test('startStream rejects when the socket never becomes connected and registered', async () => {
  const subject = new DingTalkAdapter(logger, {
    appKey: 'app-key',
    appSecret: 'app-secret',
    streamConnectTimeoutMs: 120,
  });
  const fake = fakeStreamModule({});
  subject._injectStreamModule(fake.module);
  await assert.rejects(
    subject.startStream(async () => undefined),
    /timed out/u,
  );
  assert.equal(subject.isStreamLive(), false);
  assert.equal(fake.instances[0]?.connected, false);
});

test('startStream rejects when connected but the robot never registers', async () => {
  const subject = new DingTalkAdapter(logger, {
    appKey: 'app-key',
    appSecret: 'app-secret',
    streamConnectTimeoutMs: 120,
  });
  const fake = fakeStreamModule({
    connect(client) {
      client.connected = true; // socket open, REGISTERED frame never arrives
    },
  });
  subject._injectStreamModule(fake.module);
  await assert.rejects(
    subject.startStream(async () => undefined),
    /timed out/u,
  );
  assert.equal(subject.isStreamLive(), false);
});

test('startStream resolves and reports live once connected and registered', async () => {
  const subject = new DingTalkAdapter(logger, {
    appKey: 'app-key',
    appSecret: 'app-secret',
    streamConnectTimeoutMs: 5_000,
  });
  const fake = fakeStreamModule({
    connect(client) {
      client.connected = true;
      client.registered = true;
    },
  });
  subject._injectStreamModule(fake.module);
  await subject.startStream(async () => undefined);
  assert.equal(subject.isStreamLive(), true);
  // keepAlive:true is required: with the SDK default (false) its ping/pong
  // watchdog is never installed, and the connector could not trust a
  // half-dead socket to be terminated.
  assert.equal(fake.configs[0]?.keepAlive, true);
  await subject.stopStream();
  assert.equal(subject.isStreamLive(), false);
});
