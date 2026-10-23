import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { parse } from 'yaml';

test('manifest and package metadata remain one exact package truth', async () => {
  const manifest = parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8')) as {
    pluginId: string;
    version: string;
    contractVersion: string;
    description: { default: string; translations: Record<string, string> };
    contributions: Array<{ type: string; id: string; manifestPath?: string }>;
    configuration: Array<{ key: string; kind: string; actions: Array<{ action: { method: string } }> }>;
    runtime: { transport: string; entrypoint: string };
  };
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
    files: string[];
    os: string[];
  };

  assert.equal(manifest.pluginId, 'official.wechat-visible-reader');
  assert.equal(manifest.version, packageJson.version);
  assert.equal(manifest.contractVersion, '0.1.0');
  assert.deepEqual(packageJson.os, ['darwin']);
  assert.deepEqual(manifest.contributions, [
    { type: 'limb', id: 'wechat-visible-reader-limb', manifestPath: 'limbs/wechat-visible-reader.yml' },
  ]);
  assert.deepEqual(manifest.runtime, { transport: 'builtin', entrypoint: 'dist/plugin-entrypoint.js' });
  assert.equal(manifest.configuration[0]?.kind, 'operation');
  assert.deepEqual(manifest.configuration[0]?.actions.map(({ action }) => action.method), [
    'wechat-visible-reader:arm',
    'wechat-visible-reader:disarm',
    'wechat-visible-reader:status',
  ]);
  for (const value of [manifest.description.default, ...Object.values(manifest.description.translations)]) {
    assert.ok([...value].length <= 100);
  }
  for (const member of ['README.md', 'plugin.yaml', 'assets', 'limbs', 'native', 'dist']) {
    assert.ok(packageJson.files.includes(member), `package omits ${member}`);
  }
  const readme = await readFile(new URL('../README.en.md', import.meta.url), 'utf8');
  const chinese = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  assert.ok(packageJson.files.includes('README.en.md'));
  assert.match(chinese, /短期读取授权/u);
  assert.match(chinese, /授权记录只包含范围和到期时间/u);
  assert.match(chinese, /指标只记录成功、失败和错误类型，不保留 OCR 文字、联系人、会话标识、消息摘要或截图/u);
  assert.match(chinese, /期限为 1[–-]30 分钟/u);
  assert.match(chinese, /不可读或过期的记录不能授权/u);
  assert.match(readme, /short-lived authorization/i);
  assert.match(readme, /scope and expiry only/i);
  assert.match(readme, /never an\s+operator identity, message text or screenshot/i);
  assert.match(readme, /expires after 1[–-]30 minutes/i);
  assert.match(readme, /expired or unreadable\s+record cannot authorize a read/i);
  assert.match(readme, /Metrics retain success\/failure outcomes and typed error counts, never\s+OCR text, message hashes, screenshots, contacts, or conversation identifiers/i);
  assert.match(readme, /currently visible in the\s+desktop WeChat/i);
});
