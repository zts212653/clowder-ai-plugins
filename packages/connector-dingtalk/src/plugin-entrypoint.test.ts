import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { ModulePluginHostShape } from '@clowder-ai/plugin-sdk';
import { parse } from 'yaml';

import moduleEntrypoint, { createDingTalkPluginModule } from './plugin-entrypoint.js';
import { DingTalkAdapter } from './DingTalkAdapter.js';
import type { DingTalkConnectorRuntime, DingTalkHostInboundMessage } from './runtime.js';

const manifest = parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8')) as unknown;

function delivery() {
  return {
    deliveryId: 'delivery-1', threadId: 'thread-1',
    presentation: { actor: { displayName: 'Cat', emoji: '🐱' }, thread: { shortId: 'thread-1' } },
    envelope: {
      messageId: 'message-1', revision: 1, threadId: 'thread-1',
      actor: { kind: 'cat', id: 'cat-1' }, audience: { kind: 'public' }, occurredAt: '2026-09-22T00:00:00.000Z',
      payload: { provenance: { origin: { kind: 'host' }, epistemicStatus: 'observation' }, elements: [{ elementId: 'text-1', kind: 'text', payload: { text: 'hello' } }] },
    },
  };
}

test('default export is the deterministic package module entrypoint', () => {
  assert.equal(typeof moduleEntrypoint.create(manifest).start, 'function');
});

test('module bridges provider ingress and Host subscription egress without connector authority', async () => {
  const calls: Array<{ operation: string; value: unknown }> = [];
  let inbound!: (message: DingTalkHostInboundMessage) => Promise<void>;
  const outbound = {
    async sendFormattedReply(...args: unknown[]) { calls.push({ operation: 'provider.send', value: args }); },
    async sendMedia() {}, async sendReply() {},
  } as unknown as DingTalkAdapter;
  const entrypoint = createDingTalkPluginModule((options) => {
    inbound = options.host.deliver;
    return { outbound, async start() {}, async stop() {} } as DingTalkConnectorRuntime<DingTalkAdapter>;
  });
  const host: ModulePluginHostShape = {
    config: { get: async () => 'app-key' }, secrets: { get: async () => 'app-secret' },
    storage: {} as never, tasks: {} as never,
    media: { read: async input => ({ offset: input.offset, dataBase64: '', done: true }) },
    threads: {
      listBindings: async () => [{ key: 'chat-1', threadId: 'thread-1', createdAt: 1 }],
      ensureByKey: async (key: string) => ({ id: 'thread-1', title: key, createdAt: 1, lastActiveAt: 1 }),
    } as never,
    messaging: {
      subscribe: async input => { calls.push({ operation: 'subscribe', value: input }); },
      unsubscribe: async () => undefined,
      send: async input => { calls.push({ operation: 'send', value: input }); return { messageId: 'host-message-1', threadId: input.threadId }; },
    },
    log() {},
  };

  const active = await entrypoint.create(manifest).start(host);
  assert.equal(typeof active.actions['host.messaging.lifecycle'], 'function');
  await inbound({
    externalConversationId: 'chat-1',
    providerConversationId: 'provider-chat-1',
    providerMessageId: 'provider-1',
    text: 'inbound',
    chatType: 'group',
  });
  await active.actions['dingtalk.outbound']?.(delivery());
  assert.deepEqual(calls.filter(call => call.operation === 'subscribe').map(call => call.value), [
    { threadId: 'thread-1', method: 'dingtalk.outbound' },
  ]);
  const sent = calls.find(call => call.operation === 'send')?.value as Record<string, unknown>;
  assert.equal(sent.threadId, 'thread-1');
  assert.equal(sent.idempotencyKey, 'provider-1');
  assert.equal('address' in sent, false);
  assert.equal((calls.find(call => call.operation === 'provider.send')?.value as unknown[])[0], 'chat-1');
  await assert.rejects(async () => active.actions['dingtalk.outbound']?.({ ...delivery(), externalConversationId: 'forbidden' }), /unsupported field/);
  await active.stop();
});

test('lifecycle action drives DingTalk placeholder updates and cleanup through the adapter', async () => {
  const calls: unknown[][] = [];
  const state = new Map<string, { revision: number; value: unknown }>();
  const outbound = {
    async sendPlaceholder(...args: unknown[]) { calls.push(['placeholder', ...args]); return 'card-1'; },
    async editMessage(...args: unknown[]) { calls.push(['edit', ...args]); return true; },
    async sendReply(...args: unknown[]) { calls.push(['reply', ...args]); },
    async deleteMessage(...args: unknown[]) { calls.push(['delete', ...args]); },
  } as unknown as DingTalkAdapter;
  const entrypoint = createDingTalkPluginModule(() => ({
    outbound, async start() {}, async stop() {},
  }) as DingTalkConnectorRuntime<DingTalkAdapter>);
  const host: ModulePluginHostShape = {
    config: { get: async () => 'app-key' }, secrets: { get: async () => 'app-secret' },
    storage: {
      get: async key => state.get(key), list: async () => Object.fromEntries(state),
      set: async (key, value) => { const revision = (state.get(key)?.revision ?? 0) + 1; state.set(key, { revision, value }); return { revision }; },
      compareAndSet: async () => ({ applied: false }), delete: async key => ({ deleted: state.delete(key) }),
    }, tasks: {} as never,
    media: { read: async input => ({ offset: input.offset, dataBase64: '', done: true }) },
    threads: {
      listBindings: async () => [{ key: 'chat-1', threadId: 'thread-1', createdAt: 1 }],
      ensureByKey: async () => ({ id: 'thread-1' }),
    } as never,
    messaging: { subscribe: async () => undefined, unsubscribe: async () => undefined, send: async input => ({ messageId: 'message-1', threadId: input.threadId }) },
    log() {},
  };
  const active = await entrypoint.create(manifest).start(host);
  const action = active.actions['host.messaging.lifecycle']!;
  await action({
    lifecycleId: 'life-1', deliveryId: 'delivery-1', threadId: 'thread-1', state: 'started',
    presentation: { actor: { displayName: '砚砚', emoji: '🐱' }, thread: { shortId: 'thread-1' } },
  });
  await action({ lifecycleId: 'life-1', deliveryId: 'delivery-2', threadId: 'thread-1', state: 'catching_up' });
  await action({
    lifecycleId: 'life-1', deliveryId: 'delivery-3', threadId: 'thread-1', state: 'settled', chainDone: true, outcome: 'completed',
  });
  assert.deepEqual(calls, [
    ['placeholder', 'chat-1', '【砚砚🐱】🤔 思考中...'],
    ['edit', 'chat-1', 'card-1', '🔄 收到新消息，正在重新整理回复…', { bypassThrottle: false }],
    ['delete', 'card-1', undefined],
  ]);
  await active.stop();
});

test('blocked then settled keeps the DingTalk recovery card visible and finishes it with the same text', async () => {
  const updates: Array<{ content: string; state: string }> = [];
  const outbound = new DingTalkAdapter(
    { info() {}, warn() {}, error() {}, debug() {} },
    { appKey: 'app-key', appSecret: 'app-secret' },
  );
  outbound._injectCreateCard(async () => undefined);
  outbound._injectStreamingCard(async ({ content, state }) => { updates.push({ content, state }); });
  outbound.parseEvent({
    msgtype: 'text', conversationType: '2', conversationId: 'conversation-1',
    openConversationId: 'chat-1', msgId: 'message-1', senderStaffId: 'staff-1', text: { content: 'seed' },
  });
  const entrypoint = createDingTalkPluginModule(() => ({
    outbound, async start() {}, async stop() {},
  }) as DingTalkConnectorRuntime<DingTalkAdapter>);
  const state = new Map<string, { revision: number; value: unknown }>();
  const active = await entrypoint.create(manifest).start({
    config: { get: async () => 'app-key' }, secrets: { get: async () => 'app-secret' },
    storage: {
      get: async key => state.get(key), list: async () => Object.fromEntries(state),
      set: async (key, value) => { const revision = (state.get(key)?.revision ?? 0) + 1; state.set(key, { revision, value }); return { revision }; },
      compareAndSet: async () => ({ applied: false }), delete: async key => ({ deleted: state.delete(key) }),
    }, tasks: {} as never,
    media: { read: async input => ({ offset: input.offset, dataBase64: '', done: true }) },
    threads: { listBindings: async () => [{ key: 'chat-1', threadId: 'thread-1', createdAt: 1 }], ensureByKey: async () => ({ id: 'thread-1' }) } as never,
    messaging: { subscribe: async () => undefined, unsubscribe: async () => undefined, send: async input => ({ messageId: 'message-1', threadId: input.threadId }) },
    log() {},
  });
  const action = active.actions['host.messaging.lifecycle']!;
  await action({ lifecycleId: 'blocked-life', deliveryId: 'delivery-1', threadId: 'thread-1', state: 'started', presentation: { actor: { displayName: '砚砚', emoji: '🐱' }, thread: { shortId: 'thread-1' } } });
  await action({ lifecycleId: 'blocked-life', deliveryId: 'delivery-2', threadId: 'thread-1', state: 'blocked', reason: 'needs_user' });
  await action({ lifecycleId: 'blocked-life', deliveryId: 'delivery-3', threadId: 'thread-1', state: 'settled', chainDone: false, outcome: 'failed' });
  const recovery = '⚠️ 未能完成最新消息重读（needs_user）。请打开 Clowder AI 重试。';
  assert.deepEqual(updates, [
    { content: recovery, state: 'INPUTING' },
    { content: recovery, state: 'FINISHED' },
  ]);
  await active.stop();
});

test('inbound media is retained as a private locator and exposed through bounded media-source actions', async () => {
  const state = new Map<string, { revision: number; value: unknown }>();
  const sent: unknown[] = [];
  let sendError: unknown;
  let inbound!: (message: DingTalkHostInboundMessage) => Promise<void>;
  const outbound = {
    async downloadInboundMedia(locator: { platformKey: string }) {
      assert.equal(locator.platformKey, 'private-download-code');
      return Buffer.from('private-bytes');
    },
  } as unknown as DingTalkAdapter;
  const entrypoint = createDingTalkPluginModule((options) => {
    inbound = options.host.deliver;
    return { outbound, async start() {}, async stop() {} } as DingTalkConnectorRuntime<DingTalkAdapter>;
  });
  const host: ModulePluginHostShape = {
    config: { get: async () => 'app-key' }, secrets: { get: async () => 'app-secret' },
    storage: {
      get: async key => state.get(key),
      list: async () => Object.fromEntries(state),
      set: async (key, value) => { const revision = (state.get(key)?.revision ?? 0) + 1; state.set(key, { revision, value }); return { revision }; },
      compareAndSet: async (key, expectedRevision, value) => {
        if (expectedRevision !== null || state.has(key)) return { applied: false };
        state.set(key, { revision: 1, value });
        return { applied: true, revision: 1 };
      },
      delete: async (key, expectedRevision) => {
        const current = state.get(key);
        if (expectedRevision !== undefined && current?.revision !== expectedRevision) {
          return { deleted: false, revision: current?.revision };
        }
        return { deleted: state.delete(key), revision: current?.revision };
      },
    },
    tasks: {} as never,
    media: { read: async input => ({ offset: input.offset, dataBase64: '', done: true }) },
    threads: {
      listBindings: async () => [],
      ensureByKey: async (key: string) => ({ id: 'thread-1', title: key, createdAt: 1, lastActiveAt: 1 }),
    } as never,
    messaging: {
      subscribe: async () => undefined,
      unsubscribe: async () => undefined,
      send: async input => {
        if (sendError !== undefined) throw sendError;
        sent.push(input);
        return { messageId: 'host-message-1', threadId: input.threadId, revision: 1, messageHandle: 'handle-1', pendingPublication: true as const };
      },
    },
    log() {},
  };

  const active = await entrypoint.create(manifest).start(host);
  await inbound({
    externalConversationId: 'chat-1', providerConversationId: 'provider-chat-1', providerMessageId: 'provider-1', text: 'inbound', chatType: 'group',
    attachments: [{ type: 'image', platformKey: 'private-download-code', fileName: 'photo.png' }],
  });
  const draft = sent[0] as { sourceEventId: string; payload: { elements: Array<{ kind: string; payload: Record<string, unknown> }> } };
  const element = draft.payload.elements.find(item => item.kind === 'media_ref');
  assert.equal(draft.sourceEventId, 'provider-1');
  assert.match(String(element?.payload.reference), /^pmr_/);
  assert.equal(element?.payload.sourceId, 'dingtalk-media');
  assert.equal(JSON.stringify(draft).includes('private-download-code'), false);

  const reference = String(element?.payload.reference);
  const read = await active.actions['dingtalk.media-source.read']?.({ requestId: 'request-1', reference, offset: 0, limit: 7 });
  assert.deepEqual(read, { kind: 'chunk', requestId: 'request-1', offset: 0, dataBase64: Buffer.from('private').toString('base64'), nextOffset: 7, done: false });
  const tail = await active.actions['dingtalk.media-source.read']?.({ requestId: 'request-1', reference, offset: 7, limit: 524288 });
  assert.deepEqual(tail, { kind: 'chunk', requestId: 'request-1', offset: 7, dataBase64: Buffer.from('-bytes').toString('base64'), done: true });
  await active.actions['dingtalk.media-source.settle']?.({ requestId: 'request-1', reference, outcome: 'imported' });
  assert.equal(state.size, 0);
  assert.deepEqual(await active.actions['dingtalk.media-source.read']?.({ requestId: 'request-2', reference, offset: 0, limit: 10 }), {
    kind: 'rejected', requestId: 'request-2', code: 'MEDIA_SOURCE_UNAVAILABLE',
  });
  sendError = new Error('Host rejected draft');
  await assert.rejects(inbound({
    externalConversationId: 'chat-1', providerConversationId: 'provider-chat-1', providerMessageId: 'provider-2', text: 'failed', chatType: 'group',
    attachments: [{ type: 'image', platformKey: 'private-download-code' }],
  }), /Host rejected draft/u);
  assert.equal(state.size, 1, 'an indeterminate send failure retains the locator for an idempotent retry');

  sendError = Object.assign(new Error('Host rejected replay'), { code: 'VALIDATION' });
  await assert.rejects(inbound({
    externalConversationId: 'chat-1', providerConversationId: 'provider-chat-1', providerMessageId: 'provider-2', text: 'replay', chatType: 'group',
    attachments: [{ type: 'image', platformKey: 'private-download-code' }],
  }), /Host rejected replay/u);
  assert.equal(state.size, 1, 'a replay cannot delete the first delivery\'s locator');

  sendError = Object.assign(new Error('Host rejected new draft'), { code: 'VALIDATION' });
  await assert.rejects(inbound({
    externalConversationId: 'chat-1', providerConversationId: 'provider-chat-1', providerMessageId: 'provider-3', text: 'invalid', chatType: 'group',
    attachments: [{ type: 'image', platformKey: 'private-download-code' }],
  }), /Host rejected new draft/u);
  assert.equal(state.size, 1, 'a definitive rejection deletes only the locator inserted by that delivery');
  await active.stop();
});

function richDelivery() {
  return {
    deliveryId: 'delivery-1', threadId: 'thread-1',
    presentation: { actor: { displayName: 'Cat', emoji: '🐱' }, thread: { shortId: 'thread-1' } },
    envelope: {
      messageId: 'message-1', revision: 1, threadId: 'thread-1',
      actor: { kind: 'cat', id: 'cat-1' }, audience: { kind: 'public' }, occurredAt: '2026-09-22T00:00:00.000Z',
      payload: { provenance: { origin: { kind: 'host' }, epistemicStatus: 'observation' }, elements: [
        { elementId: 't1', kind: 'text', payload: { text: '正文' } },
        { elementId: 'u1', kind: 'media_unavailable', payload: { type: 'image', fileName: 'diagram.png', reason: 'source_expired' } },
        { elementId: 'm1', kind: 'media_ref', payload: { type: 'audio', reference: 'hmr_audio-1', fileName: 'voice.opus' } },
        { elementId: 'm2', kind: 'media_ref', payload: { type: 'image', reference: 'hmr_denied' } },
        { elementId: 'm3', kind: 'media_ref', payload: { type: 'file', reference: 'legacy-provider-key' } },
        { elementId: 'm4', kind: 'media_ref', payload: { type: 'video', reference: 'hmr_video-1' } },
        { elementId: 'm5', kind: 'media_ref', payload: { type: 'file', reference: 'hmr_large', fileName: 'large.bin' } },
        { elementId: 'w1', kind: 'media_warning', payload: { mediaElementId: 'm1', stage: 'transcription', reason: 'processing_failed' } },
        { elementId: 'r1', kind: 'rich_block', payload: { id: 'b1', kind: 'card', v: 1, title: 'T', bodyMarkdown: 'B' } },
        { elementId: 'r2', kind: 'rich_block', payload: { id: 'b2', kind: 'checklist', v: 1, title: 'L', items: [{ id: 'i1', text: 'a', checked: true }, { id: 'i2', text: 'b' }] } },
      ] },
    },
  };
}

test('rich blocks and typed media notices route to sendRichMessage instead of sendFormattedReply', async () => {
  const calls: Array<{ operation: string; value: unknown }> = [];
  const outbound = {
    async sendRichMessage(...args: unknown[]) { calls.push({ operation: 'provider.rich', value: args }); },
    async sendFormattedReply(...args: unknown[]) { calls.push({ operation: 'provider.formatted', value: args }); },
    async sendMedia(chatId: string, payload: Record<string, unknown>) {
      if (payload.fileName === 'large.bin') throw new RangeError('provider limit');
      assert.equal('url' in payload, false);
      assert.equal('absPath' in payload, false);
      assert.ok(payload.content !== undefined);
      const chunks: Buffer[] = [];
      for await (const chunk of payload.content as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
      calls.push({ operation: 'provider.media', value: [chatId, payload.type, Buffer.concat(chunks).toString(), payload.fileName] });
    },
    async sendReply(...args: unknown[]) { calls.push({ operation: 'provider.notice', value: args }); },
  } as unknown as DingTalkAdapter;
  const entrypoint = createDingTalkPluginModule(() => ({ outbound, async start() {}, async stop() {} }) as DingTalkConnectorRuntime<DingTalkAdapter>);
  const host: ModulePluginHostShape = {
    config: { get: async () => 'app-key' }, secrets: { get: async () => 'app-secret' },
    storage: {} as never, tasks: {} as never,
    media: { read: async input => input.reference === 'hmr_denied'
      ? Promise.reject(Object.assign(new Error('denied'), { name: 'MEDIA_ACCESS_DENIED' }))
      : input.offset === 0
      ? { offset: 0, dataBase64: Buffer.from('voice-').toString('base64'), done: false, nextOffset: 6 }
      : { offset: 6, dataBase64: Buffer.from('bytes').toString('base64'), done: true } },
    threads: {
      listBindings: async () => [{ key: 'chat-1', threadId: 'thread-1', createdAt: 1 }],
      ensureByKey: async (key: string) => ({ id: 'thread-1', title: key, createdAt: 1, lastActiveAt: 1 }),
    } as never,
    messaging: {
      subscribe: async () => undefined,
      unsubscribe: async () => undefined,
      send: async input => ({ messageId: 'host-message-1', threadId: input.threadId }),
    },
    log() {},
  };

  const active = await entrypoint.create(manifest).start(host);
  await active.actions['dingtalk.outbound']?.(richDelivery());
  assert.deepEqual(calls, [
    { operation: 'provider.rich', value: ['chat-1', '正文\n\n⚠️ 媒体不可用：diagram.png（来源已过期）\n\n⚠️ 媒体处理警告：voice.opus（转写处理失败）', [
      { id: 'b1', kind: 'card', v: 1, title: 'T', bodyMarkdown: 'B' },
      { id: 'b2', kind: 'checklist', v: 1, title: 'L', items: [{ id: 'i1', text: 'a', checked: true }, { id: 'i2', text: 'b' }] },
    ], 'Cat', undefined] },
    { operation: 'provider.media', value: ['chat-1', 'audio', 'voice-bytes', 'voice.opus'] },
    { operation: 'provider.notice', value: ['chat-1', '【Cat🐱】\n⚠️ 媒体不可用（读取或上传失败）', undefined] },
    { operation: 'provider.notice', value: ['chat-1', '【Cat🐱】\n⚠️ 媒体不可用（旧引用无法读取）', undefined] },
    { operation: 'provider.notice', value: ['chat-1', '【Cat🐱】\n⚠️ 视频附件暂不支持发送', undefined] },
    { operation: 'provider.notice', value: ['chat-1', '【Cat🐱】\n⚠️ 媒体过大，超过钉钉发送上限', undefined] },
  ]);
  calls.length = 0;
  const typedOnly = richDelivery();
  typedOnly.deliveryId = 'delivery-typed-only';
  typedOnly.envelope.payload.elements = typedOnly.envelope.payload.elements.filter(element => (
    element.kind === 'text' || element.kind === 'media_unavailable'
  ));
  await active.actions['dingtalk.outbound']?.(typedOnly);
  assert.deepEqual(calls.map(call => call.operation), ['provider.formatted']);
  await active.stop();
});

test('outbound rejects a delivery without presentation at the subscription boundary', async () => {
  const entrypoint = createDingTalkPluginModule(() => ({
    outbound: {} as DingTalkAdapter, async start() {}, async stop() {},
  }) as DingTalkConnectorRuntime<DingTalkAdapter>);
  const active = await entrypoint.create(manifest).start({
    config: { get: async () => 'app-key' }, secrets: { get: async () => 'app-secret' },
    storage: {} as never, tasks: {} as never,
    media: { read: async input => ({ offset: input.offset, dataBase64: '', done: true }) },
    threads: {
      listBindings: async () => [{ key: 'chat-1', threadId: 'thread-1', createdAt: 1 }],
      ensureByKey: async (key: string) => ({ id: 'thread-1', title: key, createdAt: 1, lastActiveAt: 1 }),
    } as never,
    messaging: {
      subscribe: async () => undefined, unsubscribe: async () => undefined,
      send: async input => ({ messageId: 'host-message-1', threadId: input.threadId }),
    },
    log() {},
  });
  const missing = delivery() as Record<string, unknown>;
  delete missing.presentation;
  await assert.rejects(async () => active.actions['dingtalk.outbound']?.(missing), /presentation/i);
  await active.stop();
});

test('outbound attaches replyToSender metadata from the recorded inbound mapping (group @ parity)', async () => {
  const calls: Array<{ operation: string; value: unknown }> = [];
  let inbound!: (message: DingTalkHostInboundMessage) => Promise<void>;
  const state = new Map<string, { revision: number; value: unknown }>();
  const outbound = {
    async sendFormattedReply(...args: unknown[]) { calls.push({ operation: 'provider.send', value: args }); },
    async sendMedia() {}, async sendReply() {},
  } as unknown as DingTalkAdapter;
  const entrypoint = createDingTalkPluginModule((options) => {
    inbound = options.host.deliver;
    return { outbound, async start() {}, async stop() {} } as DingTalkConnectorRuntime<DingTalkAdapter>;
  });
  const host: ModulePluginHostShape = {
    config: { get: async () => 'app-key' }, secrets: { get: async () => 'app-secret' },
    storage: {
      get: async key => state.get(key), list: async () => Object.fromEntries(state),
      set: async (key, value) => { const revision = (state.get(key)?.revision ?? 0) + 1; state.set(key, { revision, value }); return { revision }; },
      compareAndSet: async () => ({ applied: false }), delete: async key => ({ deleted: state.delete(key) }),
    },
    tasks: {} as never,
    media: { read: async input => ({ offset: input.offset, dataBase64: '', done: true }) },
    threads: {
      listBindings: async () => [{ key: 'chat-1', threadId: 'thread-1', createdAt: 1 }],
      ensureByKey: async (key: string) => ({ id: 'thread-1', title: key, createdAt: 1, lastActiveAt: 1 }),
    } as never,
    messaging: {
      subscribe: async () => undefined, unsubscribe: async () => undefined,
      send: async input => ({ messageId: 'host-message-1', threadId: input.threadId }),
    },
    log() {},
  };
  const active = await entrypoint.create(manifest).start(host);
  await inbound({
    externalConversationId: 'chat-1',
    providerConversationId: 'provider-chat-1',
    providerMessageId: 'provider-1',
    text: 'inbound',
    chatType: 'group',
    sender: { id: 'sender-1', name: 'Sender' },
  });
  const matched = delivery() as ReturnType<typeof delivery> & { envelope: { replyTo?: string } };
  matched.envelope.replyTo = 'host-message-1';
  await active.actions['dingtalk.outbound']?.(matched);
  const sent = calls.find(call => call.operation === 'provider.send')?.value as unknown[];
  assert.equal(sent[0], 'chat-1');
  assert.equal((sent[1] as { header: string }).header, 'Cat');
  assert.deepEqual(sent[2], { replyToSender: { id: 'sender-1', name: 'Sender' } });
  calls.length = 0;
  const missed = delivery() as ReturnType<typeof delivery> & { envelope: { replyTo?: string } };
  missed.deliveryId = 'delivery-2';
  missed.envelope.replyTo = 'host-unknown';
  await active.actions['dingtalk.outbound']?.(missed);
  const missedSent = calls.find(call => call.operation === 'provider.send')?.value as unknown[];
  assert.equal(missedSent[2], undefined);
  await active.stop();
});
