import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { ModulePluginHostShape } from '@clowder-ai/plugin-sdk';
import { parse } from 'yaml';

import moduleEntrypoint, { createXiaoyiPluginModule } from './plugin-entrypoint.js';
import type { XiaoyiConnectorRuntime } from './runtime.js';
import type { XiaoyiAdapter } from './XiaoyiAdapter.js';

const manifest = parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8')) as unknown;

function host(values: Record<string, unknown>): ModulePluginHostShape {
  const state = new Map<string, { revision: number; value: unknown }>();
  return {
    config: { get: async key => values[key] }, secrets: { get: async () => 'sk' },
    storage: {
      get: async key => state.get(key), list: async () => Object.fromEntries(state),
      set: async (key, value) => { const revision = (state.get(key)?.revision ?? 0) + 1; state.set(key, { revision, value }); return { revision }; },
      compareAndSet: async () => ({ applied: false }), delete: async key => ({ deleted: state.delete(key) }),
    }, tasks: {} as never,
    media: { read: async input => ({ offset: input.offset, dataBase64: '', done: true }) },
    threads: { listBindings: async () => [{ key: 'agent:session', threadId: 'thread-1', createdAt: 1 }] } as never,
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
      actor: { kind: 'cat', id: '砚砚' }, audience: { kind: 'public' }, occurredAt: '2026-09-22T00:00:00.000Z',
      payload: { provenance: { origin: { kind: 'host' }, epistemicStatus: 'observation' }, elements: [{ elementId: 'text-1', kind: 'text', payload: { text: 'hello' } }] },
    },
  };
}

test('default export is the deterministic package module entrypoint', () => {
  assert.equal(typeof moduleEntrypoint.create, 'function');
  assert.equal(typeof moduleEntrypoint.create(manifest).start, 'function');
});

test('module leaves provider task settlement to the lifecycle action', async () => {
  const events: unknown[] = [];
  const outbound = {
    async sendReply(...args: unknown[]) { events.push(['reply', ...args]); },
    async onDeliveryBatchDone(...args: unknown[]) { events.push(['done', ...args]); },
  } as unknown as XiaoyiAdapter;
  const entrypoint = createXiaoyiPluginModule((options) => {
    assert.deepEqual(options.config, { accessKey: 'ak', secretKey: 'sk', agentId: 'agent' });
    return { outbound, async start() {}, async stop() {} } as XiaoyiConnectorRuntime<XiaoyiAdapter>;
  });
  const values: Record<string, unknown> = { accessKey: 'ak', agentId: 'agent' };
  const active = await entrypoint.create(manifest).start(host(values));
  await active.actions['xiaoyi.outbound']?.(delivery());
  assert.deepEqual(events, [
    ['reply', 'agent:session', '【Cat🐱】\nhello', undefined],
  ]);
});

test('multi-binding outbound fans the same delivery out to every binding', async () => {
  const events: unknown[] = [];
  const outbound = {
    async sendReply(...args: unknown[]) { events.push(args); },
    async onDeliveryBatchDone() {},
  } as unknown as XiaoyiAdapter;
  const entrypoint = createXiaoyiPluginModule(() => ({
    outbound, async start() {}, async stop() {},
  }) as XiaoyiConnectorRuntime<XiaoyiAdapter>);
  const multiHost: ModulePluginHostShape = {
    ...host({ accessKey: 'ak', agentId: 'agent' }),
    threads: {
      listBindings: async () => [
        { key: 'agent:session-a', threadId: 'thread-1', createdAt: 1 },
        { key: 'agent:session-b', threadId: 'thread-1', createdAt: 2 },
      ],
    } as never,
  };
  const active = await entrypoint.create(manifest).start(multiHost);
  await active.actions['xiaoyi.outbound']?.(delivery());
  assert.deepEqual(events, [
    ['agent:session-a', '【Cat🐱】\nhello', undefined],
    ['agent:session-b', '【Cat🐱】\nhello', undefined],
  ]);
  await active.stop();
});

test('lifecycle sends one standalone blocked recovery and preserves chainDone false and true', async () => {
  const events: unknown[] = [];
  const outbound = {
    async sendPlaceholder(...args: unknown[]) { events.push(['placeholder', ...args]); return ''; },
    async editMessage(...args: unknown[]) { events.push(['edit', ...args]); },
    async sendReply(...args: unknown[]) { events.push(['reply', ...args]); },
    async onDeliveryBatchDone(...args: unknown[]) { events.push(['done', ...args]); },
  } as unknown as XiaoyiAdapter;
  const entrypoint = createXiaoyiPluginModule(() => ({
    outbound, async start() {}, async stop() {},
  }) as XiaoyiConnectorRuntime<XiaoyiAdapter>);
  const active = await entrypoint.create(manifest).start(host({ accessKey: 'ak', agentId: 'agent' }));
  const action = active.actions['host.messaging.lifecycle']!;
  const started = (lifecycleId: string, deliveryId: string) => ({
    lifecycleId, deliveryId, threadId: 'thread-1', state: 'started',
    presentation: { actor: { displayName: '砚砚', emoji: '🐱' }, thread: { shortId: 'thread-1' } },
  });
  await action(started('life-1', 'delivery-1'));
  const blocked = {
    lifecycleId: 'life-1', deliveryId: 'delivery-2', threadId: 'thread-1', state: 'blocked', reason: 'needs_user',
  };
  await action(blocked);
  await action(blocked);
  await action({
    lifecycleId: 'life-1', deliveryId: 'delivery-3', threadId: 'thread-1', state: 'settled', chainDone: false, outcome: 'failed',
  });
  await action(started('life-2', 'delivery-4'));
  await action({
    lifecycleId: 'life-2', deliveryId: 'delivery-5', threadId: 'thread-1', state: 'settled', chainDone: true, outcome: 'completed',
  });
  assert.deepEqual(events, [
    ['placeholder', 'agent:session', '【砚砚🐱】🤔 思考中...'],
    ['reply', 'agent:session', '⚠️ 未能完成最新消息重读（needs_user）。请打开 Clowder AI 重试。'],
    ['done', 'agent:session', false],
    ['placeholder', 'agent:session', '【砚砚🐱】🤔 思考中...'],
    ['done', 'agent:session', true],
  ]);
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
        { elementId: 'm1', kind: 'media_ref', payload: { type: 'audio', reference: 'hmr_audio-1' } },
        { elementId: 'w1', kind: 'media_warning', payload: { mediaElementId: 'm1', stage: 'transcription', reason: 'processing_failed' } },
        { elementId: 'r1', kind: 'rich_block', payload: { id: 'b1', kind: 'card', v: 1, title: 'T', bodyMarkdown: 'B' } },
        { elementId: 'r2', kind: 'rich_block', payload: { id: 'b2', kind: 'checklist', v: 1, title: 'L', items: [{ id: 'i1', text: 'a', checked: true }, { id: 'i2', text: 'b' }] } },
      ] },
    },
  };
}

test('rich blocks and typed media notices append rendered plaintext blocks before lifecycle settlement', async () => {
  const events: unknown[] = [];
  const outbound = {
    async sendReply(...args: unknown[]) { events.push(['reply', ...args]); },
    async onDeliveryBatchDone(...args: unknown[]) { events.push(['done', ...args]); },
  } as unknown as XiaoyiAdapter;
  const entrypoint = createXiaoyiPluginModule(() => ({ outbound, async start() {}, async stop() {} }) as XiaoyiConnectorRuntime<XiaoyiAdapter>);
  const values: Record<string, unknown> = { accessKey: 'ak', agentId: 'agent' };
  const active = await entrypoint.create(manifest).start(host(values));
  await active.actions['xiaoyi.outbound']?.(richDelivery());
  assert.deepEqual(events, [
    ['reply', 'agent:session', '【Cat🐱】\n正文\n\n⚠️ 媒体不可用：diagram.png（来源已过期）\n\n⚠️ 媒体处理警告：音频（转写处理失败）\n\n📋 T\nB\n\n☑️ L\n✅ a\n☐ b', undefined],
    ['reply', 'agent:session', '【Cat🐱】\n⚠️ 这条语音无法在小艺里发送', undefined],
  ]);
  events.length = 0;
  const typedOnly = richDelivery();
  typedOnly.deliveryId = 'delivery-typed-only';
  typedOnly.envelope.payload.elements = typedOnly.envelope.payload.elements.filter(element => (
    element.kind === 'text' || element.kind === 'media_unavailable'
  ));
  await active.actions['xiaoyi.outbound']?.(typedOnly);
  assert.deepEqual(events, [
    ['reply', 'agent:session', '【Cat🐱】\n正文\n\n⚠️ 媒体不可用：diagram.png（来源已过期）', undefined],
  ]);
  await active.stop();
});

test('outbound attaches replyToSender metadata from the recorded inbound mapping (group @ parity)', async () => {
  const events: unknown[] = [];
  let inbound!: (message: import('./runtime.js').XiaoyiHostInboundMessage) => Promise<void>;
  const outbound = {
    async sendReply(...args: unknown[]) { events.push(['reply', ...args]); },
  } as unknown as XiaoyiAdapter;
  const entrypoint = createXiaoyiPluginModule((options) => {
    inbound = options.host.deliver;
    return { outbound, async start() {}, async stop() {} } as XiaoyiConnectorRuntime<XiaoyiAdapter>;
  });
  const hostWithEnsure = {
    ...host({ accessKey: 'ak', agentId: 'agent' }),
    threads: {
      listBindings: async () => [{ key: 'agent:session', threadId: 'thread-1', createdAt: 1 }],
      ensureByKey: async (key: string) => ({ id: 'thread-1', title: key, createdAt: 1, lastActiveAt: 1 }),
    } as never,
  } as ModulePluginHostShape;
  const active = await entrypoint.create(manifest).start(hostWithEnsure);
  await inbound({
    externalConversationId: 'agent:session',
    externalSenderId: 'sender-1',
    providerMessageId: 'provider-1',
    text: 'inbound',
  });
  const matched = delivery() as ReturnType<typeof delivery> & { envelope: { replyTo?: string } };
  matched.envelope.replyTo = 'message-1';
  matched.envelope.payload.elements = [
    ...matched.envelope.payload.elements,
    { elementId: 'm1', kind: 'media_ref', payload: { type: 'audio', reference: 'hmr_audio-1' } },
  ] as typeof matched.envelope.payload.elements;
  await active.actions['xiaoyi.outbound']?.(matched);
  assert.deepEqual(events, [
    ['reply', 'agent:session', '【Cat🐱】\nhello', { replyToSender: { id: 'sender-1' } }],
    ['reply', 'agent:session', '【Cat🐱】\n⚠️ 这条语音无法在小艺里发送', { replyToSender: { id: 'sender-1' } }],
  ]);
  events.length = 0;
  const missed = delivery() as ReturnType<typeof delivery> & { envelope: { replyTo?: string } };
  missed.deliveryId = 'delivery-2';
  missed.envelope.replyTo = 'host-unknown';
  missed.envelope.payload.elements = [
    ...missed.envelope.payload.elements,
    { elementId: 'm1', kind: 'media_ref', payload: { type: 'audio', reference: 'hmr_audio-1' } },
  ] as typeof missed.envelope.payload.elements;
  await active.actions['xiaoyi.outbound']?.(missed);
  assert.deepEqual(events, [
    ['reply', 'agent:session', '【Cat🐱】\nhello', undefined],
    ['reply', 'agent:session', '【Cat🐱】\n⚠️ 这条语音无法在小艺里发送', undefined],
  ]);
  await active.stop();
});

test('xiaoyi.outbound rejects a delivery without presentation (subscription presentation v1)', async () => {
  const events: unknown[] = [];
  const outbound = {
    async sendReply(...args: unknown[]) { events.push(['reply', ...args]); },
  } as unknown as XiaoyiAdapter;
  const entrypoint = createXiaoyiPluginModule(() => ({ outbound, async start() {}, async stop() {} }) as XiaoyiConnectorRuntime<XiaoyiAdapter>);
  const active = await entrypoint.create(manifest).start(host({ accessKey: 'ak', agentId: 'agent' }));
  const withoutPresentation = delivery() as Record<string, unknown>;
  delete withoutPresentation.presentation;
  await assert.rejects(async () => active.actions['xiaoyi.outbound']?.(withoutPresentation), /presentation/i);
  assert.deepEqual(events, [], 'the provider must not be reached for a rejected delivery');
  await active.stop();
});
