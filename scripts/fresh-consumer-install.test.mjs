import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(
    result.status,
    0,
    [command, ...args, result.stdout, result.stderr].filter(Boolean).join('\n'),
  );
  return result.stdout;
}

function pack(packageDirectory, destination) {
  const output = run(
    'node',
    ['scripts/pack-publish-artifact.mjs', packageDirectory, destination],
    repoRoot,
  );
  const [artifact] = JSON.parse(output);
  assert.equal(typeof artifact?.filename, 'string');
  return join(destination, artifact.filename);
}

test('packed public packages install and import in a fresh npm consumer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clowder-public-consumer-'));
  const packs = join(root, 'packs');
  const consumer = join(root, 'consumer');
  await mkdir(packs);
  await mkdir(consumer);

  try {
    for (const packageName of [
      '@clowder-ai/plugin-contract',
      '@clowder-ai/plugin-sdk',
      '@clowder-ai/feishu-meeting-intake',
    ]) {
      run('pnpm', ['--filter', packageName, 'build'], repoRoot);
    }

    const tarballs = [
      pack('packages/plugin-contract', packs),
      pack('packages/plugin-sdk', packs),
      pack('packages/feishu-meeting-intake', packs),
    ];

    const staged = join(root, 'staged');
    await mkdir(staged);
    run('tar', ['-xzf', tarballs[2], '-C', staged], root);
    const stagedPackage = join(staged, 'package');
    const stagedRunnerUrl = pathToFileURL(join(stagedPackage, 'dist/lark-cli-runner.js')).href;
    const stagedEntrypointUrl = pathToFileURL(join(stagedPackage, 'dist/stdio-entrypoint.js')).href;
    run(
      'node',
      [
        '--input-type=module',
        '--eval',
        `await import(${JSON.stringify(stagedEntrypointUrl)}); const { resolveBundledLarkCliEntrypoint } = await import(${JSON.stringify(stagedRunnerUrl)}); const runner = resolveBundledLarkCliEntrypoint(); if (!runner.endsWith('/@larksuite/cli/scripts/run.js')) process.exit(1);`,
      ],
      stagedPackage,
    );

    run(
      'npm',
      ['install', '--ignore-scripts', '--package-lock=false', ...tarballs],
      consumer,
    );

    const sdkPackage = JSON.parse(
      await readFile(join(consumer, 'node_modules/@clowder-ai/plugin-sdk/package.json'), 'utf8'),
    );
    const feishuPackage = JSON.parse(
      await readFile(
        join(consumer, 'node_modules/@clowder-ai/feishu-meeting-intake/package.json'),
        'utf8',
      ),
    );
    const feishuManifest = JSON.parse(
      await readFile(
        join(consumer, 'node_modules/@clowder-ai/feishu-meeting-intake/manifest.json'),
        'utf8',
      ),
    );
    assert.equal(sdkPackage.version, '0.1.0-beta.6');
    assert.equal(sdkPackage.dependencies['@clowder-ai/plugin-contract'], '0.1.0-beta.10');
    assert.equal(
      feishuPackage.dependencies['@clowder-ai/plugin-contract'],
      '0.1.0-beta.9',
    );
    assert.equal(feishuPackage.dependencies['@clowder-ai/plugin-sdk'], '0.1.0-beta.5');
    assert.equal(feishuPackage.dependencies['@larksuite/cli'], '1.0.85');
    assert.deepEqual(
      [...feishuPackage.bundledDependencies].sort(),
      Object.keys(feishuPackage.dependencies).sort(),
    );
    assert.equal(feishuManifest.version, feishuPackage.version);
    assert.deepEqual(feishuManifest.runtime, {
      transport: 'stdio',
      entrypoint: 'dist/entrypoint.js',
    });
    await readFile(
      join(consumer, 'node_modules/@clowder-ai/feishu-meeting-intake/dist/entrypoint.js'),
      'utf8',
    );

    run(
      'node',
      [
        '--input-type=module',
        '--eval',
        "await import('@clowder-ai/plugin-contract'); await import('@clowder-ai/plugin-sdk'); const plugin = await import('@clowder-ai/feishu-meeting-intake'); if (typeof plugin.createFeishuMeetingIntakeRuntime !== 'function') process.exit(1);",
      ],
      consumer,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
