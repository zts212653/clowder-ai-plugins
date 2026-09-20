import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parse as parseYaml } from 'yaml';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));

const connectorPackages = [
  { name: '@clowder-ai/connector-telegram', directory: 'packages/connector-telegram' },
  { name: '@clowder-ai/connector-dingtalk', directory: 'packages/connector-dingtalk' },
  { name: '@clowder-ai/connector-feishu', directory: 'packages/connector-feishu' },
  { name: '@clowder-ai/connector-wecom-agent', directory: 'packages/connector-wecom-agent' },
  { name: '@clowder-ai/connector-wecom-bot', directory: 'packages/connector-wecom-bot' },
  { name: '@clowder-ai/connector-weixin', directory: 'packages/connector-weixin' },
  { name: '@clowder-ai/connector-xiaoyi', directory: 'packages/connector-xiaoyi' },
];

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
      '@clowder-ai/video-generation',
      '@clowder-ai/weixin-mp',
      '@clowder-ai/wechat-visible-reader',
      '@clowder-ai/genoffice-docx',
      ...connectorPackages.map(({ name }) => name),
    ]) {
      const build = packageName === '@clowder-ai/genoffice-docx' ? 'build:renderer' : 'build';
      run('pnpm', ['--filter', packageName, build], repoRoot);
    }
    run(process.execPath, ['packages/genoffice-docx/scripts/assert-pack-ready.mjs'], repoRoot);

    const tarballs = [
      pack('packages/plugin-contract', packs),
      pack('packages/plugin-sdk', packs),
      pack('packages/feishu-meeting-intake', packs),
      pack('packages/personal-chrome-companion', packs),
      pack('packages/video-analysis', packs),
      pack('packages/video-generation', packs),
      pack('packages/weixin-mp', packs),
      pack('packages/wechat-visible-reader', packs),
      pack('packages/genoffice-docx', packs),
      ...connectorPackages.map(({ directory }) => pack(directory, packs)),
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

    const stagedVideoGeneration = join(root, 'staged-video-generation');
    await mkdir(stagedVideoGeneration);
    run('tar', ['-xzf', tarballs[5], '-C', stagedVideoGeneration], root);
    const stagedVideoGenerationPackage = join(stagedVideoGeneration, 'package');
    const stagedVideoGenerationPackageJson = JSON.parse(
      await readFile(join(stagedVideoGenerationPackage, 'package.json'), 'utf8'),
    );
    assert.doesNotMatch(JSON.stringify(stagedVideoGenerationPackageJson), /"workspace:/u);
    await readFile(join(stagedVideoGenerationPackage, 'npm-shrinkwrap.json'), 'utf8');
    for (const member of ['README.md', 'protocols/jimeng.yaml', 'protocols/kling.yaml', 'protocols/zhipu.yaml']) {
      await readFile(join(stagedVideoGenerationPackage, member), 'utf8');
    }
    runNpm(
      [
        'ci',
        '--ignore-scripts',
        '--omit=dev',
        '--registry=https://registry.npmjs.org/',
        '--no-audit',
        '--no-fund',
      ],
      stagedVideoGenerationPackage,
    );

    const stagedWeixinMp = join(root, 'staged-weixin-mp');
    await mkdir(stagedWeixinMp);
    run('tar', ['-xzf', tarballs[6], '-C', stagedWeixinMp], root);
    const stagedWeixinMpPackage = join(stagedWeixinMp, 'package');
    for (const member of [
      'README.md',
      'limbs/weixin-mp.yml',
      'skills/weixin-mp/SKILL.md',
      'dist/index.js',
    ]) {
      await readFile(join(stagedWeixinMpPackage, member), 'utf8');
    }

    const stagedWechatReader = join(root, 'staged-wechat-visible-reader');
    await mkdir(stagedWechatReader);
    run('tar', ['-xzf', tarballs[7], '-C', stagedWechatReader], root);
    const stagedWechatReaderPackage = join(stagedWechatReader, 'package');
    for (const member of [
      'README.md',
      'limbs/wechat-visible-reader.yml',
      'native/WeChatReaderModels.swift',
      'native/WeChatReaderCore.swift',
      'native/WeChatVisibleReader.swift',
      'dist/index.js',
      'npm-shrinkwrap.json',
    ]) {
      await readFile(join(stagedWechatReaderPackage, member), 'utf8');
    }
    runNpm(
      [
        'ci',
        '--ignore-scripts',
        '--omit=dev',
        '--registry=https://registry.npmjs.org/',
        '--no-audit',
        '--no-fund',
        ...(process.platform === 'darwin' ? [] : ['--force']),
      ],
      stagedWechatReaderPackage,
    );
    run(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        "const generation = await import('./dist/index.js'); if (typeof generation.startVideoGenerationServer !== 'function') process.exit(1);",
      ],
      stagedVideoGenerationPackage,
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
        ...(process.platform === 'darwin' ? [] : ['--force']),
        ...tarballs,
      ],
      consumer,
    );

    const contractPackage = JSON.parse(
      await readFile(join(consumer, 'node_modules/@clowder-ai/plugin-contract/package.json'), 'utf8'),
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
    const videoGenerationPackage = JSON.parse(
      await readFile(
        join(consumer, 'node_modules/@clowder-ai/video-generation/package.json'),
        'utf8',
      ),
    );
    const weixinMpPackage = JSON.parse(
      await readFile(join(consumer, 'node_modules/@clowder-ai/weixin-mp/package.json'), 'utf8'),
    );
    const wechatReaderPackage = JSON.parse(
      await readFile(
        join(consumer, 'node_modules/@clowder-ai/wechat-visible-reader/package.json'),
        'utf8',
      ),
    );
    const genofficePackage = JSON.parse(
      await readFile(join(consumer, 'node_modules/@clowder-ai/genoffice-docx/package.json'), 'utf8'),
    );
    assert.equal(genofficePackage.version, '0.1.0-alpha.1');
    assert.equal(genofficePackage.dependencies['@clowder-ai/plugin-contract'], '0.1.0-beta.15');
    assert.doesNotMatch(JSON.stringify(genofficePackage), /"workspace:/u);
    const sourceLock = JSON.parse(await readFile(join(repoRoot, 'packages/genoffice-docx/source-lock.json'), 'utf8'));
    const docxFixture = join(repoRoot, 'packages/genoffice-docx/.tmp/source', sourceLock.rootDirectory, 'fixtures/generated/simple.docx');
    run(process.execPath, ['--input-type=module', '--eval', `
      const { createRequire } = await import('node:module');
      const { readFile } = await import('node:fs/promises');
      const { dirname, join } = await import('node:path');
      const { pathToFileURL } = await import('node:url');
      const { createHash } = await import('node:crypto');
      const require = createRequire(import.meta.url);
      const { validateManifest, validateDocxMaterializationResponse } = await import('@clowder-ai/plugin-contract');
      await import('@clowder-ai/genoffice-docx');
      const { default: manifest } = await import('@clowder-ai/genoffice-docx/manifest', { with: { type: 'json' } });
      if (!validateManifest(manifest).valid || manifest.pluginId !== 'dev.clowder.genoffice-docx') process.exit(1);
      const root = dirname(require.resolve('@clowder-ai/genoffice-docx/manifest'));
      await import(pathToFileURL(join(root, 'renderer/host-bridge.js')).href);
      const bytes = await readFile(join(root, manifest.contributions[0].surface.entrypoint));
      const integrity = 'sha256-' + createHash('sha256').update(bytes).digest('base64');
      if (integrity !== manifest.contributions[0].surface.integrity) process.exit(1);
      const semantic = manifest.contributions[0].semanticMaterializer;
      if (semantic?.executionClass !== 'dedicated-browser-worker') process.exit(1);
      const workerPath = join(root, semantic.entrypoint);
      if ('sha256-' + createHash('sha256').update(await readFile(workerPath)).digest('base64') !== semantic.integrity) process.exit(1);
      const { materializeDocx } = await import(pathToFileURL(workerPath).href);
      const rejected = await materializeDocx({protocolVersion: '1.0.0', requestId: 'fresh', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytesBase64: 'bm90IGEgemlw', operation: {kind: 'inspect', cursor: 0, limit: 1}});
      if (!validateDocxMaterializationResponse(rejected) || rejected.result.code !== 'INVALID_DOCX') process.exit(1);
      const inspected = await materializeDocx({protocolVersion: '1.0.0', requestId: 'fresh-real', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytesBase64: (await readFile(process.argv[1])).toString('base64'), operation: {kind: 'inspect', cursor: 0, limit: 32}});
      if (!validateDocxMaterializationResponse(inspected) || inspected.result.kind !== 'inspection' || !inspected.result.paragraphs.length) process.exit(1);
    `, docxFixture], consumer);
    const feishuManifest = JSON.parse(
      await readFile(
        join(consumer, 'node_modules/@clowder-ai/feishu-meeting-intake/manifest.json'),
        'utf8',
      ),
    );
    assert.equal(contractPackage.version, '0.1.0-beta.16');
    assert.equal(sdkPackage.version, '0.1.0-beta.12');
    assert.equal(sdkPackage.dependencies['@clowder-ai/plugin-contract'], '0.1.0-beta.16');
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
    assert.equal(videoPackage.version, '0.1.0-alpha.1');
    assert.deepEqual(videoPackage.bin, {
      'clowder-video-analysis-mcp': './dist/mcp-entrypoint.js',
    });
    assert.equal(videoGenerationPackage.version, '0.1.0-alpha.0');
    assert.deepEqual(videoGenerationPackage.bin, {
      'clowder-video-generation-mcp': './dist/mcp-entrypoint.js',
    });
    assert.equal(weixinMpPackage.version, '0.1.0-alpha.0');
    assert.equal(wechatReaderPackage.version, '0.1.0-alpha.0');
    assert.deepEqual(wechatReaderPackage.os, ['darwin']);
    const installedContract = await import(
      pathToFileURL(
        join(consumer, 'node_modules/@clowder-ai/plugin-contract/dist/index.js'),
      ).href
    );
    const installedSdk = await import(
      pathToFileURL(
        join(consumer, 'node_modules/@clowder-ai/plugin-sdk/dist/index.js'),
      ).href
    );
    for (const { name } of connectorPackages) {
      const installedRoot = join(consumer, 'node_modules', name);
      const packageJson = JSON.parse(await readFile(join(installedRoot, 'package.json'), 'utf8'));
      const manifestText = await readFile(join(installedRoot, 'plugin.yaml'), 'utf8');
      const manifest = parseYaml(manifestText);
      const manifestValidation = installedContract.validateManifest(manifest);
      assert.equal(
        manifestValidation.valid,
        true,
        manifestValidation.valid ? undefined : JSON.stringify(manifestValidation.errors),
      );
      assert.equal(manifest.version, packageJson.version);
      assert.equal(manifest.contractVersion, installedContract.CONTRACT_VERSION);
      assert.equal(manifest.runtime.transport, 'builtin');
      assert.equal(typeof manifest.runtime.entrypoint, 'string');
      const namespace = await import(
        pathToFileURL(join(installedRoot, manifest.runtime.entrypoint)).href
      );
      const entrypoint = installedSdk.requirePluginModuleEntrypoint(namespace.default);
      const definition = entrypoint.create(manifest);
      assert.equal(definition.manifest.pluginId, manifest.pluginId);
      assert.deepEqual(
        Object.keys(definition.activate).sort(),
        manifest.features.map((feature) => feature.id).sort(),
      );
    }
    const videoManifestText = await readFile(
      join(consumer, 'node_modules/@clowder-ai/video-analysis/plugin.yaml'),
      'utf8',
    );
    const videoManifest = parseYaml(videoManifestText);
    const videoManifestValidation = installedContract.validateManifest(videoManifest);
    assert.equal(
      videoManifestValidation.valid,
      true,
      videoManifestValidation.valid ? undefined : JSON.stringify(videoManifestValidation.errors),
    );
    assert.equal(
      videoManifest.contractVersion,
      installedContract.CONTRACT_VERSION,
      'packed manifest declares the Host compatibility line, not the contract npm version',
    );
    assert.match(videoManifestText, /src: assets\/icon\.svg/);
    const videoIcon = await readFile(
      join(consumer, 'node_modules/@clowder-ai/video-analysis/assets/icon.svg'),
      'utf8',
    );
    assert.match(videoIcon, /^<svg\b/);
    const videoReadme = await readFile(
      join(consumer, 'node_modules/@clowder-ai/video-analysis/README.md'),
      'utf8',
    );
    assert.match(videoReadme, /^# Video Analysis\n/m);
    const videoGenerationManifestText = await readFile(
      join(consumer, 'node_modules/@clowder-ai/video-generation/plugin.yaml'),
      'utf8',
    );
    const videoGenerationManifest = parseYaml(videoGenerationManifestText);
    const videoGenerationManifestValidation = installedContract.validateManifest(
      videoGenerationManifest,
    );
    assert.equal(
      videoGenerationManifestValidation.valid,
      true,
      videoGenerationManifestValidation.valid
        ? undefined
        : JSON.stringify(videoGenerationManifestValidation.errors),
    );
    assert.equal(videoGenerationManifest.contractVersion, installedContract.CONTRACT_VERSION);
    assert.match(videoGenerationManifestText, /src: assets\/icon\.svg/);
    assert.match(
      await readFile(
        join(consumer, 'node_modules/@clowder-ai/video-generation/README.md'),
        'utf8',
      ),
      /^# Video Generation\n/m,
    );
    const weixinMpManifestText = await readFile(
      join(consumer, 'node_modules/@clowder-ai/weixin-mp/plugin.yaml'),
      'utf8',
    );
    const weixinMpManifest = parseYaml(weixinMpManifestText);
    const weixinMpManifestValidation = installedContract.validateManifest(weixinMpManifest);
    assert.equal(
      weixinMpManifestValidation.valid,
      true,
      weixinMpManifestValidation.valid
        ? undefined
        : JSON.stringify(weixinMpManifestValidation.errors),
    );
    assert.equal(weixinMpManifest.contractVersion, installedContract.CONTRACT_VERSION);
    assert.match(
      await readFile(join(consumer, 'node_modules/@clowder-ai/weixin-mp/README.md'), 'utf8'),
      /^# WeChat Official Account\n/m,
    );
    const wechatReaderManifestText = await readFile(
      join(consumer, 'node_modules/@clowder-ai/wechat-visible-reader/plugin.yaml'),
      'utf8',
    );
    const wechatReaderManifest = parseYaml(wechatReaderManifestText);
    const wechatReaderManifestValidation = installedContract.validateManifest(wechatReaderManifest);
    assert.equal(
      wechatReaderManifestValidation.valid,
      true,
      wechatReaderManifestValidation.valid
        ? undefined
        : JSON.stringify(wechatReaderManifestValidation.errors),
    );
    assert.equal(wechatReaderManifest.contractVersion, installedContract.CONTRACT_VERSION);
    assert.match(
      await readFile(
        join(consumer, 'node_modules/@clowder-ai/wechat-visible-reader/README.md'),
        'utf8',
      ),
      /^# WeChat Visible Reader\n/m,
    );
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
        "const { createRequire } = await import('node:module'); const require = createRequire(import.meta.url); const contract = await import('@clowder-ai/plugin-contract'); const conformance = await import('@clowder-ai/plugin-contract/conformance'); const metadata = require('@clowder-ai/plugin-contract/schemas/plugin-metadata'); const fixture = require('@clowder-ai/plugin-contract/fixtures/behavior/messaging/adversarial-invariants'); const sdk = await import('@clowder-ai/plugin-sdk'); const plugin = await import('@clowder-ai/feishu-meeting-intake'); const companion = await import('@clowder-ai/personal-chrome-companion'); const video = await import('@clowder-ai/video-analysis'); const generation = await import('@clowder-ai/video-generation'); const weixinMp = await import('@clowder-ai/weixin-mp'); const wechatReader = await import('@clowder-ai/wechat-visible-reader'); const request = companion.parsePersonalChromeAppendRequest({ v: 1, kind: 'append_message', requestId: 'fresh-1', conversationId: 'conversation-1', text: 'fresh consumer', idempotencyKey: 'delivery-1' }); if (typeof contract.validateManifest !== 'function' || typeof contract.validatePluginCatalog !== 'function' || metadata.title !== 'Clowder AI Plugin Product Metadata (v1)' || conformance.M0C_BEHAVIOR_CASE_IDS.length !== 18 || fixture.cases.length !== 18 || typeof sdk.definePlugin !== 'function' || typeof plugin.createFeishuMeetingIntakeRuntime !== 'function' || typeof video.createVideoAnalysisMcpServer !== 'function' || typeof generation.startVideoGenerationServer !== 'function' || typeof weixinMp.createWeixinMpHandlers !== 'function' || typeof wechatReader.createWeChatVisibleReaderHandlers !== 'function' || request.conversationId !== 'conversation-1') process.exit(1);",
      ],
      consumer,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
