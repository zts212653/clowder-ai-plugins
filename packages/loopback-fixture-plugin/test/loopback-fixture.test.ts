import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { loadStandaloneManifest } from '@clowder-ai/plugin-sdk';

const manifestUrl = new URL('../manifest.json', import.meta.url);
const packageUrl = new URL('../package.json', import.meta.url);
const sourceUrl = new URL('../src/plugin.ts', import.meta.url);
const entrypointUrl = new URL('../dist/plugin.js', import.meta.url);

interface ChildResult {
  readonly code: number | null;
  readonly stderr: string;
  readonly stdout: Buffer;
}

async function runFixtureChild(input: readonly Buffer[]): Promise<ChildResult> {
  const child = spawn(process.execPath, [entrypointUrl.pathname], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));

  for (const chunk of input) child.stdin.write(chunk);
  child.stdin.end();

  const [code] = (await once(child, 'close')) as [number | null];
  return {
    code,
    stderr: Buffer.concat(stderr).toString('utf8'),
    stdout: Buffer.concat(stdout),
  };
}

test('loads its legal stdio manifest through the public SDK entrypoint', async () => {
  const manifest = await loadStandaloneManifest(manifestUrl);
  assert.equal(manifest.pluginId, 'dev.clowder.loopback-fixture');
  assert.deepEqual(manifest.runtime, { transport: 'stdio', entrypoint: 'dist/plugin.js' });
});

test('echoes an arbitrary legal NDJSON frame through a real private-plugin child', async () => {
  const result = await runFixtureChild([
    Buffer.from('{"fixture":"loopback","nested":[1,{"ok":true}]}\n', 'utf8'),
  ]);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout.toString('utf8')), {
    type: 'echo',
    payload: { fixture: 'loopback', nested: [1, { ok: true }] },
  });
});

test('is private and imports the SDK only through its public package entrypoint', async () => {
  const packageJson = JSON.parse(await readFile(packageUrl, 'utf8')) as {
    readonly private?: unknown;
    readonly dependencies?: Record<string, string>;
  };
  const source = await readFile(sourceUrl, 'utf8');

  assert.equal(packageJson.private, true);
  assert.deepEqual(packageJson.dependencies, { '@clowder-ai/plugin-sdk': 'workspace:*' });
  assert.match(source, /from '@clowder-ai\/plugin-sdk';/);
  assert.doesNotMatch(source, /from ['"](?:@clowder-ai\/plugin-contract|\.\.?\/)/);
});
