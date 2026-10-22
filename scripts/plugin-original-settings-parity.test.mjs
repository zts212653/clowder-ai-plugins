import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parse } from 'yaml';

const manifest = async (name) => parse(await readFile(new URL(`../packages/${name}/plugin.yaml`, import.meta.url), 'utf8'));

// Original declarations: core bb9f9f08ec574ee8888fbde9819ff95da96bb614,
// packages/api/src/plugins/{github,video-analysis,video-gen,weixin-mp,wechat-visible-reader}/plugin.yaml.
test('video analysis exposes the original authentication choice to its actual MCP process', async () => {
  const value = await manifest('video-analysis');
  const field = value.configuration.find((field) => field.key === 'authType');
  assert.deepEqual(field?.options.map((option) => option.value), ['apikey', 'query-param']);
  assert.equal(field.required, true);
  assert.deepEqual(value.contributions[0].environment.VIDEO_ANALYSIS_AUTH_TYPE, { source: 'config', key: 'authType' });
});

test('video generation preserves credential requirements for each original authentication mode', async () => {
  const value = await manifest('video-generation');
  for (const key of ['apiKey', 'accessKey', 'secretKey']) {
    const field = value.configuration.find((field) => field.key === key);
    assert.equal(field.required, true);
    assert.equal(field.requiredWhen, undefined);
  }
  const variants = value.configurationVariants;
  assert.equal(variants.discriminator, 'authType');
  const branchFields = Object.fromEntries(variants.branches.map((branch) => [branch.id, branch.fields]));
  assert.deepEqual(branchFields.apikey, ['apiKey']);
  assert.deepEqual(branchFields.jwt, ['accessKey', 'secretKey']);
  assert.deepEqual(branchFields.hmac, ['accessKey', 'secretKey']);
});

for (const [name, texts] of [
  ['weixin-mp', ['在微信公众平台注册/登录，获取 App ID 和 App Secret', '目前支持已认证的服务号，订阅号不支持部分接口']],
  ['wechat-visible-reader', ['启用插件后，在 Mac 微信中选中需要猫查看的会话',
    '展开插件并阅读隐私披露，再授权读取 10 分钟', '回到目标 Clowder AI thread，对猫说“看一下微信”']],
]) {
  test(`${name} retains its original setup instructions`, async () => {
    assert.deepEqual((await manifest(name)).steps?.map((step) => step.text), texts);
  });
}

test('GitHub fresh setup has no migration-only import operations', async () => {
  const value = await manifest('github-operations');
  assert.deepEqual(value.configuration.filter((field) => /^legacy/.test(field.key)), []);
  assert.match(value.steps[0].text, /无需填写访问令牌/);
  assert.match(value.steps[1].text, /登记/);
  assert.match(value.steps[2].text, /全部留空/);
});

// Original owner disclosure: core bb9f9f08, WeChatVisibleReaderArmControl.tsx:103–107.
test('visible reader explains the original context, trace and foreground effects before authorization', async () => {
  const value = await manifest('wechat-visible-reader');
  const text = value.configuration.find((field) => field.key === 'visibleReadingAuthorization').description;
  for (const phrase of ['不会保存截图', '模型上下文', 'invocation trace', '未读', '前台 app']) assert.ok(text.includes(phrase), phrase);
});
