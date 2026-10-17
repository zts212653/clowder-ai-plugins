import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parse } from 'yaml';
import { validateManifest } from '../packages/plugin-contract/src/validation/manifest.ts';
import { createDingTalkPluginModule } from '../packages/connector-dingtalk/src/plugin-entrypoint.ts';
import { createFeishuPluginModule } from '../packages/connector-feishu/src/plugin-entrypoint.ts';
import { createWeComBotPluginModule } from '../packages/connector-wecom-bot/src/plugin-entrypoint.ts';
import { legacyRuntimeManifest as dingTalkRuntime } from '../packages/connector-dingtalk/src/runtime-manifest.ts';
import { legacyRuntimeManifest as feishuRuntime } from '../packages/connector-feishu/src/runtime-manifest.ts';
import { legacyRuntimeManifest as wecomRuntime } from '../packages/connector-wecom-bot/src/runtime-manifest.ts';

for (const [name, label, create, project] of [
  ['dingtalk', '钉钉', createDingTalkPluginModule, dingTalkRuntime],
  ['feishu', '飞书', createFeishuPluginModule, feishuRuntime],
  ['wecom-bot', '企业微信', createWeComBotPluginModule, wecomRuntime],
]) {
  test(`${name}: original full Host declaration coexists with the retained SDK validator`, async () => {
    const root = new URL(`../packages/connector-${name}/`, import.meta.url);
    const manifest = parse(await readFile(new URL('plugin.yaml', root), 'utf8'));
    const before = structuredClone(manifest);
    assert.deepEqual(manifest.permissions, { label });
    assert.equal(validateManifest(manifest).valid, true);
    const { validateManifest: validateRetained } = await import(new URL('node_modules/@clowder-ai/plugin-sdk/node_modules/@clowder-ai/plugin-contract/dist/index.js', root));
    assert.equal(validateRetained(manifest).valid, false, 'old Contract still refuses unknown Host metadata');
    const runtime = project(manifest);
    assert.equal(validateRetained(runtime).valid, true);
    assert.equal(Object.hasOwn(runtime, 'permissions'), false);
    for (const key of ['features', 'contributions', 'configuration', 'runtime', 'test']) assert.deepEqual(runtime[key], manifest[key], key);
    assert.equal(typeof create().create(manifest).start, 'function');
    assert.deepEqual(manifest, before, 'Host declaration cannot be mutated by runtime projection');
    if (name === 'feishu') {
      assert.deepEqual(manifest.steps.filter(step => step.mode).map(step => step.mode), ['webhook', 'websocket']);
      assert.equal(manifest.steps[2].text, '在「事件订阅」中配置请求地址并获取 Verification Token');
      assert.deepEqual(runtime.steps, manifest.steps.map(({ mode, ...step }) => step));
    }
  });
  test(`${name}: metadata projection cannot hide unknown execution fields or malformed original declarations`, async () => {
    const manifest = parse(await readFile(new URL(`../packages/connector-${name}/plugin.yaml`, import.meta.url), 'utf8'));
    for (const change of [
      { permissions: { label, grant: 'task.write' } },
      { permissions: { label: 1 } },
      { permissions: null },
      { steps: [{ text: 'Step', mode: 1 }] },
      { steps: [{ text: 'Step', mode: 'webhook', authority: 'forged' }] },
      { executionAuthority: 'forged' },
    ]) assert.throws(() => create().create({ ...manifest, ...change }));
  });
}

// Original HubConnectorConfigTab rendered guideSteps after mode filtering and
// omitted its final YAML instruction; the new generic plugin renderer shows all.
const guides = {
  dingtalk: [
    { text: '在钉钉开放平台创建企业内部应用，获取 App Key 和 App Secret' },
    { text: '在「机器人与消息推送」中开启机器人能力' },
  ],
  feishu: [
    { text: '在飞书开放平台创建企业自建应用，获取 App ID 和 App Secret' },
    { text: '选择连接模式：Webhook（需公网 URL）或 WebSocket（无需公网，推荐内网环境）' },
    { text: '在「事件订阅」中配置请求地址并获取 Verification Token', mode: 'webhook' },
    { text: '在「事件订阅」中选择「使用长连接接收事件」，无需 Verification Token', mode: 'websocket' },
  ],
  telegram: [
    { text: '在 Telegram 中找到 @BotFather，发送 /newbot 创建机器人' },
    { text: '复制生成的 Bot Token' },
  ],
  'wecom-agent': [
    { text: '点击上方链接登录企微管理后台 → 创建自建应用，获取 AgentId 和 Secret' },
    { text: '在「API 接收消息」中设置回调 URL、Token 和 EncodingAESKey' },
    { text: '回调 URL 需通过公网访问（可使用 Cloudflare Tunnel）' },
  ],
  'wecom-bot': [
    { text: '点击上方链接直接进入创建页 → 选「API 模式」→ 连接方式选「使用长连接」' },
    { text: '填写名称和可见范围，保存后获取 Bot ID 和 Secret' },
  ],
  weixin: [
    { text: '点击「生成二维码」按钮' },
    { text: '使用微信扫描二维码并确认授权' },
  ],
  xiaoyi: [
    { text: '在小艺开放平台创建 OpenClaw 模式智能体，获取 AK/SK 和 Agent ID' },
    // Saving now reloads configuration according to enabled intent.
    { text: '填写以下配置并保存，启用后通过 WebSocket 连接华为 HAG' },
  ],
};
for (const [name, expected] of Object.entries(guides)) {
  test(`${name}: declaration contains only the original visible setup guide`, async () => {
    const manifest = parse(await readFile(new URL(`../packages/connector-${name}/plugin.yaml`, import.meta.url), 'utf8'));
    assert.deepEqual(manifest.steps, expected);
    assert.equal(manifest.steps.some(step => step.text.includes('重启')), false);
  });
}
