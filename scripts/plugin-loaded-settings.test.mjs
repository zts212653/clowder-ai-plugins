import assert from 'node:assert/strict';
import { readFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { createWeixinPluginModule } from '../packages/connector-weixin/src/plugin-entrypoint.ts';
import { WeixinAdapter } from '../packages/connector-weixin/src/WeixinAdapter.ts';
import { createFeishuPluginModule } from '../packages/connector-feishu/src/plugin-entrypoint.ts';
import { createWeComBotPluginModule } from '../packages/connector-wecom-bot/src/plugin-entrypoint.ts';
import { createPersonalChromePluginModule } from '../packages/personal-chrome-companion/src/plugin-entrypoint.ts';
import { authorizePersonalChromeConversation, readPersonalChromeConversationAuthorizations } from '../packages/personal-chrome-companion/native-host/conversation-binding.mjs';
import { createWeixinMpPluginModule } from '../packages/weixin-mp/src/plugin-entrypoint.ts';

const manifest = async name => parse(await readFile(new URL(`../packages/${name}/plugin.yaml`, import.meta.url), 'utf8'));
function host(values = {}, secrets = {}) {
  const stored = new Map();
  return { pluginInstanceId: 'isolated-settings-instance', config: { get: async key => values[key] },
    secrets: { get: async key => secrets[key] }, log() {}, storage: {
      get: async key => stored.get(key), set: async (key, value) => { stored.set(key, { value, revision: 1 }); return { revision: 1 }; },
      list: async () => Object.fromEntries(stored), delete: async key => ({ deleted: stored.delete(key) }),
      compareAndSet: async () => { throw Error('unexpected CAS'); },
    } };
}
const noRuntime = () => { throw Error('settings must not construct the messaging runtime'); };
const state = result => ({ lastResult: result });

test('Weixin QR survives settings disposal and repeated polls without starting runtime', async () => {
  const generate = WeixinAdapter.fetchQrCode, poll = WeixinAdapter.pollQrCodeStatus;
  let polls = 0;
  WeixinAdapter.fetchQrCode = async () => ({ qrUrl: 'https://fixture.example/qr', qrPayload: 'original-weixin-challenge' });
  WeixinAdapter.pollQrCodeStatus = async payload => { assert.equal(payload, 'original-weixin-challenge'); return ++polls === 1 ? { status: 'waiting' } : { status: 'confirmed', botToken: 'confirmed-token' }; };
  try {
    const entry = createWeixinPluginModule(noRuntime), declaration = await manifest('connector-weixin'), ports = host();
    let settings = await entry.create(declaration).settings(ports);
    assert.equal((await settings.actions['weixin.qr-status']({ input: { qrPayload: 'forged-body' } })).advance, false);
    assert.equal(polls, 0);
    let result = await settings.actions['weixin.qr-generate']({ input: {} });
    assert.match(result.data.url, /^data:image\/png/); assert.equal(result.data.qrPayload, 'original-weixin-challenge');
    await settings.dispose?.();
    settings = await entry.create(declaration).settings(ports);
    result = await settings.actions['weixin.qr-status']({ input: {}, operationState: state(result) });
    assert.equal(result.advance, false); assert.equal(result.data.qrPayload, 'original-weixin-challenge');
    await settings.dispose?.(); settings = await entry.create(declaration).settings(ports);
    result = await settings.actions['weixin.qr-status']({ input: {}, operationState: state(result) });
    assert.deepEqual(result.targetValues, { botToken: 'confirmed-token' });
    await ports.storage.set('provider-session', { getUpdatesBuf: 'old-cursor' });
    assert.deepEqual((await settings.actions['weixin.disconnect']({ input: {} })).targetValues, { botToken: '' });
    assert.equal((await ports.storage.get('provider-session')).value, null);
    assert.equal(Object.keys(settings.actions).some(key => /outbound|permissions|media/.test(key)), false);
  } finally { WeixinAdapter.fetchQrCode = generate; WeixinAdapter.pollQrCodeStatus = poll; }
});

test('Feishu QR uses persisted operationState through fresh settings instances', async () => {
  let polls = 0;
  const entry = createFeishuPluginModule(noRuntime, () => ({ create: async () => ({ qrUrl: 'data:image/png;base64,cXI=', qrPayload: 'original-device-code' }),
    poll: async payload => { assert.equal(payload, 'original-device-code'); return ++polls === 1 ? { status: 'waiting' } : { status: 'confirmed', appId: 'new-app', appSecret: 'new-secret' }; } }));
  const declaration = await manifest('connector-feishu'), ports = host();
  let settings = await entry.create(declaration).settings(ports);
  assert.equal((await settings.actions['feishu.qr-status']({ input: { qrPayload: 'forged-body' } })).advance, false);
  assert.equal(polls, 0);
  let result = await settings.actions['feishu.qr-generate']({ input: {} });
  assert.equal(result.data.qrPayload, 'original-device-code');
  settings = await entry.create(declaration).settings(ports);
  result = await settings.actions['feishu.qr-status']({ input: {}, operationState: state(result) });
  assert.equal(result.advance, false); assert.equal(result.data.qrPayload, 'original-device-code');
  settings = await entry.create(declaration).settings(ports);
  result = await settings.actions['feishu.qr-status']({ input: {}, operationState: state(result) });
  assert.deepEqual(result.targetValues, { appId: 'new-app', appSecret: 'new-secret', connectionMode: 'websocket' });
  assert.deepEqual((await settings.actions['feishu.disconnect']({ input: {} })).targetValues, { appId: '', appSecret: '' });
});

test('WeCom validate uses unsaved input and saved secret without connecting a runtime', async () => {
  const calls = [];
  const entry = createWeComBotPluginModule(noRuntime, async (id, secret) => { calls.push([id, secret]); return { valid: id === 'valid' }; });
  const settings = await entry.create(await manifest('connector-wecom-bot')).settings(host({ botId: 'saved' }, { botSecret: 'saved-secret' }));
  const rejected = await settings.actions['wecom-bot.validate']({ input: { botId: 'invalid' } });
  assert.equal(rejected.advance, false); assert.equal(rejected.targetValues, undefined);
  const result = await settings.actions['wecom-bot.validate']({ input: { botId: 'valid' } });
  assert.deepEqual(result.targetValues, { botId: 'valid', botSecret: 'saved-secret' });
  assert.deepEqual(calls, [['invalid', 'saved-secret'], ['valid', 'saved-secret']]);
  assert.equal((await settings.actions['wecom-bot.validate']({ input: { botId: 'valid', botSecret: '' } })).advance, false);
  assert.equal(calls.length, 2, 'explicit empty credentials cannot silently reuse the saved secret');
  assert.deepEqual((await settings.actions['wecom-bot.disconnect']({ input: {} })).targetValues, { botId: '', botSecret: '' });
});

test('Official Account test reuses its check_status handler without activating limb methods', async () => {
  let invalidated = 0, checked = 0;
  const entry = createWeixinMpPluginModule({ createTokenManager: () => ({ getAccessToken: async () => 'token', invalidateAccessToken: async () => { invalidated++; }, isTokenExpiredError: () => false }),
    createHandlers: () => ({ 'weixin-mp:check_status': async (_input, context) => { checked++; assert.equal(context.pluginConfig.WEIXIN_MP_APP_ID, 'app'); return { success: true, data: { status: 'connected' } }; } }) });
  const settings = await entry.create(await manifest('weixin-mp')).settings(host({ appId: 'app' }, { appSecret: 'secret' }));
  assert.deepEqual(Object.keys(settings.actions), ['weixin-mp:test_connection']);
  assert.equal((await settings.actions['weixin-mp:test_connection']({ input: {} })).ok, true);
  await settings.dispose?.(); assert.equal(checked, 1); assert.equal(invalidated, 1);
});


test('Chrome loaded settings read and revoke the same authorization file without registering runtime', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'loaded-chrome-settings-'));
  try {
    const entry = createPersonalChromePluginModule(), declaration = await manifest('personal-chrome-companion');
    assert.throws(() => entry.create(declaration).settings({ log() {} }), /data.directory/);
    const settings = entry.create(declaration).settings({ dataDirectory: directory, log() {} });
    assert.deepEqual(await readdir(directory), [], 'settings construction cannot install helpers, copy extension assets or register a runtime');
    assert.equal((await settings.actions['personal-chrome-host.test']({ input: {} })).ok, false);
    const file = join(directory, 'conversation-binding.json');
    await authorizePersonalChromeConversation(file, { conversationId: 'conversation-1', chatUrl: 'https://chatgpt.com/c/conversation-1',
      authorizedAt: '2026-10-15T00:00:00.000Z', updatedAt: '2026-10-15T00:00:00.000Z' });
    const listed = await settings.actions['personal-chrome-host.authorizations.list']({ input: {} });
    assert.match(JSON.stringify(listed), /conversation-1/);
    await settings.actions['personal-chrome-host.authorizations.revoke']({ input: { conversationId: 'conversation-1' } });
    assert.deepEqual((await readPersonalChromeConversationAuthorizations(file)).conversations, []);
    assert.equal(Object.keys(settings.actions).some(key => /append-message|assistant-returns/.test(key)), false);
    await settings.dispose();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('unconfigured Official Account test retains the original not_configured result without token I/O', async () => {
  const entry = createWeixinMpPluginModule({ createTokenManager: () => ({ getAccessToken: async () => { throw Error('unconfigured test must not fetch'); }, invalidateAccessToken() {}, isTokenExpiredError: () => false }) });
  const settings = await entry.create(await manifest('weixin-mp')).settings(host());
  const result = await settings.actions['weixin-mp:test_connection']({ input: {} });
  assert.equal(result.ok, false); assert.equal(result.details.status, 'not_configured');
  await settings.dispose?.();
});
