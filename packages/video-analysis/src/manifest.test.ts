import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { parse } from 'yaml';

test('plugin.yaml is the static access protocol and matches the package version', async () => {
  const manifest = parse(
    await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8'),
  ) as Record<string, unknown>;
  const packageJson = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string };

  assert.equal(manifest['version'], packageJson.version);
  assert.equal(manifest['contractVersion'], '0.1.0-beta.13');
  assert.deepEqual(manifest['description'], {
    default: 'Analyze remote videos through configured Gemini or Zhipu providers.',
    translations: {
      'zh-CN': '通过已配置的 Gemini 或智谱视觉模型分析远程视频。',
    },
  });
  assert.deepEqual(manifest['icon'], { type: 'svg', src: 'assets/icon.svg' });
  const icon = await readFile(new URL('../assets/icon.svg', import.meta.url), 'utf8');
  assert.match(icon, /^<svg\b/);
  assert.doesNotMatch(icon, /<script\b|<foreignObject\b|\bon[a-z]+\s*=|(?:href|src)\s*=\s*["']https?:/i);
  const features = manifest['features'] as Array<Record<string, unknown>>;
  assert.deepEqual(features[0]?.['contributions'], [
    { type: 'mcp', id: 'video-analysis-toolset' },
  ]);
});
