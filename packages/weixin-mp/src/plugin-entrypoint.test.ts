import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import type { ModulePluginHostShape } from '@clowder-ai/plugin-sdk';
import { parse } from 'yaml';

import { createWeixinMpPluginModule } from './plugin-entrypoint.js';
import type { InvokeContext, InvokeHandler, TokenManager } from './handlers.js';

const limbMethods = [
  'weixin-mp:check_status',
  'weixin-mp:convert_markdown',
  'weixin-mp:create_draft',
  'weixin-mp:update_draft',
  'weixin-mp:upload_image',
  'weixin-mp:upload_material',
] as const;

function host(): ModulePluginHostShape {
  return {
    config: { get: async (key) => (key === 'appId' ? 'wx-app-id' : undefined) },
    secrets: { get: async (key) => (key === 'appSecret' ? 'wx-app-secret' : undefined) },
    storage: {
      get: async () => undefined,
      list: async () => ({}),
      set: async () => ({ revision: 1 }),
      compareAndSet: async () => ({ applied: true, revision: 1 }),
      delete: async () => ({ deleted: true, revision: 1 }),
    },
    tasks: {} as ModulePluginHostShape['tasks'],
    threads: {} as ModulePluginHostShape['threads'],
    messaging: {} as ModulePluginHostShape['messaging'],
    log: () => undefined,
  };
}

test('default module exposes every declared limb handler and an honest Manager test action', async () => {
  const manifest = parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8'));
  const calls: Array<{ method: string; input: unknown; context: InvokeContext }> = [];
  let invalidations = 0;
  const tokenManager: TokenManager = {
    getAccessToken: async () => 'token',
    invalidateAccessToken: async () => {
      invalidations += 1;
    },
    isTokenExpiredError: () => false,
  };
  const handlers = Object.fromEntries(
    limbMethods.map((method) => [
      method,
      (async (input, context) => {
        calls.push({ method, input, context });
        if (method === 'weixin-mp:check_status') {
          return { success: true, data: { status: 'connected' } };
        }
        return { success: true, data: { method } };
      }) satisfies InvokeHandler,
    ]),
  );
  const entrypoint = createWeixinMpPluginModule({
    createHandlers: () => handlers,
    createTokenManager: () => tokenManager,
  });
  const active = await entrypoint.create(manifest).start(host());

  assert.deepEqual(Object.keys(active.actions).sort(), [...limbMethods, 'weixin-mp:test_connection'].sort());
  assert.deepEqual(await active.actions['weixin-mp:create_draft']!({
    params: { title: 'Hello' },
    invocation: { catId: 'cat-eqdvbcxw', invocationId: 'inv-1' },
  }), {
    success: true,
    data: { method: 'weixin-mp:create_draft' },
  });
  assert.deepEqual(calls[0], {
    method: 'weixin-mp:create_draft',
    input: { title: 'Hello' },
    context: {
      pluginConfig: {
        WEIXIN_MP_APP_ID: 'wx-app-id',
        WEIXIN_MP_APP_SECRET: 'wx-app-secret',
      },
      tokenManager,
    },
  });
  assert.deepEqual(await active.actions['weixin-mp:test_connection']!({}), {
    ok: true,
    message: 'WeChat Official Account is connected',
    details: { status: 'connected' },
  });
  await assert.rejects(
    async () => active.actions['weixin-mp:create_draft']!({ title: 'raw params are not the Host envelope' }),
    /must contain params/,
  );
  await active.stop();
  await active.stop();
  assert.equal(invalidations, 1);
});

test('module fails closed before exposing actions when Host configuration is incomplete', async () => {
  const manifest = parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8'));
  const missingSecret = { ...host(), secrets: { get: async () => undefined } };
  const entrypoint = createWeixinMpPluginModule({
    createHandlers: () => ({}),
    createTokenManager: () => {
      throw new Error('must not create token manager');
    },
  });
  await assert.rejects(entrypoint.create(manifest).start(missingSecret), /appSecret must be a declared secret/);
});
