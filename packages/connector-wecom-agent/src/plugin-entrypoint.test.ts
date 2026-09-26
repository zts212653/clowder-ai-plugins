import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { ModulePluginHostShape } from '@clowder-ai/plugin-sdk';
import { parse } from 'yaml';

import moduleEntrypoint, { createWeComAgentPluginModule } from './plugin-entrypoint.js';
import type { WeComAgentConnectorRuntime, WeComAgentHostInboundMessage } from './runtime.js';
import type { WeComAgentAdapter } from './WeComAgentAdapter.js';

const manifest = parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8')) as unknown;

function host(
  config: Record<string, unknown>,
  secrets: Record<string, string>,
  sent: Array<{ idempotencyKey: string; sourceEventId?: string }> = [],
  drafts: unknown[] = [],
): ModulePluginHostShape {
  const state = new Map<string, { revision: number; value: unknown }>();
  return {
    config: { get: async key => config[key] },
    secrets: { get: async key => secrets[key] },
    storage: {
      get: async key => state.get(key), list: async () => Object.fromEntries(state),
      set: async (key, value) => { const revision = (state.get(key)?.revision ?? 0) + 1; state.set(key, { revision, value }); return { revision }; },
      compareAndSet: async (key, expectedRevision, value) => {
        if (expectedRevision !== null || state.has(key)) return { applied: false };
        state.set(key, { revision: 1, value });
        return { applied: true, revision: 1 };
      }, delete: async key => ({ deleted: state.delete(key) }),
    },
    tasks: {} as never,
    media: { read: async input => ({ offset: input.offset, dataBase64: '', done: true }) },
    threads: { listBindings: async () => [], ensureByKey: async () => ({ id: 'thread-1' }) } as never,
    messaging: {
      subscribe: async () => undefined, unsubscribe: async () => undefined,
      send: async input => {
        sent.push({ idempotencyKey: input.idempotencyKey, sourceEventId: input.sourceEventId });
        drafts.push(input);
        return { messageId: 'message-1', threadId: input.threadId, revision: 1, messageHandle: 'handle-1', pendingPublication: true as const };
      },
    },
    log() {},
  };
}

test('default export is the deterministic package module entrypoint', () => {
  assert.equal(typeof moduleEntrypoint.create, 'function');
  assert.equal(typeof moduleEntrypoint.create(manifest).start, 'function');
});

test('module exposes both manifest-declared connector and webhook actions', async () => {
  const outbound = {
    async sendFormattedReply() {}, async sendMedia() {}, async sendReply() {},
  } as unknown as WeComAgentAdapter;
  const entrypoint = createWeComAgentPluginModule(() => ({
    outbound,
    async start() {}, async stop() {},
    async handleWebhook(input) {
      if (input.body === 'invalid') return { kind: 'invalid' } as never;
      return { kind: 'skipped', reason: 'test' };
    },
  } as WeComAgentConnectorRuntime<WeComAgentAdapter>));
  const config: Record<string, unknown> = { corpId: 'corp', agentId: 'agent' };
  const secrets: Record<string, string> = { agentSecret: 'secret', callbackToken: 'token', encodingAesKey: 'aes' };
  const active = await entrypoint.create(manifest).start(host(config, secrets));
  assert.deepEqual(Object.keys(active.actions).sort(), [
    'wecom-agent.media-source.read', 'wecom-agent.media-source.settle', 'wecom-agent.outbound', 'wecom-agent.webhook',
  ]);
  const request = {
    method: 'POST', path: 'connectors/wecom-agent', query: {},
    body: '<xml/>', rawBody: Buffer.from('<xml/>'), headers: { 'content-type': 'text/xml' },
  };
  assert.deepEqual(await active.actions['wecom-agent.webhook']?.({ request }), {
    status: 200, headers: {}, body: { ok: true, skipped: 'test' },
  });
  await assert.rejects(async () => active.actions['wecom-agent.webhook']?.({ body: request.body }), /request/u);
  await assert.rejects(async () => active.actions['wecom-agent.webhook']?.({
    request: { ...request, body: 'invalid' },
  }), /invalid result/u);
  await active.stop();
});

test('Host-shaped WeCom GET echostr returns a strict text/plain HTTP challenge', async () => {
  const outbound = { async sendFormattedReply() {}, async sendMedia() {}, async sendReply() {} } as unknown as WeComAgentAdapter;
  const entrypoint = createWeComAgentPluginModule(() => ({
    outbound, async start() {}, async stop() {},
    async handleWebhook(input) {
      assert.deepEqual(input, { body: undefined, query: { echostr: 'encrypted-echo' } });
      return { kind: 'challenge', response: 'decrypted-echo' };
    },
  } as WeComAgentConnectorRuntime<WeComAgentAdapter>));
  const active = await entrypoint.create(manifest).start(host(
    { corpId: 'corp', agentId: 'agent' },
    { agentSecret: 'secret', callbackToken: 'token', encodingAesKey: 'aes' },
  ));
  assert.deepEqual(await active.actions['wecom-agent.webhook']?.({ request: {
    method: 'GET', path: 'connectors/wecom-agent', query: { echostr: 'encrypted-echo' },
    body: undefined, rawBody: Buffer.alloc(0), headers: {},
  } }), { status: 200, headers: { 'content-type': 'text/plain' }, body: 'decrypted-echo' });
  await active.stop();
});

test('replayed WeCom webhook derives the same Host idempotency and source event keys', async () => {
  const sent: Array<{ idempotencyKey: string; sourceEventId?: string }> = [];
  const drafts: unknown[] = [];
  const outbound = { async sendFormattedReply() {}, async sendMedia() {}, async sendReply() {} } as unknown as WeComAgentAdapter;
  const entrypoint = createWeComAgentPluginModule(options => ({
    outbound, async start() {}, async stop() {},
    async handleWebhook(input) {
      assert.deepEqual(input, { body: '<encrypted/>', query: {} });
      await options.host.deliver({
        externalConversationId: 'chat-1', externalSenderId: 'sender-1',
        providerMessageId: 'provider-message-1', text: 'hello',
        attachments: [{ type: 'file', platformKey: 'private-media-id', fileName: 'document.pdf' }],
      });
      return { kind: 'processed', messageId: 'provider-message-1' };
    },
  } as WeComAgentConnectorRuntime<WeComAgentAdapter>));
  const active = await entrypoint.create(manifest).start(host(
    { corpId: 'corp', agentId: 'agent' },
    { agentSecret: 'secret', callbackToken: 'token', encodingAesKey: 'aes' }, sent, drafts,
  ));
  const payload = { request: {
    method: 'POST', path: 'connectors/wecom-agent', query: {},
    body: '<encrypted/>', rawBody: Buffer.from('<encrypted/>'), headers: {},
  } };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.deepEqual(await active.actions['wecom-agent.webhook']?.(payload), {
      status: 200, headers: {}, body: { ok: true, messageId: 'provider-message-1' },
    });
  }
  assert.deepEqual(sent, [
    { idempotencyKey: 'provider-message-1', sourceEventId: 'provider-message-1' },
    { idempotencyKey: 'provider-message-1', sourceEventId: 'provider-message-1' },
  ]);
  const serialized = JSON.stringify(drafts);
  assert.equal(serialized.includes('private-media-id'), false);
  assert.equal(drafts.every((item) => /"reference":"pmr_wecom-agent_/u.test(JSON.stringify(item))), true);
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
        { elementId: 'm1', kind: 'media_ref', payload: { type: 'audio', reference: 'hmr_audio-1', fileName: 'voice.amr' } },
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

test('rich blocks and typed media notices fall back to sendReply with rendered plaintext blocks', async () => {
  const calls: Array<{ operation: string; value: unknown }> = [];
  const outbound = {
    async sendReply(...args: unknown[]) { calls.push({ operation: 'provider.send', value: args }); },
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
  } as unknown as WeComAgentAdapter;
  const entrypoint = createWeComAgentPluginModule(() => ({ outbound, async start() {}, async stop() {} }) as WeComAgentConnectorRuntime<WeComAgentAdapter>);
  const host: ModulePluginHostShape = {
    config: { get: async () => 'agent' }, secrets: { get: async () => 'secret' },
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
  await active.actions['wecom-agent.outbound']?.(richDelivery());
  assert.deepEqual(calls, [
    { operation: 'provider.send', value: ['chat-1', '【Cat🐱】\n正文\n\n⚠️ 媒体不可用：diagram.png（来源已过期）\n\n⚠️ 媒体处理警告：voice.amr（转写处理失败）\n\n📋 T\nB\n\n☑️ L\n✅ a\n☐ b'] },
    { operation: 'provider.media', value: ['chat-1', 'audio', 'voice-bytes', 'voice.amr'] },
    { operation: 'provider.send', value: ['chat-1', '【Cat🐱】\n⚠️ 媒体不可用（读取或上传失败）', undefined] },
    { operation: 'provider.send', value: ['chat-1', '【Cat🐱】\n⚠️ 媒体不可用（旧引用无法读取）', undefined] },
    { operation: 'provider.send', value: ['chat-1', '【Cat🐱】\n⚠️ 视频附件暂不支持发送', undefined] },
    { operation: 'provider.send', value: ['chat-1', '【Cat🐱】\n⚠️ 媒体过大，超过企业微信发送上限', undefined] },
  ]);
  calls.length = 0;
  const typedOnly = richDelivery();
  typedOnly.deliveryId = 'delivery-typed-only';
  typedOnly.envelope.payload.elements = typedOnly.envelope.payload.elements.filter(element => (
    element.kind === 'text' || element.kind === 'media_unavailable'
  ));
  await active.actions['wecom-agent.outbound']?.(typedOnly);
  assert.deepEqual(calls.map(call => call.operation), ['provider.formatted']);
  await active.stop();
});

function delivery() {
  return {
    deliveryId: 'delivery-1', threadId: 'thread-1',
    presentation: { actor: { displayName: 'Cat', emoji: '🐱' }, thread: { shortId: 'thread-1' } },
    envelope: {
      messageId: 'message-1', revision: 1, threadId: 'thread-1',
      actor: { kind: 'cat', id: 'cat-1' }, audience: { kind: 'public' }, occurredAt: '2026-09-22T00:00:00.000Z',
      payload: { provenance: { origin: { kind: 'host' }, epistemicStatus: 'observation' }, elements: [
        { elementId: 'text-1', kind: 'text', payload: { text: 'hello' } },
        { elementId: 'm1', kind: 'media_ref', payload: { type: 'video', reference: 'hmr_video-1' } },
      ] },
    },
  };
}

test('outbound attaches replyToSender metadata from the recorded inbound mapping (group @ parity)', async () => {
  const calls: Array<{ operation: string; value: unknown }> = [];
  let inbound!: (message: WeComAgentHostInboundMessage) => Promise<void>;
  const state = new Map<string, { revision: number; value: unknown }>();
  const outbound = {
    async sendFormattedReply(...args: unknown[]) { calls.push({ operation: 'provider.send', value: args }); },
    async sendMedia() {},
    async sendReply(...args: unknown[]) { calls.push({ operation: 'provider.reply', value: args }); },
  } as unknown as WeComAgentAdapter;
  const entrypoint = createWeComAgentPluginModule((options) => {
    inbound = options.host.deliver;
    return { outbound, async start() {}, async stop() {} } as WeComAgentConnectorRuntime<WeComAgentAdapter>;
  });
  const host: ModulePluginHostShape = {
    config: { get: async () => 'corp' }, secrets: { get: async () => 'secret' },
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
    externalConversationId: 'chat-1', externalSenderId: 'sender-1',
    providerMessageId: 'provider-1', text: 'inbound',
  });
  const matched = delivery() as ReturnType<typeof delivery> & { envelope: { replyTo?: string } };
  matched.envelope.replyTo = 'host-message-1';
  await active.actions['wecom-agent.outbound']?.(matched);
  const sent = calls.find(call => call.operation === 'provider.send')?.value as unknown[];
  assert.equal(sent[0], 'chat-1');
  assert.equal((sent[1] as { header: string }).header, 'Cat');
  const reply = calls.find(call => call.operation === 'provider.reply')?.value as unknown[];
  assert.equal(reply[0], 'chat-1');
  assert.equal(reply[1], '【Cat🐱】\n⚠️ 视频附件暂不支持发送');
  assert.deepEqual(reply[2], { replyToSender: { id: 'sender-1' } });
  calls.length = 0;
  const missed = delivery() as ReturnType<typeof delivery> & { envelope: { replyTo?: string } };
  missed.deliveryId = 'delivery-2';
  missed.envelope.replyTo = 'host-unknown';
  await active.actions['wecom-agent.outbound']?.(missed);
  const missedReply = calls.find(call => call.operation === 'provider.reply')?.value as unknown[];
  assert.equal(missedReply[2], undefined);
  await active.stop();
});

test('outbound rejects a delivery without presentation (presentation v1 subscription)', async () => {
  const outbound = { async sendFormattedReply() {}, async sendMedia() {}, async sendReply() {} } as unknown as WeComAgentAdapter;
  const entrypoint = createWeComAgentPluginModule(() => ({ outbound, async start() {}, async stop() {} }) as WeComAgentConnectorRuntime<WeComAgentAdapter>);
  const active = await entrypoint.create(manifest).start(host(
    { corpId: 'corp', agentId: 'agent' },
    { agentSecret: 'secret', callbackToken: 'token', encodingAesKey: 'aes' },
  ));
  const noPresentation = delivery() as Record<string, unknown>;
  delete noPresentation.presentation;
  await assert.rejects(
    async () => active.actions['wecom-agent.outbound']?.(noPresentation),
    /presentation/i,
  );
  await active.stop();
});
