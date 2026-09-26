import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { buildGateSteps, loadArtifactToolchainEnv } from './ci-gate.mjs';

const workflowText = readFileSync(
  new URL('../.github/workflows/contract-ci.yml', import.meta.url),
  'utf8',
);

test('artifact toolchain env is read from the workflow, not duplicated', () => {
  const env = loadArtifactToolchainEnv(workflowText);
  assert.deepEqual(env, {
    ARTIFACT_NODE_VERSION: '24.18.0',
    ARTIFACT_NPM_VERSION: '11.16.0',
    ARTIFACT_ZLIB_VERSION: '1.3.1-e00f703',
  });
  assert.match(workflowText, /node-version: \$\{\{ env\.ARTIFACT_NODE_VERSION \}\}/);
});

test('toolchain env parser rejects a workflow without pinned versions', () => {
  assert.throws(
    () => loadArtifactToolchainEnv('name: Contract CI\n'),
    /ARTIFACT_NODE_VERSION missing/,
  );
});

test('gate starts with the artifact toolchain check and ends at pack:gate', () => {
  const steps = buildGateSteps();
  assert.equal(steps[0].name, 'Verify artifact toolchain');
  assert.equal(steps[0].env, 'artifact-toolchain');
  assert.equal(steps[1].name, 'Install dependencies');
  assert.equal(steps[1].command, 'pnpm install --frozen-lockfile');
  assert.equal(steps.at(-1).command, 'pnpm pack:gate');
});

test('connector gate covers all seven connectors in the workflow order', () => {
  const step = buildGateSteps().find((entry) => entry.name === 'Connector package gates');
  const expected = [
    '@clowder-ai/connector-telegram',
    '@clowder-ai/connector-dingtalk',
    '@clowder-ai/connector-feishu',
    '@clowder-ai/connector-wecom-agent',
    '@clowder-ai/connector-wecom-bot',
    '@clowder-ai/connector-weixin',
    '@clowder-ai/connector-xiaoyi',
  ];
  for (const pkg of expected) {
    assert.ok(step.command.includes(pkg), `connector gate missing ${pkg}`);
  }
  assert.match(step.command, /typecheck; pnpm --filter "\$package" test; pnpm --filter "\$package" build/);
});

test('every package gate runs typecheck, test, lint, and build like the workflow', () => {
  const steps = buildGateSteps();
  for (const name of [
    'Feishu intake gates',
    'Video analysis gates',
    'Video generation gates',
    'Weixin MP gates',
    'WeChat visible reader gates',
  ]) {
    const step = steps.find((entry) => entry.name === name);
    for (const script of ['typecheck', 'test', 'lint', 'build']) {
      assert.ok(step.command.includes(` ${script}`), `${name} missing ${script}`);
    }
  }
  const genoffice = steps.find((entry) => entry.name === 'GenOffice typecheck and tests');
  assert.ok(genoffice.command.includes('typecheck'));
  assert.ok(genoffice.command.includes('test'));
  assert.ok(!genoffice.command.includes('lint'), 'workflow runs no GenOffice lint');
});
