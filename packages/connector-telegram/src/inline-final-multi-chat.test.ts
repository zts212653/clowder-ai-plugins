import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { ModulePluginHostShape } from '@clowder-ai/plugin-sdk';
import { parse } from 'yaml';

import { createTelegramPluginModule } from './plugin-entrypoint.js';
import { TelegramAdapter } from './TelegramAdapter.js';
import type { InlineFinalPersistence } from './TelegramAdapter.js';
import type { TelegramConnectorRuntime } from './runtime.js';

const manifest = parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8')) as unknown;

function hostWithState(
  state: Map<string, { revision: number; value: unknown }>,
  externalChatIds: string[],
): ModulePluginHostShape {
  return {
    config: { get: async () => undefined }, secrets: { get: async () => 'bot-token' },
    storage: {
      get: async key => state.get(key), list: async () => Object.fromEntries(state),
      set: async (key, value) => { const revision = (state.get(key)?.revision ?? 0) + 1; state.set(key, { revision, value }); return { revision }; },
      compareAndSet: async () => ({ applied: false }), delete: async key => ({ deleted: state.delete(key) }),
    },
    tasks: {} as never,
    media: { read: async input => ({ offset: input.offset, dataBase64: '', done: true }) },
    threads: {
      listBindings: async () => externalChatIds.map((key, index) => ({ key, threadId: 'thread-1', createdAt: index + 1 })),
      ensureByKey: async () => ({ id: 'thread-1' }),
    } as never,
    messaging: { subscribe: async () => undefined, unsubscribe: async () => undefined, send: async input => ({ messageId: 'message-1', threadId: input.threadId }) },
    log() {},
  };
}

function delivery(text = 'final body') {
  return {
    deliveryId: 'delivery-1', threadId: 'thread-1',
    presentation: { actor: { displayName: 'Cat', emoji: '🐱' }, thread: { shortId: 'thread-1' } },
    envelope: {
      messageId: 'message-1', revision: 1, threadId: 'thread-1',
      actor: { kind: 'cat', id: 'cat-1' }, audience: { kind: 'public' }, occurredAt: '2026-09-22T00:00:00.000Z',
      payload: { provenance: { origin: { kind: 'host' }, epistemicStatus: 'observation' }, elements: [{ elementId: 'text-1', kind: 'text', payload: { text } }] },
    },
  };
}

function started(lifecycleId = 'life-1') {
  return {
    lifecycleId, deliveryId: 'delivery-1', threadId: 'thread-1', state: 'started',
    presentation: { actor: { displayName: '砚砚', emoji: '🐱' }, thread: { shortId: 'thread-1' } },
  };
}

function transition(lifecycleId: string, state: string, deliveryId: string) {
  return { lifecycleId, deliveryId, threadId: 'thread-1', state };
}

function adapterWith(edits: unknown[][], sends: unknown[][], persistence?: InlineFinalPersistence) {
  let nextMessageId = 100;
  const outbound = new TelegramAdapter('123456:abcdefghij_ABC-123', { info() {}, warn() {}, error() {} }, persistence);
  outbound._injectBotApiSendMessage(async () => ({ message_id: nextMessageId++ }));
  outbound._injectBotApiEditMessage(async (...args: unknown[]) => { edits.push(args); });
  outbound._injectBotApiDeleteMessage(async () => {});
  outbound._injectSendMessage(async (...args: unknown[]) => { sends.push(args); });
  return outbound;
}

/** Mirrors the Host-backed persistence shape so restart hydration is exercised end to end. */
function persistenceInto(state: Map<string, { revision: number; value: unknown }>): InlineFinalPersistence {
  return {
    async save(entry) {
      const key = `tg-inline-final:${entry.lifecycleId}:${entry.externalChatId}`;
      state.set(key, { revision: (state.get(key)?.revision ?? 0) + 1, value: { version: 1, ...entry } });
    },
    async remove(lifecycleId, externalChatId) {
      state.delete(`tg-inline-final:${lifecycleId}:${externalChatId}`);
      state.delete(`tg-inline-final:${lifecycleId}`);
    },
    async saveConsumed(entry) {
      const key = `tg-inline-final-consumed:${entry.lifecycleId}:${entry.externalChatId}`;
      state.set(key, { revision: (state.get(key)?.revision ?? 0) + 1, value: { version: 1, ...entry } });
    },
    async removeConsumed(lifecycleId, externalChatId) {
      state.delete(`tg-inline-final-consumed:${lifecycleId}:${externalChatId}`);
    },
  };
}

function entrypointFor(outbound: TelegramAdapter) {
  return createTelegramPluginModule(() => ({
    outbound, async start() {}, async stop() {}, isPolling: () => true,
  }) as TelegramConnectorRuntime<TelegramAdapter>);
}

test('two chats bound to one thread keep separate placeholder correlation for the same lifecycle', async () => {
  const edits: unknown[][] = [];
  const sends: unknown[][] = [];
  const outbound = adapterWith(edits, sends);
  const entrypoint = entrypointFor(outbound);
  const active = await entrypoint.create(manifest).start(hostWithState(new Map(), ['42', '43']));
  const action = active.actions['host.messaging.lifecycle']!;
  // The started placeholder fans out to both bindings of the thread.
  await action(started());
  // Both chats registered a placeholder under the same lifecycleId; the second
  // registration must not evict the first.
  await active.actions['telegram.outbound']?.({ ...delivery(), lifecycleId: 'life-1' });
  assert.deepEqual(edits, [
    [42, 100, '【Cat🐱】\nfinal body', undefined],
    [43, 101, '【Cat🐱】\nfinal body', undefined],
  ], 'each chat final must edit that chat own placeholder');
  assert.deepEqual(sends, [], 'no chat final may fall back to a new message');
  await active.stop();
});

test('a second chat placeholder for the same lifecycle is still editable after the first chat final consumed', async () => {
  const edits: unknown[][] = [];
  const sends: unknown[][] = [];
  const outbound = adapterWith(edits, sends);
  outbound.registerInlinePlaceholder('42', '100', 'life-1');
  outbound.registerInlinePlaceholder('43', '200', 'life-1');
  await outbound.sendReply('42', 'chat 42 final', undefined, 'life-1');
  assert.equal(outbound.isInlineFinalConsumed('life-1', '42'), true);
  assert.equal(outbound.isInlineFinalConsumed('life-1', '43'), false, 'chat 43 placeholder must remain editable');
  await outbound.sendReply('43', 'chat 43 final', undefined, 'life-1');
  assert.deepEqual(edits, [
    [42, 100, 'chat 42 final', undefined],
    [43, 200, 'chat 43 final', undefined],
  ]);
  assert.deepEqual(sends, []);
});

test('persisted consumed marker survives a restart: catching_up does not rewrite the delivered body', async () => {
  const state = new Map<string, { revision: number; value: unknown }>();
  const edits1: unknown[][] = [];
  const sends1: unknown[][] = [];
  const active1 = await entrypointFor(adapterWith(edits1, sends1, persistenceInto(state))).create(manifest).start(hostWithState(state, ['42', '43']));
  await active1.actions['host.messaging.lifecycle']!(started());
  await active1.actions['telegram.outbound']?.({ ...delivery(), lifecycleId: 'life-1' });
  assert.equal(edits1.length, 2, 'both chat finals landed before the restart');
  // persistConsumed is fire-and-forget; flush microtasks before reading the store.
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(state.has('tg-inline-final-consumed:life-1:42'), 'consumed marker persisted for chat 42');
  assert.ok(state.has('tg-inline-final-consumed:life-1:43'), 'consumed marker persisted for chat 43');
  await active1.stop();

  // Simulated restart: a fresh adapter over the same store hydrates the markers.
  const edits2: unknown[][] = [];
  const sends2: unknown[][] = [];
  const active2 = await entrypointFor(adapterWith(edits2, sends2)).create(manifest).start(hostWithState(state, ['42', '43']));
  await active2.actions['host.messaging.lifecycle']!(transition('life-1', 'catching_up', 'delivery-2'));
  assert.deepEqual(edits2, [], 'catching_up must not rewrite the delivered bodies after a restart');
  assert.ok(sends2.every(args => !String(args[1]).includes('收到新消息')), 'no 收到新消息 rewrite may reach either chat');
  await active2.stop();
});

test('expired consumed markers are swept during hydration', async () => {
  const state = new Map<string, { revision: number; value: unknown }>();
  state.set('tg-inline-final-consumed:life-old:42', {
    revision: 1,
    value: { version: 1, lifecycleId: 'life-old', externalChatId: '42', consumedAt: Date.now() - 25 * 60 * 60 * 1000 },
  });
  const edits: unknown[][] = [];
  const sends: unknown[][] = [];
  const outbound = adapterWith(edits, sends);
  const active = await entrypointFor(outbound).create(manifest).start(hostWithState(state, ['42']));
  assert.equal(outbound.isInlineFinalConsumed('life-old', '42'), false, 'expired marker must not hydrate');
  assert.equal(state.has('tg-inline-final-consumed:life-old:42'), false, 'expired marker must be swept');
  await active.stop();
});

test('a persistence save rejecting after feature revocation does not surface an unhandled rejection', async () => {
  let rejectSave!: (error: unknown) => void;
  const persistence: InlineFinalPersistence = {
    async save() { await new Promise<void>((_, reject) => { rejectSave = reject; }); },
    async remove() {},
    async saveConsumed() {},
    async removeConsumed() {},
  };
  // context.logger runs assertActive() and throws after feature revocation;
  // a throwing catch callback would turn into an unhandled rejection in the
  // shared Host process.
  const revokedLogger = {
    info() {},
    warn() { throw new Error('FeatureContextRevokedError'); },
    error() { throw new Error('FeatureContextRevokedError'); },
  };
  const outbound = new TelegramAdapter('123456:abcdefghij_ABC-123', revokedLogger, persistence);
  const failures: unknown[] = [];
  const onUnhandled = (reason: unknown) => { failures.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    outbound.registerInlinePlaceholder('42', '42', 'life-1');
    rejectSave(new Error('storage closed after revocation'));
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(failures, []);
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
});
