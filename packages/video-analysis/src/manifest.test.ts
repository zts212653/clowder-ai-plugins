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
  assert.equal(
    manifest['contractVersion'],
    '0.1.0',
    'manifest declares the Host compatibility line, not the contract npm version',
  );
  assert.deepEqual(manifest['description'], {
    default: 'Send one remote HTTPS video URL and a prompt to the configured provider for analysis.',
    translations: {
      'zh-CN': '将一个远程 HTTPS 视频 URL 和提示词交给已配置的提供商分析。',
    },
  });
  const description = manifest['description'] as {
    default: string;
    translations: Record<string, string>;
  };
  for (const introduction of [description.default, ...Object.values(description.translations)]) {
    assert.ok([...introduction].length <= 100, 'Agent introduction exceeds 100 characters');
  }
  assert.deepEqual(manifest['icon'], { type: 'svg', src: 'assets/icon.svg' });
  const icon = await readFile(new URL('../assets/icon.svg', import.meta.url), 'utf8');
  assert.match(icon, /^<svg\b/);
  assert.doesNotMatch(icon, /<script\b|<foreignObject\b|\bon[a-z]+\s*=|(?:href|src)\s*=\s*["']https?:/i);
  const features = manifest['features'] as Array<Record<string, unknown>>;
  assert.deepEqual(features[0]?.['contributions'], [
    { type: 'mcp', id: 'video-analysis-toolset' },
  ]);
});

test('package ships a detailed human capability guide beside the short Agent introduction', async () => {
  const packageJson = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { files: string[] };
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');

  assert.ok(packageJson.files.includes('README.md'));
  assert.match(readme, /^# Video Analysis\n/m);
  for (const heading of [
    '## What it does',
    '## Configuration',
    '## Provider defaults',
    '## Security and data flow',
    '## Limits and failure behavior',
  ]) {
    assert.ok(readme.includes(heading), `README is missing ${heading}`);
  }
});
