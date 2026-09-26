import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { ModulePluginHostShape } from '@clowder-ai/plugin-sdk';
import { parse } from 'yaml';

import moduleEntrypoint, { createTelegramPluginModule } from './plugin-entrypoint.js';
import { TelegramAdapter } from './TelegramAdapter.js';
import type { TelegramConnectorRuntime, TelegramHostInboundMessage } from './runtime.js';

const manifest = parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8')) as unknown;

function lifecycleHost(externalChatId = 'chat-1'): ModulePluginHostShape {
  const state = new Map<string, { revision: number; value: unknown }>();
  return {
    config: { get: async () => undefined }, secrets: { get: async () => 'bot-token' },
    storage: {
      get: async key => state.get(key), list: async () => Object.fromEntries(state),
      set: async (key, value) => { const revision = (state.get(key)?.revision ?? 0) + 1; state.set(key, { revision, value }); return { revision }; },
      compareAndSet: async () => ({ applied: false }), delete: async key => ({ deleted: state.delete(key) }),
    }, tasks: {} as never,
    media: { read: async input => ({ offset: input.offset, dataBase64: '', done: true }) },
    threads: {
      listBindings: async () => [{ key: externalChatId, threadId: 'thread-1', createdAt: 1 }],
      ensureByKey: async () => ({ id: 'thread-1' }),
    } as never,
    messaging: { subscribe: async () => undefined, unsubscribe: async () => undefined, send: async input => ({ messageId: 'message-1', threadId: input.threadId }) },
    log() {},
  };
}

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
  const state = new Map<string, { revision: number; value: unknown }>();
  let inbound!: (message: TelegramHostInboundMessage) => Promise<void>;
  const outbound = {
    async sendReply(...args: unknown[]) { calls.push({ operation: 'provider.send', value: args }); },
    async sendRichMessage() {}, async sendMedia() {},
  } as unknown as TelegramAdapter;
  const entrypoint = createTelegramPluginModule((options) => {
    inbound = options.host.deliver;
    return { outbound, async start() {}, async stop() {} } as TelegramConnectorRuntime<TelegramAdapter>;
  });
  const host: ModulePluginHostShape = {
    config: { get: async () => undefined }, secrets: { get: async () => 'bot-token' },
    storage: {
      get: async key => state.get(key), list: async () => Object.fromEntries(state),
      set: async (key, value) => { const revision = (state.get(key)?.revision ?? 0) + 1; state.set(key, { revision, value }); return { revision }; },
      compareAndSet: async (key, expectedRevision, value) => {
        if (expectedRevision !== null || state.has(key)) return { applied: false };
        state.set(key, { revision: 1, value });
        return { applied: true, revision: 1 };
      }, delete: async key => ({ deleted: state.delete(key) }),
    }, tasks: {} as never,
    media: { read: async input => ({ offset: input.offset, dataBase64: '', done: true }) },
    threads: {
      listBindings: async () => [{ key: 'chat-1', threadId: 'thread-1', createdAt: 1 }],
      ensureByKey: async (key: string) => ({ id: 'thread-1', title: key, createdAt: 1, lastActiveAt: 1 }),
    } as never,
    messaging: {
      subscribe: async input => { calls.push({ operation: 'subscribe', value: input }); },
      unsubscribe: async () => undefined,
      send: async input => { calls.push({ operation: 'send', value: input }); return { messageId: 'host-message-1', threadId: input.threadId, revision: 1, messageHandle: 'handle-1', pendingPublication: true as const }; },
    },
    log() {},
  };

  const active = await entrypoint.create(manifest).start(host);
  await inbound({
    externalConversationId: 'chat-1', externalSenderId: 'user-1', providerMessageId: 'provider-1', text: 'inbound',
    attachments: [{ type: 'file', platformKey: 'private-file-id', fileName: 'report.pdf' }],
  });
  await active.actions['telegram.outbound']?.(delivery());
  assert.deepEqual(calls.filter(call => call.operation === 'subscribe').map(call => call.value), [
    { threadId: 'thread-1', method: 'telegram.outbound' },
  ]);
  const sent = calls.find(call => call.operation === 'send')?.value as Record<string, unknown>;
  assert.equal(sent.threadId, 'thread-1');
  assert.equal(sent.idempotencyKey, 'provider-1');
  assert.equal('address' in sent, false);
  assert.match(JSON.stringify(sent), /"reference":"pmr_telegram_/u);
  assert.equal(JSON.stringify(sent).includes('private-file-id'), false);
  assert.equal((calls.find(call => call.operation === 'provider.send')?.value as unknown[])[0], 'chat-1');
  assert.deepEqual(calls.find(call => call.operation === 'provider.send')?.value, [
    'chat-1', '【Cat🐱】\nhello',
  ]);
  await assert.rejects(async () => active.actions['telegram.outbound']?.({ ...delivery(), externalConversationId: 'forbidden' }), /unsupported field/);
  await active.stop();
});

test('telegram.test reports ok while polling with a configured token', async () => {
  const entrypoint = createTelegramPluginModule(() => ({
    outbound: {} as TelegramAdapter,
    async start() {},
    async stop() {},
    isPolling: () => true,
  }) as TelegramConnectorRuntime<TelegramAdapter>);
  const host: ModulePluginHostShape = {
    config: { get: async () => undefined }, secrets: { get: async () => '123456:ABCdefGHIJKL' },
    storage: {} as never, tasks: {} as never,
    media: { read: async input => ({ offset: input.offset, dataBase64: '', done: true }) },
    threads: { listBindings: async () => [], ensureByKey: async () => { throw new Error('unused'); } } as never,
    messaging: { subscribe: async () => undefined, unsubscribe: async () => undefined, send: async () => { throw new Error('unused'); } },
    log() {},
  };
  const active = await entrypoint.create(manifest).start(host);
  assert.deepEqual(await active.actions['telegram.test']?.(undefined), { ok: true });
  await active.stop();
});

test('telegram.test reports not configured when the token is missing', async () => {
  const entrypoint = createTelegramPluginModule(() => {
    throw new Error('runtime must not be created without a token');
  });
  const host: ModulePluginHostShape = {
    config: { get: async () => undefined }, secrets: { get: async () => undefined },
    storage: {} as never, tasks: {} as never,
    media: { read: async input => ({ offset: input.offset, dataBase64: '', done: true }) },
    threads: { listBindings: async () => [], ensureByKey: async () => { throw new Error('unused'); } } as never,
    messaging: { subscribe: async () => undefined, unsubscribe: async () => undefined, send: async () => { throw new Error('unused'); } },
    log() {},
  };
  const active = await entrypoint.create(manifest).start(host);
  assert.deepEqual(await active.actions['telegram.test']?.(undefined), { ok: false, message: 'Telegram Bot Token 未配置' });
  await active.stop();
});

test('telegram.test reports not-polling separately from a missing token', async () => {
  const entrypoint = createTelegramPluginModule(() => ({
    outbound: {} as TelegramAdapter,
    async start() {},
    async stop() {},
    isPolling: () => false,
  }) as TelegramConnectorRuntime<TelegramAdapter>);
  const host: ModulePluginHostShape = {
    config: { get: async () => undefined }, secrets: { get: async () => '123456:ABCdefGHIJKL' },
    storage: {} as never, tasks: {} as never,
    media: { read: async input => ({ offset: input.offset, dataBase64: '', done: true }) },
    threads: { listBindings: async () => [], ensureByKey: async () => { throw new Error('unused'); } } as never,
    messaging: { subscribe: async () => undefined, unsubscribe: async () => undefined, send: async () => { throw new Error('unused'); } },
    log() {},
  };
  const active = await entrypoint.create(manifest).start(host);
  assert.deepEqual(await active.actions['telegram.test']?.(undefined), { ok: false, message: 'Telegram 未在轮询（Token 已配置）' });
  await active.stop();
});

test('lifecycle registers the Telegram placeholder before final delivery and clears it on settlement', async () => {
  const calls: unknown[][] = [];
  const outbound = {
    async sendPlaceholder(...args: unknown[]) { calls.push(['placeholder', ...args]); return '42'; },
    registerInlinePlaceholder(...args: unknown[]) { calls.push(['register', ...args]); },
    async editMessage(...args: unknown[]) { calls.push(['edit', ...args]); return true; },
    async sendReply(...args: unknown[]) { calls.push(['final', ...args]); },
    async clearInlinePlaceholder(...args: unknown[]) { calls.push(['clear', ...args]); },
    async clearInlineFinalConsumed() {},
  } as unknown as TelegramAdapter;
  const entrypoint = createTelegramPluginModule(() => ({
    outbound, async start() {}, async stop() {}, isPolling: () => true,
  }) as TelegramConnectorRuntime<TelegramAdapter>);
  const active = await entrypoint.create(manifest).start(lifecycleHost());
  const action = active.actions['host.messaging.lifecycle']!;
  await action({
    lifecycleId: 'life-1', deliveryId: 'delivery-1', threadId: 'thread-1', state: 'started',
    presentation: { actor: { displayName: '砚砚', emoji: '🐱' }, thread: { shortId: 'thread-1' } },
  });
  await active.actions['telegram.outbound']?.({ ...delivery(), lifecycleId: 'life-1' });
  await action({
    lifecycleId: 'life-1', deliveryId: 'delivery-2', threadId: 'thread-1', state: 'settled', chainDone: true, outcome: 'completed',
  });
  assert.deepEqual(calls, [
    ['placeholder', 'chat-1', '【砚砚🐱】🤔 思考中...'],
    ['register', 'chat-1', '42', 'life-1'],
    ['final', 'chat-1', '【Cat🐱】\nhello', undefined, 'life-1'],
    ['clear', 'chat-1', '42', 'life-1'],
  ]);
  await active.stop();
});

test('blocked then settled failed preserves the real Telegram recovery message and revokes inline-final correlation', async () => {
  const edits: unknown[][] = [];
  const sends: unknown[][] = [];
  const deletes: unknown[][] = [];
  const outbound = new TelegramAdapter('123456:abcdefghij_ABC-123', { info() {}, warn() {}, error() {} });
  outbound._injectBotApiSendMessage(async () => ({ message_id: 42 }));
  outbound._injectBotApiEditMessage(async (...args) => { edits.push(args); });
  outbound._injectBotApiDeleteMessage(async (...args) => { deletes.push(args); });
  outbound._injectSendMessage(async (...args) => { sends.push(args); });
  const entrypoint = createTelegramPluginModule(() => ({
    outbound, async start() {}, async stop() {}, isPolling: () => true,
  }) as TelegramConnectorRuntime<TelegramAdapter>);
  const active = await entrypoint.create(manifest).start(lifecycleHost('42'));
  const action = active.actions['host.messaging.lifecycle']!;
  await action({ lifecycleId: 'blocked-life', deliveryId: 'delivery-1', threadId: 'thread-1', state: 'started', presentation: { actor: { displayName: '砚砚', emoji: '🐱' }, thread: { shortId: 'thread-1' } } });
  await action({ lifecycleId: 'blocked-life', deliveryId: 'delivery-2', threadId: 'thread-1', state: 'blocked', reason: 'needs_user' });
  await action({ lifecycleId: 'blocked-life', deliveryId: 'delivery-3', threadId: 'thread-1', state: 'settled', chainDone: false, outcome: 'failed' });
  await outbound.sendReply('42', 'late final must not replace recovery', undefined, 'blocked-life');
  assert.deepEqual(edits, [[42, 42, '⚠️ 未能完成最新消息重读（needs_user）。请打开 Clowder AI 重试。', undefined]]);
  assert.deepEqual(deletes, []);
  assert.deepEqual(sends, [['42', 'late final must not replace recovery']]);
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
        { elementId: 'm1', kind: 'media_ref', payload: { type: 'audio', reference: 'hmr_audio-1', fileName: 'voice.ogg' } },
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

test('rich blocks and typed media notices route to sendRichMessage instead of sendReply', async () => {
  const calls: Array<{ operation: string; value: unknown }> = [];
  const outbound = {
    async sendRichMessage(...args: unknown[]) { calls.push({ operation: 'provider.rich', value: args }); },
    async sendReply(...args: unknown[]) { calls.push({ operation: 'provider.send', value: args }); },
    async sendMedia(chatId: string, payload: Record<string, unknown>) {
      if (payload.fileName === 'large.bin') throw new RangeError('provider limit');
      assert.equal('url' in payload, false);
      assert.equal('absPath' in payload, false);
      assert.ok(payload.content !== undefined);
      const chunks: Buffer[] = [];
      for await (const chunk of payload.content as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
      calls.push({ operation: 'provider.media', value: [chatId, payload.type, Buffer.concat(chunks).toString(), payload.fileName] });
    },
  } as unknown as TelegramAdapter;
  const entrypoint = createTelegramPluginModule(() => ({ outbound, async start() {}, async stop() {} }) as TelegramConnectorRuntime<TelegramAdapter>);
  const host: ModulePluginHostShape = {
    config: { get: async () => undefined }, secrets: { get: async () => 'bot-token' },
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
  await active.actions['telegram.outbound']?.(richDelivery());
  assert.deepEqual(calls, [
    { operation: 'provider.rich', value: ['chat-1', '正文\n\n⚠️ 媒体不可用：diagram.png（来源已过期）\n\n⚠️ 媒体处理警告：voice.ogg（转写处理失败）', [
      { id: 'b1', kind: 'card', v: 1, title: 'T', bodyMarkdown: 'B' },
      { id: 'b2', kind: 'checklist', v: 1, title: 'L', items: [{ id: 'i1', text: 'a', checked: true }, { id: 'i2', text: 'b' }] },
    ], 'Cat'] },
    { operation: 'provider.media', value: ['chat-1', 'audio', 'voice-bytes', 'voice.ogg'] },
    { operation: 'provider.send', value: ['chat-1', '【Cat🐱】\n⚠️ 媒体不可用（读取或上传失败）', undefined] },
    { operation: 'provider.send', value: ['chat-1', '【Cat🐱】\n⚠️ 媒体不可用（旧引用无法读取）', undefined] },
    { operation: 'provider.send', value: ['chat-1', '【Cat🐱】\n⚠️ 视频附件暂不支持发送', undefined] },
    { operation: 'provider.send', value: ['chat-1', '【Cat🐱】\n⚠️ 媒体过大，超过 Telegram 发送上限', undefined] },
  ]);
  calls.length = 0;
  const typedOnly = richDelivery();
  typedOnly.deliveryId = 'delivery-typed-only';
  typedOnly.envelope.payload.elements = typedOnly.envelope.payload.elements.filter(element => (
    element.kind === 'text' || element.kind === 'media_unavailable'
  ));
  await active.actions['telegram.outbound']?.(typedOnly);
  assert.deepEqual(calls.map(call => call.operation), ['provider.send']);
  assert.deepEqual(calls[0]?.value, [
    'chat-1', '【Cat🐱】\n正文\n\n⚠️ 媒体不可用：diagram.png（来源已过期）',
  ]);
  await active.stop();
});

test('outbound attaches replyToSender metadata from the recorded inbound mapping (group @ parity)', async () => {
  const calls: Array<{ operation: string; value: unknown }> = [];
  let inbound!: (message: TelegramHostInboundMessage) => Promise<void>;
  const state = new Map<string, { revision: number; value: unknown }>();
  const outbound = {
    async sendRichMessage(...args: unknown[]) { calls.push({ operation: 'provider.rich', value: args }); },
    async sendReply(...args: unknown[]) { calls.push({ operation: 'provider.send', value: args }); },
    async sendMedia() {},
  } as unknown as TelegramAdapter;
  const entrypoint = createTelegramPluginModule((options) => {
    inbound = options.host.deliver;
    return { outbound, async start() {}, async stop() {} } as TelegramConnectorRuntime<TelegramAdapter>;
  });
  const host: ModulePluginHostShape = {
    config: { get: async () => undefined }, secrets: { get: async () => 'bot-token' },
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
  const withVideo = (candidate: ReturnType<typeof delivery> & { envelope: { replyTo?: string } }) => {
    (candidate.envelope.payload.elements as unknown[]).push(
      { elementId: 'v1', kind: 'media_ref', payload: { type: 'video', reference: 'hmr_video-1' } },
      { elementId: 'r1', kind: 'rich_block', payload: { id: 'b1', kind: 'card', v: 1, title: 'T', bodyMarkdown: 'B' } },
    );
    return candidate;
  };
  const active = await entrypoint.create(manifest).start(host);
  await inbound({
    externalConversationId: 'chat-1', externalSenderId: 'user-1', providerMessageId: 'provider-1', text: 'inbound',
  });
  const matched = withVideo(delivery() as ReturnType<typeof delivery> & { envelope: { replyTo?: string } });
  matched.envelope.replyTo = 'host-message-1';
  await active.actions['telegram.outbound']?.(matched);
  const rich = calls.find(call => call.operation === 'provider.rich')?.value as unknown[];
  assert.equal(rich[3], 'Cat');
  const sent = calls.find(call => call.operation === 'provider.send')?.value as unknown[];
  assert.equal(sent[0], 'chat-1');
  assert.equal(sent[1], '【Cat🐱】\n⚠️ 视频附件暂不支持发送');
  assert.deepEqual(sent[2], { replyToSender: { id: 'user-1' } });
  calls.length = 0;
  const missed = withVideo(delivery() as ReturnType<typeof delivery> & { envelope: { replyTo?: string } });
  missed.deliveryId = 'delivery-2';
  missed.envelope.replyTo = 'host-unknown';
  await active.actions['telegram.outbound']?.(missed);
  const missedSent = calls.find(call => call.operation === 'provider.send')?.value as unknown[];
  assert.equal(missedSent[1], '【Cat🐱】\n⚠️ 视频附件暂不支持发送');
  assert.equal(missedSent[2], undefined);
  await active.stop();
});

test('telegram.outbound rejects a delivery without presentation (subscription presentation v1)', async () => {
  const entrypoint = createTelegramPluginModule(() => ({
    outbound: {} as TelegramAdapter,
    async start() {},
    async stop() {},
    isPolling: () => true,
  }) as TelegramConnectorRuntime<TelegramAdapter>);
  const host: ModulePluginHostShape = {
    config: { get: async () => undefined }, secrets: { get: async () => 'bot-token' },
    storage: {} as never, tasks: {} as never,
    media: { read: async input => ({ offset: input.offset, dataBase64: '', done: true }) },
    threads: { listBindings: async () => [], ensureByKey: async () => { throw new Error('unused'); } } as never,
    messaging: { subscribe: async () => undefined, unsubscribe: async () => undefined, send: async () => { throw new Error('unused'); } },
    log() {},
  };
  const active = await entrypoint.create(manifest).start(host);
  const withoutPresentation = delivery() as Record<string, unknown>;
  delete withoutPresentation.presentation;
  await assert.rejects(async () => active.actions['telegram.outbound']?.(withoutPresentation), /presentation/i);
  await active.stop();
});

test('non-cat media-only outbound skips the empty text send and still delivers media', async () => {
  const calls: Array<{ operation: string; value: unknown }> = [];
  const outbound = {
    async sendRichMessage() {},
    async sendReply(...args: unknown[]) { calls.push({ operation: 'provider.send', value: args }); },
    async sendMedia(chatId: string, payload: Record<string, unknown>) {
      calls.push({ operation: 'provider.media', value: [chatId, payload.type] });
    },
  } as unknown as TelegramAdapter;
  const entrypoint = createTelegramPluginModule(() => ({ outbound, async start() {}, async stop() {} }) as TelegramConnectorRuntime<TelegramAdapter>);
  const host = lifecycleHost();
  const active = await entrypoint.create(manifest).start(host);
  const mediaOnly = {
    deliveryId: 'delivery-1', threadId: 'thread-1',
    presentation: { actor: { displayName: 'Human', emoji: '👤' }, thread: { shortId: 'thread-1' } },
    envelope: {
      messageId: 'message-1', revision: 1, threadId: 'thread-1',
      actor: { kind: 'human', id: 'user-1' }, audience: { kind: 'public' }, occurredAt: '2026-09-22T00:00:00.000Z',
      payload: { provenance: { origin: { kind: 'host' }, epistemicStatus: 'observation' }, elements: [
        { elementId: 'm1', kind: 'media_ref', payload: { type: 'image', reference: 'hmr_image-1' } },
      ] },
    },
  };
  await active.actions['telegram.outbound']?.(mediaOnly);
  assert.deepEqual(calls, [{ operation: 'provider.media', value: ['chat-1', 'image'] }]);
  await active.stop();
});
