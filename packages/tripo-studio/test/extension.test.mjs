import assert from 'node:assert/strict';
import test from 'node:test';
import { VERSION } from '../plugins/tripo-studio/runtime/contract.mjs';

test('extension refuses operations until a matching native ready handshake', async (t) => {
  let nativeMessage;
  let reads = 0;
  const replies = [];
  const pageUrl = 'https://studio.tripo3d.ai/3d-model/11111111-1111-4111-8111-111111111111';
  const previous = globalThis.chrome;
  t.after(() => {
    globalThis.chrome = previous;
  });
  globalThis.chrome = {
    runtime: {
      connectNative: () => ({
        onDisconnect: { addListener() {} },
        onMessage: {
          addListener(listener) {
            nativeMessage = listener;
          },
        },
        postMessage: (message) => replies.push(message),
      }),
      onStartup: { addListener() {} },
      onMessage: { addListener() {} },
    },
    storage: { local: { get: async () => ({ grants: [{ tabId: 1, pageUrl }] }), set: async () => {} } },
    windows: { getAll: async () => [] },
    tabs: { get: async () => ({ url: pageUrl }) },
    scripting: {
      executeScript: async () => {
        reads++;
        return [{ result: { pageUrl, resources: [] } }];
      },
    },
  };
  await import('../plugins/tripo-studio/extension/background.mjs');
  await nativeMessage({ v: 1, id: 'before-ready', op: 'observe' });
  assert.equal(replies.at(-1).error, 'HELPER_NOT_READY');
  await nativeMessage({ v: 1, kind: 'ready', version: '0.0.0' });
  await nativeMessage({ v: 1, id: 'mismatch', op: 'observe' });
  assert.equal(replies.at(-1).error, 'HELPER_VERSION_MISMATCH');
  assert.equal(reads, 0);
  await nativeMessage({ v: 1, kind: 'ready', version: VERSION });
  await nativeMessage({ v: 1, id: 'matching', op: 'observe' });
  assert.equal(replies.at(-1).result.version, VERSION);
  assert.equal(reads, 1);
});
