import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parse as parseYaml } from 'yaml';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const workspaceSdk = JSON.parse(await readFile(join(repoRoot, 'packages/plugin-sdk/package.json'), 'utf8'));
const workspaceContract = JSON.parse(await readFile(join(repoRoot, 'packages/plugin-contract/package.json'), 'utf8'));


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

function currentPairOverrides(sdk, contract) {
  return Object.fromEntries([
    ...['personal-chrome-companion','weixin-mp','wechat-visible-reader','enterprise-workflow','github-operations','feishu-meeting-intake',...connectorPackages.map(({name})=>name.slice('@clowder-ai/'.length))].map(name => [
      `@clowder-ai/${name}`, {
        [`@clowder-ai/plugin-contract@${workspaceContract.version}`]: contract,
        [`@clowder-ai/plugin-sdk@${workspaceSdk.version}`]: { '.': sdk,
          [`@clowder-ai/plugin-contract@${workspaceContract.version}`]: contract },
      },
    ]),
    ['@clowder-ai/genoffice-docx', { [`@clowder-ai/plugin-contract@${workspaceContract.version}`]: contract }],
  ]);
}

test('Chrome and the workspace SDK each resolve their declared contract in a fresh consumer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clowder-chrome-direct-consumer-'));
  const packs = join(root, 'packs');
  const consumer = join(root, 'consumer');
  await mkdir(packs);
  await mkdir(consumer);
  try {
    // Contract CI reaches this test before Chrome is built; pack deliberately skips scripts.
    for (const name of ['plugin-contract', 'plugin-sdk', 'personal-chrome-companion'])
      run('pnpm', ['--filter', `@clowder-ai/${name}`, 'build'], repoRoot);
    const tarballs = ['plugin-contract', 'plugin-sdk', 'personal-chrome-companion']
      .map(name => pack(`packages/${name}`, packs));
    await writeFile(join(consumer, 'package.json'), JSON.stringify({
      private: true, type: 'module',
      overrides: currentPairOverrides(pathToFileURL(tarballs[1]).href, pathToFileURL(tarballs[0]).href),
    }));
    runNpm(['install', '--ignore-scripts', '--package-lock=false', '--no-audit', '--no-fund',
      '--registry=https://registry.npmjs.org/', ...tarballs], consumer);
    run(process.execPath, ['--input-type=module', '--eval', `
      import assert from 'node:assert/strict';
      import { execFileSync } from 'node:child_process';
      import { readFileSync } from 'node:fs';
      import { dirname, join } from 'node:path';
      import { fileURLToPath, pathToFileURL } from 'node:url';
      const resolveFrom = (directory, name) => fileURLToPath(execFileSync(process.execPath,
        ['--input-type=module', '--eval', 'process.stdout.write(import.meta.resolve(process.argv[1]))', name],
        { cwd: directory, encoding: 'utf8' }));
      const chromeEntry = fileURLToPath(import.meta.resolve('@clowder-ai/personal-chrome-companion'));
      const pkg = entry => JSON.parse(readFileSync(join(dirname(entry), '../package.json'), 'utf8'));
      const version = entry => pkg(entry).version;
      assert.equal(version(resolveFrom(dirname(chromeEntry), '@clowder-ai/plugin-contract')), pkg(chromeEntry).dependencies['@clowder-ai/plugin-contract']);
      const resolvedSdkEntry = resolveFrom(dirname(chromeEntry), '@clowder-ai/plugin-sdk');
      assert.equal(version(resolvedSdkEntry), pkg(chromeEntry).dependencies['@clowder-ai/plugin-sdk']);
      assert.equal(version(resolveFrom(dirname(resolvedSdkEntry), '@clowder-ai/plugin-contract')), pkg(resolvedSdkEntry).dependencies['@clowder-ai/plugin-contract']);
      const currentSdkEntry = fileURLToPath(import.meta.resolve('@clowder-ai/plugin-sdk'));
      assert.equal(version(currentSdkEntry), ${JSON.stringify(workspaceSdk.version)});
      assert.equal(version(resolveFrom(dirname(currentSdkEntry), '@clowder-ai/plugin-contract')), pkg(currentSdkEntry).dependencies['@clowder-ai/plugin-contract']);
      assert.equal(typeof (await import(pathToFileURL(chromeEntry).href)).default.create, 'function');
    `], consumer);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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
      '@clowder-ai/enterprise-workflow',
      '@clowder-ai/github-operations',
      ...connectorPackages.map(({ name }) => name),
      '@clowder-ai/xiangqi',
    ]) {
      const build = packageName === '@clowder-ai/genoffice-docx' ? 'build:renderer' : 'build';
      run('pnpm', ['--filter', packageName, build], repoRoot);
    }
    run(process.execPath, ['packages/genoffice-docx/scripts/assert-pack-ready.mjs'], repoRoot);

    const enterpriseTarball = pack('packages/enterprise-workflow', packs);
    const xiangqiTarball = pack('packages/xiangqi', packs);
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
      enterpriseTarball,
      pack('packages/github-operations', packs),
    ];

    const staged = join(root, 'staged');
    await mkdir(staged);
    run('tar', ['-xzf', tarballs[2], '-C', staged], root);
    const stagedPackage = join(staged, 'package');
    const stagedRunnerUrl = pathToFileURL(join(stagedPackage, 'dist/lark-cli-runner.js')).href;
    const stagedEntrypointUrl = pathToFileURL(join(stagedPackage, 'dist/plugin-entrypoint.js')).href;
    run(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `const module=await import(${JSON.stringify(stagedEntrypointUrl)}); if(typeof module.default?.create!=='function') process.exit(1); const { resolveBundledLarkCliEntrypoint } = await import(${JSON.stringify(stagedRunnerUrl)}); const runner = resolveBundledLarkCliEntrypoint(); if (!runner.endsWith('/@larksuite/cli/scripts/run.js')) process.exit(1);`,
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
    // The Host ChatGPT Pro extension pins its `key` so the extension ID is
    // deterministic across machines; the install CLI writes allowed_origins
    // for that pinned ID. The pre-migration candidate derived the ID from the
    // load path and asserted `key === undefined`; that contract moved with p1.
    assert.equal(
      stagedCompanionManifest.key,
      'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAlgM1q4v6VL4SktWwZeydrLSVL0WW9cxZaCTbFi95GdNloO2oF3awS2yW4kYRh1cuqe9YpkGupr9/e2jmjU8wnvnxRtZRVUmsW1Fxx9KMYpGpXdWuQrc6d6wCWZ0Fa+YU3gORUBEASx47lEMYnF30sCGOHPw5brna2Vz/kfKzLTt5JX7kpshUCpYXZrrisLOJyMxBCSblXO+TP039UMHnvRifiiM5bFZPgfZFeDhiqt9Ye7omm16i8MxLhRqyirfVYtD1Cq5CYuRMqL3aFziwR4WkSN3cyI8AdTk9TYiYa3QzCSwGtENR5PZGo/cLubjOfOBRJVGo7A/75Bj0izrnGwIDAQAB',
    );
    assert.deepEqual(stagedCompanionManifest.permissions, ['nativeMessaging', 'tabs', 'scripting', 'alarms']);
    assert.deepEqual(stagedCompanionManifest.host_permissions, ['https://chatgpt.com/c/*']);
    await readFile(join(stagedCompanionPackage, 'native-host/native-host-cli.mjs'), 'utf8');
    const companionCli = spawnSync(
      process.execPath,
      ['native-host/native-host-cli.mjs', '--help'],
      { cwd: stagedCompanionPackage, encoding: 'utf8' },
    );
    assert.notEqual(companionCli.status, 0);
    assert.match(companionCli.stderr, /required personal Chrome host configuration is missing/);

    const stagedVideo = join(root, 'staged-video-analysis');
    await mkdir(stagedVideo);
    run('tar', ['-xzf', tarballs[4], '-C', stagedVideo], root);
    const stagedVideoPackage = join(stagedVideo, 'package');
    const stagedVideoPackageJson = JSON.parse(
      await readFile(join(stagedVideoPackage, 'package.json'), 'utf8'),
    );
    assert.doesNotMatch(JSON.stringify(stagedVideoPackageJson), /"workspace:/u);
    await readFile(join(stagedVideoPackage, 'npm-shrinkwrap.json'), 'utf8');
    for (const member of ['protocols/gemini.yaml', 'protocols/zhipu.yaml']) {
      await readFile(join(stagedVideoPackage, member), 'utf8');
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
      'dist/plugin-entrypoint.js',
      'npm-shrinkwrap.json',
    ]) {
      await readFile(join(stagedWechatReaderPackage, member), 'utf8');
    }
    run(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        "const generation = await import('./dist/index.js'); if (typeof generation.startVideoGenerationServer !== 'function') process.exit(1);",
      ],
      stagedVideoGenerationPackage,
    );
    const stagedXiangqi = join(root, 'staged-xiangqi');
    await mkdir(stagedXiangqi);
    run('tar', ['-xzf', xiangqiTarball, '-C', stagedXiangqi], root);
    const stagedXiangqiPackage = join(stagedXiangqi, 'package');
    const xiangqiPackageJson = JSON.parse(await readFile(join(stagedXiangqiPackage, 'package.json'), 'utf8'));
    assert.doesNotMatch(JSON.stringify(xiangqiPackageJson), /"workspace:/u);
    await readFile(join(stagedXiangqiPackage, 'npm-shrinkwrap.json'), 'utf8');
    await readFile(join(stagedXiangqiPackage, 'dist/web/index.html'), 'utf8');
    runNpm(
      ['ci', '--ignore-scripts', '--omit=dev', '--registry=https://registry.npmjs.org/', '--no-audit', '--no-fund'],
      stagedXiangqiPackage,
    );
    run(process.execPath, ['--input-type=module', '--eval',
      "const mod = await import('./dist/index.mjs'); if (typeof mod.createHostedBoard !== 'function' || typeof mod.createHostedGame !== 'function' || typeof mod.analyze !== 'function') process.exit(1);",
    ], stagedXiangqiPackage);
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

    // A current identity must match the exact local pack; historical identities
    // retain their registry resolution and are exercised by the installation.
    const sdkBytes = await readFile(tarballs[1]);
    const contractBytes = await readFile(tarballs[0]);
    for (const directory of ['personal-chrome-companion','weixin-mp','wechat-visible-reader','enterprise-workflow','github-operations',...connectorPackages.map(({directory})=>directory.slice('packages/'.length))]) {
      const lock = JSON.parse(await readFile(join(repoRoot,'packages',directory,'npm-shrinkwrap.json'),'utf8'));
      for (const [name, version, bytes] of [['plugin-sdk',workspaceSdk.version,sdkBytes],['plugin-contract',workspaceContract.version,contractBytes]]) {
        const entry=lock.packages[`node_modules/@clowder-ai/${name}`];
        assert.match(entry.resolved, /^https:\/\/registry\.npmjs\.org\//u);
        if (entry.version !== version) continue;
        assert.equal(entry.integrity,`sha512-${createHash('sha512').update(bytes).digest('base64')}`);
      }
    }
    await writeFile(join(consumer,'package.json'), JSON.stringify({private:true,
      overrides:currentPairOverrides(pathToFileURL(tarballs[1]).href,pathToFileURL(tarballs[0]).href)}));
    runNpm(
      [
        'install',
        '--ignore-scripts',
        '--package-lock=false',
        '--registry=https://registry.npmjs.org/',
        ...(process.platform === 'darwin' ? [] : ['--force']),
        ...tarballs,
        xiangqiTarball,
      ],
      consumer,
    );

    const guidePackages = [
      'feishu-meeting-intake', 'personal-chrome-companion', 'video-analysis',
      'video-generation', 'weixin-mp', 'wechat-visible-reader', 'genoffice-docx',
      'enterprise-workflow', 'github-operations', 'xiangqi',
      ...connectorPackages.map(({ name }) => name.slice('@clowder-ai/'.length)),
    ];
    for (const name of guidePackages) {
      const installedRoot = join(consumer, 'node_modules/@clowder-ai', name);
      for (const filename of ['README.md', 'README.en.md']) {
        assert.equal(
          await readFile(join(installedRoot, filename), 'utf8'),
          await readFile(join(repoRoot, 'packages', name, filename), 'utf8'),
          `${name}/${filename} must survive packing and installation unchanged`,
        );
      }
      const chinese = await readFile(join(installedRoot, 'README.md'), 'utf8');
      const english = await readFile(join(installedRoot, 'README.en.md'), 'utf8');
      assert.match(chinese, /^# [^\n]*\p{Script=Han}/mu, `${name}: Chinese default guide`);
      assert.doesNotMatch(english, /\p{Script=Han}/u, `${name}: independent English guide`);
      assert.match(chinese, /\]\(README\.en\.md\)/);
      assert.match(english, /\]\(README\.md\)/);
    }

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
    const xiangqiPackage = JSON.parse(
      await readFile(join(consumer, 'node_modules/@clowder-ai/xiangqi/package.json'), 'utf8'),
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
    const enterprisePackage = JSON.parse(
      await readFile(join(consumer, 'node_modules/@clowder-ai/enterprise-workflow/package.json'), 'utf8'),
    );
    assert.equal(genofficePackage.version, '0.1.0-alpha.3');
    assert.equal(genofficePackage.dependencies['@clowder-ai/plugin-contract'],
      JSON.parse(await readFile(join(repoRoot, 'packages/genoffice-docx/package.json'), 'utf8')).dependencies['@clowder-ai/plugin-contract']);
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
    const sourceContract = JSON.parse(await readFile(join(repoRoot, 'packages/plugin-contract/package.json'), 'utf8'));
    const sourceSdk = JSON.parse(await readFile(join(repoRoot, 'packages/plugin-sdk/package.json'), 'utf8'));
    assert.equal(sourceSdk.dependencies['@clowder-ai/plugin-contract'], sourceContract.version);
    assert.equal(contractPackage.version, sourceContract.version);
    assert.equal(sdkPackage.version, sourceSdk.version);
    assert.equal(sdkPackage.dependencies['@clowder-ai/plugin-contract'], sourceContract.version);
    const sourceIntake = JSON.parse(await readFile(join(repoRoot, 'packages/feishu-meeting-intake/package.json'), 'utf8'));
    assert.deepEqual(feishuPackage.dependencies, sourceIntake.dependencies);
    assert.equal(feishuPackage.dependencies['@larksuite/cli'], '1.0.85');
    assert.deepEqual(
      [...feishuPackage.bundledDependencies].sort(),
      Object.keys(feishuPackage.dependencies).sort(),
    );
    assert.equal(feishuManifest.version, feishuPackage.version);
    assert.deepEqual(feishuManifest.runtime, {
      transport: 'builtin',
      entrypoint: 'dist/index.js',
      dataDirectory: 'feishu-meeting-intake',
    });
    assert.equal(feishuManifest.signals, undefined);
    await readFile(
      join(consumer, 'node_modules/@clowder-ai/feishu-meeting-intake', feishuManifest.runtime.entrypoint),
      'utf8',
    );
    const declaredCompanionPackage = JSON.parse(
      await readFile(join(repoRoot, 'packages/personal-chrome-companion/package.json'), 'utf8'),
    );
    assert.equal(companionPackage.version, declaredCompanionPackage.version);
    assert.equal(companionPackage.private, undefined);
    assert.equal(companionPackage.dependencies['@clowder-ai/plugin-sdk'],
      declaredCompanionPackage.dependencies['@clowder-ai/plugin-sdk']);
    assert.doesNotMatch(JSON.stringify(companionPackage), /"workspace:/u);
    assert.deepEqual(companionPackage.bin, {
      'clowder-personal-chrome-host': 'native-host/native-host-cli.mjs',
    });
    assert.equal(videoPackage.version, '0.1.0-alpha.4');
    assert.equal(xiangqiPackage.version, '0.1.0-alpha.3');
    assert.deepEqual(videoPackage.bin, {
      'clowder-video-analysis-mcp': './dist/mcp-entrypoint.js',
    });
    assert.equal(videoGenerationPackage.version, '0.1.0-alpha.3');
    assert.deepEqual(videoGenerationPackage.bin, {
      'clowder-video-generation-mcp': './dist/mcp-entrypoint.js',
    });
    assert.equal(weixinMpPackage.version, '0.1.0-alpha.6');
    assert.equal(weixinMpPackage.dependencies['@clowder-ai/plugin-sdk'],
      JSON.parse(await readFile(join(repoRoot, 'packages/weixin-mp/package.json'), 'utf8')).dependencies['@clowder-ai/plugin-sdk']);
    assert.doesNotMatch(JSON.stringify(weixinMpPackage), /"workspace:/u);
    assert.equal(wechatReaderPackage.version, '0.1.0-alpha.7');
    assert.equal(wechatReaderPackage.dependencies['@clowder-ai/plugin-sdk'],
      JSON.parse(await readFile(join(repoRoot, 'packages/wechat-visible-reader/package.json'), 'utf8')).dependencies['@clowder-ai/plugin-sdk']);
    assert.doesNotMatch(JSON.stringify(wechatReaderPackage), /"workspace:/u);
    assert.deepEqual(wechatReaderPackage.os, ['darwin']);
    assert.equal(enterprisePackage.version, '0.1.0-alpha.5');
    assert.equal(enterprisePackage.dependencies['@clowder-ai/plugin-sdk'],
      JSON.parse(await readFile(join(repoRoot, 'packages/enterprise-workflow/package.json'), 'utf8')).dependencies['@clowder-ai/plugin-sdk']);
    assert.doesNotMatch(JSON.stringify(enterprisePackage), /"workspace:/u);
    // Resolve from each consumer rather than assuming all chose the workspace SDK.
    for (const directory of [
      'personal-chrome-companion', 'weixin-mp', 'wechat-visible-reader', 'enterprise-workflow',
      ...connectorPackages.map(({ name }) => name.slice('@clowder-ai/'.length)),
      'github-operations',
    ]) {
      const source = JSON.parse(await readFile(join(repoRoot, 'packages', directory, 'package.json'), 'utf8'));
      const expected = source.dependencies['@clowder-ai/plugin-sdk'];
      const installedRoot = join(consumer, 'node_modules/@clowder-ai', directory);
      const resolvedUrl = run(process.execPath, ['--input-type=module', '--eval',
        "console.log(import.meta.resolve('@clowder-ai/plugin-sdk'));"], installedRoot).trim();
      const resolvedSdkRoot = dirname(dirname(fileURLToPath(resolvedUrl)));
      const resolvedSdk = JSON.parse(await readFile(join(resolvedSdkRoot, 'package.json'), 'utf8'));
      assert.equal(resolvedSdk.version, expected, `${directory} must load its declared SDK identity`);
      const resolvedContractUrl = run(process.execPath, ['--input-type=module', '--eval',
        "console.log(import.meta.resolve('@clowder-ai/plugin-contract'));"], resolvedSdkRoot).trim();
      const resolvedContract = JSON.parse(await readFile(join(dirname(dirname(fileURLToPath(resolvedContractUrl))), 'package.json'), 'utf8'));
      const expectedContract = resolvedSdk.dependencies['@clowder-ai/plugin-contract'];
      assert.equal(resolvedContract.version, expectedContract,
        `${directory} SDK must load its declared contract identity`);
    }
    await import(pathToFileURL(join(consumer, 'node_modules/@clowder-ai/github-operations/dist/plugin-entrypoint.js')).href);
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
    const personalChromeManifest = installedContract.validateManifest(parseYaml(
      await readFile(join(consumer, 'node_modules/@clowder-ai/personal-chrome-companion/plugin.yaml'), 'utf8'),
    ));
    assert.equal(personalChromeManifest.valid, true);
    const authorizations = personalChromeManifest.manifest.configuration.find(
      (field) => field.key === 'personalChromeAuthorizations',
    );
    assert.equal(
      authorizations.actions.find((action) => action.resultRender === 'rows')?.id,
      'list',
      'the installed artifact must select the generic Host Settings rows renderer',
    );
    for (const { name, directory } of connectorPackages) {
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
      const sourceManifest = parseYaml(await readFile(join(repoRoot, directory, 'plugin.yaml'), 'utf8'));
      assert.equal(manifest.contractVersion, sourceManifest.contractVersion);
      assert.equal(manifest.runtime.transport, 'builtin');
      assert.equal(typeof manifest.runtime.entrypoint, 'string');
      const namespace = await import(
        pathToFileURL(join(installedRoot, manifest.runtime.entrypoint)).href
      );
      const entrypoint = installedSdk.requirePluginModuleEntrypoint(namespace.default);
      const definition = entrypoint.create(manifest);
      assert.equal(typeof definition.start, 'function');
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
      parseYaml(await readFile(join(repoRoot, 'packages/video-analysis/plugin.yaml'), 'utf8')).contractVersion,
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
    assert.match(videoReadme, /^# 视频分析\n/m);
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
    assert.equal(videoGenerationManifest.contractVersion, parseYaml(await readFile(join(repoRoot, 'packages/video-generation/plugin.yaml'), 'utf8')).contractVersion);
    assert.match(videoGenerationManifestText, /src: assets\/icon\.svg/);
    assert.match(
      await readFile(
        join(consumer, 'node_modules/@clowder-ai/video-generation/README.md'),
        'utf8',
      ),
      /^# 视频与图片生成\n/m,
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
    assert.equal(weixinMpManifest.contractVersion, parseYaml(await readFile(join(repoRoot, 'packages/weixin-mp/plugin.yaml'), 'utf8')).contractVersion);
    assert.deepEqual(weixinMpManifest.runtime, {
      transport: 'builtin',
      entrypoint: 'dist/plugin-entrypoint.js',
    });
    const weixinMpRoot = join(consumer, 'node_modules/@clowder-ai/weixin-mp');
    const weixinMpEntrypoint = installedSdk.requirePluginModuleEntrypoint(
      (await import(pathToFileURL(join(weixinMpRoot, weixinMpManifest.runtime.entrypoint)).href)).default,
    );
    assert.equal(typeof weixinMpEntrypoint.create(weixinMpManifest).start, 'function');
    assert.match(
      await readFile(join(consumer, 'node_modules/@clowder-ai/weixin-mp/README.md'), 'utf8'),
      /^# 微信公众号\n/m,
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
    assert.equal(wechatReaderManifest.contractVersion, parseYaml(await readFile(join(repoRoot, 'packages/wechat-visible-reader/plugin.yaml'), 'utf8')).contractVersion);
    assert.deepEqual(wechatReaderManifest.runtime, {
      transport: 'builtin',
      entrypoint: 'dist/plugin-entrypoint.js',
    });
    const wechatReaderRoot = join(consumer, 'node_modules/@clowder-ai/wechat-visible-reader');
    const wechatReaderEntrypoint = installedSdk.requirePluginModuleEntrypoint(
      (await import(pathToFileURL(join(wechatReaderRoot, wechatReaderManifest.runtime.entrypoint)).href)).default,
    );
    assert.equal(typeof wechatReaderEntrypoint.create(wechatReaderManifest).start, 'function');
    assert.match(
      await readFile(
        join(consumer, 'node_modules/@clowder-ai/wechat-visible-reader/README.md'),
        'utf8',
      ),
      /^# 微信可见内容读取\n/m,
    );
    const enterpriseRoot = join(consumer, 'node_modules/@clowder-ai/enterprise-workflow');
    const enterpriseManifestText = await readFile(join(enterpriseRoot, 'plugin.yaml'), 'utf8');
    const enterpriseManifest = parseYaml(enterpriseManifestText);
    const enterpriseManifestValidation = installedContract.validateManifest(enterpriseManifest);
    assert.equal(
      enterpriseManifestValidation.valid,
      true,
      enterpriseManifestValidation.valid ? undefined : JSON.stringify(enterpriseManifestValidation.errors),
    );
    assert.deepEqual(enterpriseManifest.runtime, {
      transport: 'builtin',
      entrypoint: 'dist/plugin-entrypoint.js',
    });
    const enterpriseEntrypoint = installedSdk.requirePluginModuleEntrypoint(
      (await import(pathToFileURL(join(enterpriseRoot, enterpriseManifest.runtime.entrypoint)).href)).default,
    );
    assert.equal(typeof enterpriseEntrypoint.create(enterpriseManifest).start, 'function');
    assert.match(await readFile(join(enterpriseRoot, 'skills/enterprise-workflow/SKILL.md'), 'utf8'), /plugin_call/u);
    await readFile(
      join(consumer, 'node_modules/@clowder-ai/personal-chrome-companion/extension/manifest.json'),
      'utf8',
    );
    const companionConsumerCli = spawnSync(
      process.execPath,
      [
        'node_modules/@clowder-ai/personal-chrome-companion/native-host/native-host-cli.mjs',
        '--help',
      ],
      { cwd: consumer, encoding: 'utf8' },
    );
    assert.notEqual(companionConsumerCli.status, 0);
    assert.match(companionConsumerCli.stderr, /required personal Chrome host configuration is missing/);

    // Exercise the published setup runner with real files in an empty isolated HOME.
    const setupHome = join(consumer, 'setup-home');
    const setupProject = join(consumer, 'setup-project');
    await Promise.all([mkdir(setupHome), mkdir(setupProject)]);
    for (const [action, installed] of [['inspect', false], ['install', true], ['inspect', true], ['uninstall', false]]) {
      const setup = spawnSync(process.execPath, [
        'node_modules/@clowder-ai/personal-chrome-companion/native-host/setup-host.mjs', action, '--json',
        '--project-root', setupProject, '--home', setupHome, '--node', process.execPath,
      ], { cwd: consumer, encoding: 'utf8', timeout: 10_000,
        env: { PATH: process.env.PATH, HOME: setupHome } });
      assert.equal(setup.status, 0, setup.stderr);
      assert.equal(setup.stderr, '');
      const result = JSON.parse(setup.stdout);
      assert.equal(result.protocolVersion, 1);
      assert.equal(result.ok, true, setup.stdout);
      assert.equal(result.action, action);
      assert.equal(result.installed, installed);
      assert.equal(Object.hasOwn(result, 'pairingSecret'), false);
      assert.equal(Object.hasOwn(result, 'connected'), false);
    }

    run(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        "const { createRequire } = await import('node:module'); const require = createRequire(import.meta.url); const contract = await import('@clowder-ai/plugin-contract'); const conformance = await import('@clowder-ai/plugin-contract/conformance'); const companionSdk = await import('@clowder-ai/plugin-sdk/companion'); const metadata = require('@clowder-ai/plugin-contract/schemas/plugin-metadata'); const fixture = require('@clowder-ai/plugin-contract/fixtures/behavior/messaging/adversarial-invariants'); const sdk = await import('@clowder-ai/plugin-sdk'); const plugin = await import('@clowder-ai/feishu-meeting-intake'); const companion = await import('@clowder-ai/personal-chrome-companion'); const video = await import('@clowder-ai/video-analysis'); const xiangqi = await import('@clowder-ai/xiangqi'); const generation = await import('@clowder-ai/video-generation'); const weixinMp = await import('@clowder-ai/weixin-mp'); const wechatReader = await import('@clowder-ai/wechat-visible-reader'); const enterprise = await import('@clowder-ai/enterprise-workflow'); const calls=[]; const client=companionSdk.createCompanionClient({request:async command=>{calls.push(command);return {kind:'app-assist-settlement',scopeRef:'fresh-scope',revision:2,offerRef:'fresh-offer',action:'dismiss',outcome:'settled'};},subscribe:()=>()=>{}}); const settlement=await client.settleAppAssist('fresh-scope','fresh-offer','dismiss'); if (calls[0]?.kind !== 'app-assist.settle' || settlement.outcome !== 'settled' || typeof contract.validateManifest !== 'function' || typeof contract.validatePluginCatalog !== 'function' || metadata.title !== 'Clowder AI Plugin Product Metadata (v1)' || conformance.M0C_BEHAVIOR_CASE_IDS.length !== 12 || fixture.cases.length !== 12 || typeof sdk.definePlugin !== 'function' || typeof plugin.createFeishuMeetingIntakeRuntime !== 'function' || typeof video.createVideoAnalysisMcpServer !== 'function' || typeof xiangqi.createHostedBoard !== 'function' || typeof generation.startVideoGenerationServer !== 'function' || typeof weixinMp.createWeixinMpHandlers !== 'function' || typeof wechatReader.createWeChatVisibleReaderHandlers !== 'function' || typeof enterprise.createEnterpriseWorkflowPluginModule !== 'function' || typeof companion.default?.create !== 'function' || companion.PERSONAL_CHROME_APPEND_MESSAGE_METHOD !== 'personal-chrome-host.append-message') process.exit(1);",
      ],
      consumer,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
