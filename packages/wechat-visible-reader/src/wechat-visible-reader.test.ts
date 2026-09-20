import assert from 'node:assert/strict';
import test from 'node:test';

import { createWeChatVisibleReaderHandlers } from './handlers.js';
import {
  createWeChatVisibleReaderNativeRunner,
  type NativeCommandExecutor,
  type WeChatVisibleReaderNativeRunner,
} from './native-runner.js';
import { WeChatVisibleReaderArmStore } from './WeChatVisibleReaderArmStore.js';
import { WeChatVisibleReaderMetrics } from './WeChatVisibleReaderMetrics.js';

const rect = { x: 0.1, y: 0.1, width: 0.8, height: 0.8 };

function successfulRead(text = 'target text') {
  return {
    ok: true as const,
    captureId: 'capture-1',
    capturedAt: '2026-07-17T03:00:00.000Z',
    source: {
      bundleId: 'com.tencent.xinWeChat' as const,
      wechatVersion: '4.1.11',
      windowSize: { width: 1280, height: 900 },
    },
    layout: { profileId: 'wechat-4.1.11-main', confidence: 0.98, bodyRegion: rect },
    messageUnits: [
      {
        blockType: 'text' as const,
        isPartial: false as const,
        text,
        bbox: rect,
        ocrConfidence: 0.99,
        layoutConfidence: 0.98,
        presumedSender: 'other' as const,
        blockHash: 'a'.repeat(64),
      },
    ],
    totalChars: [...text].length,
    truncated: false,
    warnings: [] as string[],
  };
}

function makeHandlers(runner?: WeChatVisibleReaderNativeRunner) {
  const armStore = new WeChatVisibleReaderArmStore();
  const calls = { visible: 0, recent: 0 };
  const fixtureRunner: WeChatVisibleReaderNativeRunner = runner ?? {
    read: async () => {
      calls.visible += 1;
      return successfulRead();
    },
    readConversationRecent: async ({ contact }) => {
      calls.recent += 1;
      return {
        ...successfulRead(),
        targetHeader: contact,
        targetHeaderMatched: true,
        restore: {
          conversationRestored: true,
          scrollAnchorRestored: true,
          frontApplicationRestored: true,
        },
      };
    },
    probe: async () => ({
      ok: true,
      wechatVersion: '4.1.11',
      profileId: 'wechat-4.1.11-main',
      windowSize: { width: 1280, height: 900 },
    }),
    navigationSpike: async () => ({
      ok: true,
      targetHeaderMatched: true,
      restore: {
        conversationRestored: true,
        scrollAnchorRestored: true,
        frontApplicationRestored: true,
      },
    }),
  };
  const metrics = new WeChatVisibleReaderMetrics();
  return {
    armStore,
    calls,
    metrics,
    handlers: createWeChatVisibleReaderHandlers({ armStore, metrics, runner: fixtureRunner }),
  };
}

test('passive reads require a bounded local arm and expiry fails closed', async () => {
  let now = Date.parse('2026-09-19T00:00:00.000Z');
  const armStore = new WeChatVisibleReaderArmStore({ now: () => now });
  let reads = 0;
  const runner = {
    read: async () => {
      reads += 1;
      return successfulRead();
    },
    readConversationRecent: async () => successfulRead(),
    probe: async () => ({ ok: false as const, error: { code: 'capture_failed' as const, userAction: 'retry' } }),
    navigationSpike: async () => ({
      ok: true as const,
      targetHeaderMatched: true as const,
      restore: { conversationRestored: true, scrollAnchorRestored: true, frontApplicationRestored: true },
    }),
  };
  const handler = createWeChatVisibleReaderHandlers({
    armStore,
    metrics: new WeChatVisibleReaderMetrics(),
    runner,
  })['wechat-visible-reader:read_visible_conversation']!;

  assert.equal(((await handler({}, {})).data as { ok: boolean }).ok, false);
  assert.throws(() => armStore.arm({ operator: 'owner', minutes: 31 }), /between 1 and 30/);
  armStore.arm({ operator: 'owner', minutes: 1 });
  assert.equal(((await handler({}, {})).data as { ok: boolean }).ok, true);
  now += 60_001;
  assert.equal(((await handler({}, {})).data as { ok: boolean }).ok, false);
  assert.equal(reads, 1);
});

test('named navigation requires trusted owner provenance and both one-shot acknowledgements', async () => {
  const { handlers, calls } = makeHandlers();
  const handler = handlers['wechat-visible-reader:read_conversation_recent']!;
  const trusted = {
    invocation: {
      catId: 'cat-eqdvbcxw',
      invocationId: 'invocation-1',
      userId: 'owner-user',
      threadId: 'thread-f202',
      userMessageId: 'message-1',
    },
  };
  const valid = {
    contact: ' 测试联系人 ',
    limit: 30,
    acknowledgeUiNavigation: true,
    acknowledgeMayMarkRead: true,
  };

  for (const [params, context] of [
    [valid, {}],
    [{ ...valid, acknowledgeUiNavigation: false }, trusted],
    [{ ...valid, acknowledgeMayMarkRead: false }, trusted],
  ] as const) {
    const result = await handler(params, context);
    assert.equal((result.data as { error: { code: string } }).error.code, 'authorization_required');
  }
  for (const params of [
    { ...valid, contact: '' },
    { ...valid, contact: 'bad\ncontact' },
    { ...valid, limit: 0 },
    { ...valid, limit: 31 },
  ]) {
    const result = await handler(params, trusted);
    assert.equal((result.data as { error: { code: string } }).error.code, 'navigation_failed');
  }
  const accepted = await handler(valid, trusted);
  assert.equal((accepted.data as { ok: boolean }).ok, true);
  assert.equal(calls.recent, 1);
});

test('native runner validates code-point counts and never echoes malformed private output', async () => {
  const emoji = '🐱';
  const validRunner = createWeChatVisibleReaderNativeRunner({
    execute: async () => ({ stdout: JSON.stringify(successfulRead(emoji)) }),
  });
  assert.equal((await validRunner.read({ maxBlocks: 1, maxChars: 1 })).ok, true);

  const privateFragment = 'PRIVATE_WECHAT_BODY';
  const malformedRunner = createWeChatVisibleReaderNativeRunner({
    execute: async () => ({ stdout: `{bad:${privateFragment}` }),
  });
  const failure = await malformedRunner.read();
  assert.equal(failure.ok, false);
  assert.equal(failure.error.code, 'capture_failed');
  assert.doesNotMatch(JSON.stringify(failure), new RegExp(privateFragment));
});

test('default compilation uses only package-owned native sources and compiles once', async () => {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const execute: NativeCommandExecutor = async (file, args) => {
    calls.push({ file, args });
    if (file === '/usr/bin/xcrun') return { stdout: '' };
    return {
      stdout: JSON.stringify({
        ok: true,
        wechatVersion: '4.1.11',
        profileId: 'wechat-4.1.11-main',
        windowSize: { width: 1280, height: 900 },
      }),
    };
  };
  const runner = createWeChatVisibleReaderNativeRunner({
    sourceDigest: 'fixture-digest',
    cacheDirectory: '/safe/cache',
    execute,
  });

  assert.equal((await runner.probe()).ok, true);
  assert.equal((await runner.probe()).ok, true);
  const compile = calls.find(call => call.file === '/usr/bin/xcrun');
  assert.ok(compile);
  const sources = compile.args.slice(1, -2);
  assert.equal(sources.length, 7);
  for (const source of sources) {
    assert.match(source, /packages\/wechat-visible-reader\/native\/[^/]+\.swift$/);
    assert.doesNotMatch(source, /packages\/api\/src\/plugins/);
  }
  assert.equal(calls.filter(call => call.file === '/usr/bin/xcrun').length, 1);
});

test('metrics retain only aggregate outcomes, never visible message text', () => {
  const { metrics } = makeHandlers();
  const privateFragment = 'PRIVATE_WECHAT_BODY';
  for (let index = 0; index < 15; index += 1) metrics.record(successfulRead(privateFragment));
  for (let index = 0; index < 5; index += 1) {
    metrics.record({ ok: false, error: { code: 'layout_not_recognized', userAction: 'adjust the window' } });
  }
  const snapshot = metrics.snapshot();
  assert.deepEqual(snapshot, {
    totalReadAttempts: 20,
    totalSuccesses: 15,
    typedErrors: { layout_not_recognized: 5 },
    recentWindowSize: 20,
    recentSuccessRate: 0.75,
    layoutPauseRecommended: true,
  });
  assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(privateFragment));
});
