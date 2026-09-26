// Local replica of the Contract CI "Typecheck + Conformance" job: artifact
// toolchain check first, every check through pack:gate in the workflow's
// order. The workflow delegates to `pnpm gate:ci` so this script is the
// single source of truth — local runs and CI cannot drift apart.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));

export function loadArtifactToolchainEnv(workflowText) {
  const env = {};
  for (const match of workflowText.matchAll(
    /^  (ARTIFACT_(?:NODE|NPM|ZLIB)_VERSION): '([^']+)'$/gm,
  )) {
    env[match[1]] = match[2];
  }
  for (const name of [
    'ARTIFACT_NODE_VERSION',
    'ARTIFACT_NPM_VERSION',
    'ARTIFACT_ZLIB_VERSION',
  ]) {
    if (typeof env[name] !== 'string' || env[name].length === 0) {
      throw new Error(
        `${name} missing from .github/workflows/contract-ci.yml env; ` +
          'the local gate reads expected toolchain versions only from the workflow',
      );
    }
  }
  return env;
}

const CONNECTORS = [
  '@clowder-ai/connector-telegram',
  '@clowder-ai/connector-dingtalk',
  '@clowder-ai/connector-feishu',
  '@clowder-ai/connector-wecom-agent',
  '@clowder-ai/connector-wecom-bot',
  '@clowder-ai/connector-weixin',
  '@clowder-ai/connector-xiaoyi',
];

function chain(pkg, scripts) {
  return scripts.map((script) => `pnpm --filter ${pkg} ${script}`).join(' && ');
}

export function buildGateSteps() {
  return [
    {
      name: 'Verify artifact toolchain',
      command: 'node packages/plugin-contract/scripts/verify-artifact-toolchain.mjs',
      env: 'artifact-toolchain',
    },
    { name: 'Install dependencies', command: 'pnpm install --frozen-lockfile' },
    {
      name: 'Generated contract freshness',
      command: 'pnpm --filter @clowder-ai/plugin-contract generate:check',
    },
    { name: 'Typecheck', command: 'pnpm --filter @clowder-ai/plugin-contract typecheck' },
    { name: 'Unit tests', command: 'pnpm --filter @clowder-ai/plugin-contract test' },
    { name: 'Build', command: 'pnpm --filter @clowder-ai/plugin-contract build' },
    { name: 'SDK typecheck', command: 'pnpm --filter @clowder-ai/plugin-sdk typecheck' },
    { name: 'SDK unit tests', command: 'pnpm --filter @clowder-ai/plugin-sdk test' },
    { name: 'SDK build', command: 'pnpm --filter @clowder-ai/plugin-sdk build' },
    {
      name: 'Connector package gates',
      command:
        'set -e; for package in ' +
        CONNECTORS.join(' ') +
        '; do pnpm --filter "$package" typecheck; pnpm --filter "$package" test; pnpm --filter "$package" build; done',
    },
    {
      name: 'Enterprise workflow package gates',
      command: chain('@clowder-ai/enterprise-workflow', ['typecheck', 'test', 'lint', 'build']),
    },
    { name: 'Script test coverage', command: 'node scripts/assert-script-tests-covered.mjs' },
    { name: 'Script-only unit tests', command: 'pnpm test:scripts' },
    {
      name: 'Desktop window packed consumer',
      command: 'node --test scripts/desktop-window-consumer.test.mjs',
    },
    {
      name: 'Companion package consumer',
      command: chain('@clowder-ai/companion', ['build', 'test', 'lint']),
    },
    {
      name: 'Feishu intake gates',
      command: chain('@clowder-ai/feishu-meeting-intake', ['typecheck', 'test', 'lint', 'build']),
    },
    {
      name: 'Video analysis gates',
      command: chain('@clowder-ai/video-analysis', ['typecheck', 'test', 'lint', 'build']),
    },
    {
      name: 'Video generation gates',
      command: chain('@clowder-ai/video-generation', ['typecheck', 'test', 'lint', 'build']),
    },
    {
      name: 'Weixin MP gates',
      command: chain('@clowder-ai/weixin-mp', ['typecheck', 'test', 'lint', 'build']),
    },
    {
      name: 'WeChat visible reader gates',
      command: chain('@clowder-ai/wechat-visible-reader', ['typecheck', 'test', 'lint', 'build']),
    },
    {
      name: 'GenOffice typecheck and tests',
      command: chain('@clowder-ai/genoffice-docx', ['typecheck', 'test']),
    },
    { name: 'Git guards', command: 'pnpm test:guards' },
    { name: 'Fresh consumer install', command: 'pnpm test:fresh-consumer' },
    { name: 'Train C1 inventory closure', command: 'pnpm test:train-c1-inventory' },
    { name: 'Machine catalog', command: 'pnpm catalog:check' },
    { name: 'Immutable registry compatibility', command: 'pnpm registry:check' },
    { name: 'Pack gate (prepack must pass with lifecycle scripts)', command: 'pnpm pack:gate' },
  ];
}

function main() {
  const workflowText = readFileSync(
    new URL('../.github/workflows/contract-ci.yml', import.meta.url),
    'utf8',
  );
  const artifactEnv = loadArtifactToolchainEnv(workflowText);
  const steps = buildGateSteps();
  const startedAt = Date.now();

  for (const [index, step] of steps.entries()) {
    const label = `[gate:ci] ${index + 1}/${steps.length} ${step.name}`;
    process.stdout.write(`${label}\n`);
    const result = spawnSync(step.command, [], {
      cwd: repoRoot,
      shell: true,
      stdio: 'inherit',
      env:
        step.env === 'artifact-toolchain'
          ? { ...process.env, ...artifactEnv }
          : process.env,
    });
    const status = result.status ?? 1;
    if (status !== 0) {
      process.stderr.write(`${label} FAILED (exit ${status})\n`);
      process.exit(status);
    }
  }

  process.stdout.write(
    `[gate:ci] all ${steps.length} steps passed in ${Math.round((Date.now() - startedAt) / 1000)}s\n`,
  );
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
