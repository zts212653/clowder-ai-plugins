import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import type { ModulePluginHostShape } from '@clowder-ai/plugin-sdk';
import { parse } from 'yaml';

import { createWeChatVisibleReaderPluginModule } from './plugin-entrypoint.js';
import type { WeChatVisibleReaderNativeRunner } from './native-runner.js';

const manifest = parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8'));

function host() {
  const entries = new Map<string, { revision: number; value: unknown }>();
  let revision = 0;
  const storage: ModulePluginHostShape['storage'] = {
    get: async (key) => entries.get(key),
    list: async () => Object.fromEntries(entries),
    set: async (key, value) => {
      const next = ++revision;
      entries.set(key, { revision: next, value });
      return { revision: next };
    },
    compareAndSet: async (key, expected, value) => {
      if ((entries.get(key)?.revision ?? null) !== expected) return { applied: false };
      const next = ++revision;
      entries.set(key, { revision: next, value });
      return { applied: true, revision: next };
    },
    delete: async (key) => ({ deleted: entries.delete(key) }),
  };
  return {
    storage,
    config: { get: async () => undefined },
    secrets: { get: async () => undefined },
    tasks: {} as ModulePluginHostShape['tasks'],
    threads: {} as ModulePluginHostShape['threads'],
    messaging: {} as ModulePluginHostShape['messaging'],
    log: () => undefined,
  } satisfies ModulePluginHostShape;
}

function runner(reads: { visible: number; recent: number }): WeChatVisibleReaderNativeRunner {
  return {
    read: async () => {
      reads.visible += 1;
      return { ok: false, error: { code: 'capture_failed', userAction: 'test refusal' } };
    },
    readConversationRecent: async () => {
      reads.recent += 1;
      return { ok: false, error: { code: 'navigation_failed', userAction: 'test refusal' } };
    },
    probe: async () => ({ ok: false, error: { code: 'capture_failed', userAction: 'test refusal' } }),
    navigationSpike: async () => ({
      ok: true,
      targetHeaderMatched: true,
      restore: { conversationRestored: true, scrollAnchorRestored: true, frontApplicationRestored: true },
    }),
  };
}

test('module exposes two frozen limb handlers and three arm operations without trusting input identity', async () => {
  const reads = { visible: 0, recent: 0 };
  const module = createWeChatVisibleReaderPluginModule({ createRunner: () => runner(reads) });
  const active = await module.create(manifest).start(host());
  assert.deepEqual(Object.keys(active.actions).sort(), [
    'wechat-visible-reader:read_visible_conversation',
    'wechat-visible-reader:read_conversation_recent',
    'wechat-visible-reader:arm',
    'wechat-visible-reader:disarm',
    'wechat-visible-reader:status',
  ].sort());

  assert.throws(
    () => active.actions['wechat-visible-reader:read_visible_conversation']!({ maxBlocks: 1 }),
    /must contain params/,
  );
  const visible = active.actions['wechat-visible-reader:read_visible_conversation']!;
  const before = await visible({ params: {}, invocation: { catId: 'cat-1' } });
  assert.equal((before.data as { ok: boolean }).ok, false);
  assert.equal(reads.visible, 0);

  const arm = await active.actions['wechat-visible-reader:arm']!({
    minutes: 10,
    input: { operator: 'forged-user', minutes: 30 },
  });
  assert.equal((arm.data as { armed: boolean }).armed, true);
  assert.equal(Object.hasOwn(arm.data as object, 'armedBy'), false);
  const status = await active.actions['wechat-visible-reader:status']!({ input: {} });
  assert.equal((status.data as { armed: boolean }).armed, true);
  assert.equal(((status.data as { remainingMs: number }).remainingMs <= 600_000), true);

  await visible({ params: {} });
  assert.equal(reads.visible, 1);
  const recent = active.actions['wechat-visible-reader:read_conversation_recent']!;
  const recentParams = {
    contact: '联系人', limit: 1,
    acknowledgeUiNavigation: true, acknowledgeMayMarkRead: true,
  };
  const denied = await recent({ params: recentParams, invocation: { catId: 'cat-1' } });
  assert.equal((denied.data as { error: { code: string } }).error.code, 'authorization_required');
  assert.equal(reads.recent, 0);
  const spoofed = await recent({
    params: {
      ...recentParams,
      invocation: {
        catId: 'cat-1', invocationId: 'inv-1', userId: 'owner',
        threadId: 'thread-1', userMessageId: 'message-1',
      },
    },
  });
  assert.equal((spoofed.data as { error: { code: string } }).error.code, 'authorization_required');
  assert.equal(reads.recent, 0);
  await recent({
    params: recentParams,
    invocation: {
      catId: 'cat-1', invocationId: 'inv-1', userId: 'owner',
      threadId: 'thread-1', userMessageId: 'message-1',
    },
  });
  assert.equal(reads.recent, 1);
  await active.actions['wechat-visible-reader:disarm']!({ input: {} });
  await visible({ params: {} });
  assert.equal(reads.visible, 1);
  await active.stop();
});

test('activation and disposal revoke a prior process arm', async () => {
  const runtimeHost = host();
  await runtimeHost.storage.set('visible-conversation-arm', {
    scope: 'visible-conversation', expiresAt: Date.now() + 600_000,
  });
  const module = createWeChatVisibleReaderPluginModule({ createRunner: () => runner({ visible: 0, recent: 0 }) });
  const active = await module.create(manifest).start(runtimeHost);
  assert.equal(((await active.actions['wechat-visible-reader:status']!({ input: {} })).data as { armed: boolean }).armed, false);
  await active.actions['wechat-visible-reader:arm']!({ minutes: 10, input: {} });
  await active.stop();
  assert.equal(await runtimeHost.storage.get('visible-conversation-arm'), undefined);
});
