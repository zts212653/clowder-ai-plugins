import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
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
    process.execPath,
    ['scripts/pack-publish-artifact.mjs', packageDirectory, destination],
    repoRoot,
  );
  const [artifact] = JSON.parse(output);
  assert.equal(typeof artifact?.filename, 'string');
  return join(destination, artifact.filename);
}

function runNpm(args, cwd) {
  const npmCli = process.env.CLOWDER_ARTIFACT_NPM_CLI;
  if (npmCli === undefined) return run('npm', args, cwd);
  assert.equal(isAbsolute(npmCli), true);
  return run(process.execPath, [npmCli, ...args], cwd);
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
      '@clowder-ai/personal-chrome-companion',
      '@clowder-ai/video-analysis',
      '@clowder-ai/genoffice-docx',
    ]) {
      run('pnpm', ['--filter', packageName, 'build'], repoRoot);
    }

    const tarballs = [
      pack('packages/plugin-contract', packs),
      pack('packages/plugin-sdk', packs),
      pack('packages/feishu-meeting-intake', packs),
      pack('packages/personal-chrome-companion', packs),
      pack('packages/video-analysis', packs),
      pack('packages/genoffice-docx', packs),
    ];

    const staged = join(root, 'staged');
    await mkdir(staged);
    run('tar', ['-xzf', tarballs[2], '-C', staged], root);
    const stagedPackage = join(staged, 'package');
    const stagedRunnerUrl = pathToFileURL(join(stagedPackage, 'dist/lark-cli-runner.js')).href;
    const stagedEntrypointUrl = pathToFileURL(join(stagedPackage, 'dist/stdio-entrypoint.js')).href;
    run(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `await import(${JSON.stringify(stagedEntrypointUrl)}); const { resolveBundledLarkCliEntrypoint } = await import(${JSON.stringify(stagedRunnerUrl)}); const runner = resolveBundledLarkCliEntrypoint(); if (!runner.endsWith('/@larksuite/cli/scripts/run.js')) process.exit(1);`,
      ],
      stagedPackage,
    );

    const stagedCompanion = join(root, 'staged-personal-chrome-companion');
    await mkdir(stagedCompanion);
    run('tar', ['-xzf', tarballs[3], '-C', stagedCompanion], root);
    const stagedCompanionPackage = join(stagedCompanion, 'package');
    const stagedCompanionManifest = JSON.parse(
      await readFile(join(stagedCompanionPackage, 'extension/manifest.json'), 'utf8'),
    );
    assert.equal(stagedCompanionManifest.manifest_version, 3);
    assert.equal(stagedCompanionManifest.key, undefined);
    assert.deepEqual(stagedCompanionManifest.permissions, ['nativeMessaging', 'tabs']);
    await readFile(join(stagedCompanionPackage, 'native-host/native-host-cli.mjs'), 'utf8');
    run(process.execPath, ['native-host/native-host-cli.mjs', '--help'], stagedCompanionPackage);

    const stagedVideo = join(root, 'staged-video-analysis');
    await mkdir(stagedVideo);
    run('tar', ['-xzf', tarballs[4], '-C', stagedVideo], root);
    const stagedVideoPackage = join(stagedVideo, 'package');
    const stagedVideoPackageJson = JSON.parse(
      await readFile(join(stagedVideoPackage, 'package.json'), 'utf8'),
    );
    assert.doesNotMatch(JSON.stringify(stagedVideoPackageJson), /"workspace:/u);
    await readFile(join(stagedVideoPackage, 'npm-shrinkwrap.json'), 'utf8');
    runNpm(
      [
        'ci',
        '--ignore-scripts',
        '--omit=dev',
        '--registry=https://registry.npmjs.org/',
        '--no-audit',
        '--no-fund',
      ],
      stagedVideoPackage,
    );
    await readFile(
      join(stagedVideoPackage, 'node_modules/@modelcontextprotocol/sdk/package.json'),
      'utf8',
    );
    await readFile(join(stagedVideoPackage, 'node_modules/zod/package.json'), 'utf8');
    run(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        "const video = await import('./dist/index.js'); if (typeof video.createVideoAnalysisMcpServer !== 'function') process.exit(1);",
      ],
      stagedVideoPackage,
    );

    runNpm(
      [
        'install',
        '--ignore-scripts',
        '--package-lock=false',
        '--registry=https://registry.npmjs.org/',
        ...tarballs,
      ],
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
    const companionPackage = JSON.parse(
      await readFile(
        join(consumer, 'node_modules/@clowder-ai/personal-chrome-companion/package.json'),
        'utf8',
      ),
    );
    const videoPackage = JSON.parse(
      await readFile(
        join(consumer, 'node_modules/@clowder-ai/video-analysis/package.json'),
        'utf8',
      ),
    );
    const genofficePackage = JSON.parse(
      await readFile(join(consumer, 'node_modules/@clowder-ai/genoffice-docx/package.json'), 'utf8'),
    );
    assert.equal(genofficePackage.version, '0.1.0-alpha.0');
    assert.equal(genofficePackage.dependencies['@clowder-ai/plugin-contract'], '0.1.0-beta.14');
    assert.doesNotMatch(JSON.stringify(genofficePackage), /"workspace:/u);
    run(process.execPath, ['--input-type=module', '--eval', `
      const { createRequire } = await import('node:module');
      const { readFile } = await import('node:fs/promises');
      const { dirname, join } = await import('node:path');
      const { pathToFileURL } = await import('node:url');
      const { createHash } = await import('node:crypto');
      const require = createRequire(import.meta.url);
      const { validateManifest } = await import('@clowder-ai/plugin-contract');
      await import('@clowder-ai/genoffice-docx');
      const { default: manifest } = await import('@clowder-ai/genoffice-docx/manifest', { with: { type: 'json' } });
      if (!validateManifest(manifest).valid || manifest.pluginId !== 'dev.clowder.genoffice-docx') process.exit(1);
      const root = dirname(require.resolve('@clowder-ai/genoffice-docx/manifest'));
      await import(pathToFileURL(join(root, 'renderer/host-bridge.js')).href);
      const bytes = await readFile(join(root, manifest.contributions[0].surface.entrypoint));
      const integrity = 'sha256-' + createHash('sha256').update(bytes).digest('base64');
      if (integrity !== manifest.contributions[0].surface.integrity) process.exit(1);
    `], consumer);
    const feishuManifest = JSON.parse(
      await readFile(
        join(consumer, 'node_modules/@clowder-ai/feishu-meeting-intake/manifest.json'),
        'utf8',
      ),
    );
    assert.equal(sdkPackage.version, '0.1.0-beta.10');
    assert.equal(sdkPackage.dependencies['@clowder-ai/plugin-contract'], '0.1.0-beta.14');
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
    assert.equal(companionPackage.version, '0.1.0-alpha.0');
    assert.equal(companionPackage.private, undefined);
    assert.deepEqual(companionPackage.dependencies, undefined);
    assert.deepEqual(companionPackage.bin, {
      'clowder-personal-chrome-host': 'native-host/native-host-cli.mjs',
    });
    assert.equal(videoPackage.version, '0.1.0-alpha.0');
    assert.deepEqual(videoPackage.bin, {
      'clowder-video-analysis-mcp': './dist/mcp-entrypoint.js',
    });
    const videoManifest = await readFile(
      join(consumer, 'node_modules/@clowder-ai/video-analysis/plugin.yaml'),
      'utf8',
    );
    assert.match(videoManifest, /src: assets\/icon\.svg/);
    const videoIcon = await readFile(
      join(consumer, 'node_modules/@clowder-ai/video-analysis/assets/icon.svg'),
      'utf8',
    );
    assert.match(videoIcon, /^<svg\b/);
    await readFile(
      join(consumer, 'node_modules/@clowder-ai/personal-chrome-companion/extension/manifest.json'),
      'utf8',
    );
    run(
      process.execPath,
      [
        'node_modules/@clowder-ai/personal-chrome-companion/native-host/native-host-cli.mjs',
        '--help',
      ],
      consumer,
    );

    run(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        "const { createRequire } = await import('node:module'); const require = createRequire(import.meta.url); const contract = await import('@clowder-ai/plugin-contract'); const conformance = await import('@clowder-ai/plugin-contract/conformance'); const metadata = require('@clowder-ai/plugin-contract/schemas/plugin-metadata'); const fixture = require('@clowder-ai/plugin-contract/fixtures/behavior/messaging/adversarial-invariants'); const sdk = await import('@clowder-ai/plugin-sdk'); const plugin = await import('@clowder-ai/feishu-meeting-intake'); const companion = await import('@clowder-ai/personal-chrome-companion'); const video = await import('@clowder-ai/video-analysis'); const request = companion.parsePersonalChromeAppendRequest({ v: 1, kind: 'append_message', requestId: 'fresh-1', conversationId: 'conversation-1', text: 'fresh consumer', idempotencyKey: 'delivery-1' }); if (typeof contract.validateManifest !== 'function' || typeof contract.validatePluginCatalog !== 'function' || metadata.title !== 'Clowder AI Plugin Product Metadata (v1)' || conformance.M0C_BEHAVIOR_CASE_IDS.length !== 18 || fixture.cases.length !== 18 || typeof sdk.definePlugin !== 'function' || typeof plugin.createFeishuMeetingIntakeRuntime !== 'function' || typeof video.createVideoAnalysisMcpServer !== 'function' || request.conversationId !== 'conversation-1') process.exit(1);",
      ],
      consumer,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
