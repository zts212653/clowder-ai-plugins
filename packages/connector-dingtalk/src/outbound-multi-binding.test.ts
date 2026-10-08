import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { ModulePluginHostShape } from '@clowder-ai/plugin-sdk';
import { parse } from 'yaml';

import { createDingTalkPluginModule } from './plugin-entrypoint.js';
import type { DingTalkAdapter } from './DingTalkAdapter.js';
import type { DingTalkConnectorRuntime } from './runtime.js';

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

function multiBindingHost(bindings: Array<{ key: string; threadId: string }>, warnings: unknown[][]) {
  return {
    config: { get: async () => 'app-key' }, secrets: { get: async () => 'app-secret' },
    storage: {} as never, tasks: {} as never,
    media: { read: async input => ({ offset: input.offset, dataBase64: '', done: true }) },
    threads: {
      listBindings: async () => bindings.map(binding => ({ ...binding, createdAt: 1 })),
      ensureByKey: async () => { throw new Error('unused'); },
    } as never,
    messaging: { subscribe: async () => undefined, unsubscribe: async () => undefined, send: async () => { throw new Error('unused'); } },
    log(...args: unknown[]) { warnings.push(args); },
  } satisfies ModulePluginHostShape;
}

function failingOutbound(sends: unknown[][], failingChats: Set<string>) {
  return {
    async sendFormattedReply(...args: unknown[]) {
      sends.push(args);
      const chatId = args[0];
      if (typeof chatId === 'string' && failingChats.has(chatId)) throw new Error(`chat ${chatId} is down`);
    },
    async sendRichMessage() {}, async sendReply() {}, async sendMedia() {},
  } as unknown as DingTalkAdapter;
}

function startModule(outbound: DingTalkAdapter, bindings: Array<{ key: string; threadId: string }>, warnings: unknown[][]) {
  const entrypoint = createDingTalkPluginModule(() => ({ outbound, async start() {}, async stop() {} }) as DingTalkConnectorRuntime<DingTalkAdapter>);
  return entrypoint.create(manifest).start(multiBindingHost(bindings, warnings));
}

test('multi-binding outbound delivers to the healthy chat when one binding send fails', async () => {
  const sends: unknown[][] = [];
  const warnings: unknown[][] = [];
  const outbound = failingOutbound(sends, new Set(['chat-bad']));
  const active = await startModule(outbound, [
    { key: 'chat-good', threadId: 'thread-1' },
    { key: 'chat-bad', threadId: 'thread-1' },
  ], warnings);
  await active.actions['dingtalk.outbound']?.(delivery());
  const goodSends = sends.filter(args => args[0] === 'chat-good');
  assert.equal(goodSends.length, 1, 'the healthy chat must receive exactly one delivery');
  assert.equal((goodSends[0]?.[1] as { body?: string }).body, 'hello');
  assert.equal(sends.filter(args => args[0] === 'chat-bad').length, 1, 'the failing chat is attempted once');
  const bindingFailures = warnings.filter(args => args[0] === 'warn' && String(args[1]).includes('one binding failed'));
  assert.equal(bindingFailures.length, 1);
  assert.deepEqual(bindingFailures[0]?.[2], { externalConversationId: 'chat-bad', errorName: 'Error' });
  await active.stop();
});

test('multi-binding outbound rejects only when every binding send fails', async () => {
  const sends: unknown[][] = [];
  const warnings: unknown[][] = [];
  const outbound = failingOutbound(sends, new Set(['chat-bad', 'chat-worse']));
  const active = await startModule(outbound, [
    { key: 'chat-bad', threadId: 'thread-1' },
    { key: 'chat-worse', threadId: 'thread-1' },
  ], warnings);
  await assert.rejects(
    async () => active.actions['dingtalk.outbound']?.(delivery()),
    /chat chat-bad is down/,
  );
  assert.equal(sends.length, 2, 'every binding is still attempted');
  assert.equal(warnings.filter(args => args[0] === 'warn' && String(args[1]).includes('one binding failed')).length, 2);
  await active.stop();
});

test('single-binding outbound send failure still rejects the action', async () => {
  const sends: unknown[][] = [];
  const warnings: unknown[][] = [];
  const outbound = failingOutbound(sends, new Set(['chat-bad']));
  const active = await startModule(outbound, [{ key: 'chat-bad', threadId: 'thread-1' }], warnings);
  await assert.rejects(
    async () => active.actions['dingtalk.outbound']?.(delivery()),
    /chat chat-bad is down/,
  );
  assert.equal(sends.length, 1);
  await active.stop();
});

test('outbound rejects with a synthesized error when the provider throws undefined', async () => {
  const sends: unknown[][] = [];
  const warnings: unknown[][] = [];
  const outbound = {
    async sendFormattedReply(...args: unknown[]) {
      sends.push(args);
      throw undefined;
    },
    async sendRichMessage() {}, async sendReply() {}, async sendMedia() {},
  } as unknown as DingTalkAdapter;
  const active = await startModule(outbound, [{ key: 'chat-bad', threadId: 'thread-1' }], warnings);
  await assert.rejects(
    async () => active.actions['dingtalk.outbound']?.(delivery()),
    /DingTalk outbound delivery failed for all bindings \(provider did not report an error\)/,
  );
  assert.equal(sends.length, 1);
  await active.stop();
});
