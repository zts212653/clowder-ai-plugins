import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';

import { buildGateSteps, loadArtifactToolchainEnv } from './ci-gate.mjs';

test('real connector command module journey is reachable after SDK and connector builds', () => {
  const steps = buildGateSteps();
  const index = steps.findIndex(step => step.name === 'Connector command entrypoint parity');
  assert.ok(index > steps.findIndex(step => step.name === 'Connector package gates'));
  assert.equal(steps[index].command, 'node --import tsx --test scripts/connector-command-entrypoints.test.mjs');
});

const workflowText = readFileSync(
  new URL('../.github/workflows/contract-ci.yml', import.meta.url),
  'utf8',
);
const workspacePackage = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
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

test('immutable registry validation runs against the current catalog before final packing', () => {
  const steps = buildGateSteps();
  const catalog = steps.findIndex(entry => entry.name === 'Machine catalog');
  const registry = steps.findIndex(entry => entry.name === 'Immutable registry compatibility');
  assert.ok(catalog > steps.findIndex(entry => entry.name === 'SDK build'));
  assert.equal(registry, catalog + 1);
  assert.equal(steps[registry].command, 'pnpm registry:check');
  assert.equal(steps[registry + 1].command, 'pnpm pack:gate');
});

test('contract build precedes unit tests so artifact-consistency packs a built package', () => {
  const steps = buildGateSteps();
  const build = steps.findIndex(
    (entry) => entry.name === 'Build' && entry.command === 'pnpm --filter @clowder-ai/plugin-contract build',
  );
  const tests = steps.findIndex(
    (entry) => entry.name === 'Unit tests' && entry.command === 'pnpm --filter @clowder-ai/plugin-contract test',
  );
  assert.ok(build !== -1 && tests !== -1, 'contract build and unit test steps must exist');
  assert.ok(build < tests, 'artifact-consistency packs packages/plugin-contract; a clean checkout has no dist until the build step');
});

test('catalog check builds packages whose publish surface is generated', () => {
  const command = workspacePackage.scripts['catalog:check'];
  for (const name of ['xiangqi', 'github-operations']) {
    assert.ok(command.includes(`pnpm --filter @clowder-ai/${name} build`),
      `standalone catalog activation must build ${name} before packing`);
  }
  assert.ok(
    command.includes('pnpm --filter @clowder-ai/genoffice-docx build:renderer'),
    'catalog check must build the frozen GenOffice renderer',
  );
  assert.ok(
    command.includes('pnpm --filter @clowder-ai/personal-chrome-companion build'),
    'catalog check must build personal-chrome-companion',
  );
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
    const name = pkg.split('/')[1];
    const manifest = JSON.parse(readFileSync(new URL(`../packages/${name}/package.json`, import.meta.url), 'utf8'));
    assert.equal(manifest.scripts.test, 'node --import tsx --test src/**/*.test.ts', 'bounded gate must preserve each package test command');
  }
  assert.match(step.command, /typecheck; NODE_OPTIONS=/);
  assert.ok(step.command.includes(new URL('./test-file-deadline.mjs', import.meta.url).href));
  assert.match(step.command, /pnpm --filter "\$package" test; pnpm --filter "\$package" build/);
});

test('every package gate runs typecheck, test, lint, and build like the workflow', () => {
  const steps = buildGateSteps();
  for (const name of [
    'Feishu intake gates',
    'Video analysis gates',
    'Video generation gates',
    'Weixin MP gates',
    'WeChat visible reader gates',
    'GitHub operations gates',
  ]) {
    const step = steps.find((entry) => entry.name === name);
    assert.ok(step, `${name} must run in the shared local/CI gate`);
    for (const script of ['typecheck', 'test', 'lint', 'build']) {
      assert.ok(step.command.includes(` ${script}`), `${name} missing ${script}`);
    }
  }
  const github = steps.find(entry => entry.name === 'GitHub operations gates');
  assert.ok(github.command.indexOf(' build') < github.command.indexOf(' test'), 'GitHub tests load the declared built entrypoint');
  const genoffice = steps.find((entry) => entry.name === 'GenOffice typecheck and tests');
  assert.ok(genoffice.command.includes('typecheck'));
  assert.ok(genoffice.command.includes('test'));
  assert.ok(!genoffice.command.includes('lint'), 'workflow runs no GenOffice lint');
});

test('local gate runs every Chrome package check from its dedicated CI workflow', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/personal-chrome-companion-ci.yml', import.meta.url),
    'utf8',
  );
  const commands = [...workflow.matchAll(
    /^        run: (pnpm --filter @clowder-ai\/personal-chrome-companion \w+)$/gm,
  )].map(match => match[1]);
  assert.equal(commands.length, 4, 'dedicated CI must retain all four package checks');
  const steps = buildGateSteps();
  const index = steps.findIndex(step => step.name === 'Personal Chrome companion gates');
  assert.ok(index > steps.findIndex(step => step.name === 'SDK build'),
    'Chrome tests require built SDK and Contract dependencies');
  assert.equal(steps[index]?.command, commands.join(' && '));
});

test('both validation workflows have no package command missing from the local gate', () => {
  const gate = buildGateSteps().map(step => step.command).join(' && ');
  const externalSteps = new Set([
    'Assert tested HEAD is the PR\'s live head',
    'Companion browser layout contract',
    'Xiangqi browser journey',
    'Capture exact-head pack evidence',
    'Capture exact-head SDK pack evidence',
    'Verify immutable published package identity',
  ]);
  for (const filename of ['contract-ci.yml', 'personal-chrome-companion-ci.yml']) {
    const workflow = parse(readFileSync(new URL(`../.github/workflows/${filename}`, import.meta.url), 'utf8'));
    for (const step of workflow.jobs.validate.steps) {
      if (!step.run || step.run === 'pnpm gate:ci' || externalSteps.has(step.name)) continue;
      for (const command of step.run.trim().split(/\s*&&\s*/u)) {
        assert.ok(gate.includes(command), `${filename}: ${step.name}: missing ${command}`);
      }
    }
  }
});

test('Collective full package tests run before inventory and installed artifact checks', () => {
  const command = buildGateSteps().find(step => step.name === 'Package inventory').command;
  assert.equal(command, 'pnpm --filter @clowder-ai/collective-connector build && pnpm --filter @clowder-ai/collective-connector typecheck && pnpm --filter @clowder-ai/collective-connector test && pnpm test:package-inventory && pnpm --filter @clowder-ai/collective-connector test:source && pnpm --filter @clowder-ai/collective-connector test:installed');
});
