import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { parse } from 'yaml';

test('manifest and package metadata remain one exact package truth', async () => {
  const manifest = parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8')) as Record<string, unknown>;
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
    files: string[];
  };

  assert.equal(manifest['version'], packageJson.version);
  assert.equal(manifest['contractVersion'], '0.1.0');
  assert.deepEqual(manifest['description'], {
    default: 'Submit and track image or video generation jobs through a configured provider.',
    translations: { 'zh-CN': '通过已配置的提供商提交并跟踪图片或视频生成任务。' },
  });
  const description = manifest['description'] as { default: string; translations: Record<string, string> };
  for (const introduction of [description.default, ...Object.values(description.translations)]) {
    assert.ok([...introduction].length <= 100);
  }
  for (const member of ['README.md', 'plugin.yaml', 'protocols', 'assets']) {
    assert.ok(packageJson.files.includes(member), `package omits ${member}`);
  }
  const icon = await readFile(new URL('../assets/icon.svg', import.meta.url), 'utf8');
  assert.match(icon, /^<svg\b/);
  assert.doesNotMatch(icon, /<script\b|<foreignObject\b|\bon[a-z]+\s*=|(?:href|src)\s*=\s*["']https?:/i);
});

test('manifest keeps provider credentials behind config/secret capabilities', async () => {
  const manifest = parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8')) as {
    contributions: Array<Record<string, unknown>>;
    features: Array<Record<string, unknown>>;
  };
  const contribution = manifest.contributions[0] as { environment: Record<string, { source: string }> };
  assert.equal(contribution.environment.VIDEO_GEN_PROVIDER?.source, 'config');
  for (const key of ['VIDEO_GEN_API_KEY', 'VIDEO_GEN_ACCESS_KEY', 'VIDEO_GEN_SECRET_KEY']) {
    assert.equal(contribution.environment[key]?.source, 'secret');
  }
  assert.deepEqual(manifest.features[0]?.capabilities, ['plugin.config.read', 'secret.read']);
});
