import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  assertProductionDependencyClosure,
  assertWorkspaceSdkContractClosure,
  collectWorkspacePackageIntegrityMismatches,
} from './catalog-package-shrinkwrap.mjs';

const repoRoot = new URL('../', import.meta.url);
const workspaceContract = JSON.parse(
  await readFile(new URL('../packages/plugin-contract/package.json', import.meta.url), 'utf8'),
);
const workspaceSdk = JSON.parse(
  await readFile(new URL('../packages/plugin-sdk/package.json', import.meta.url), 'utf8'),
);
const releasedTrainC1Consumers = [
  'connector-dingtalk',
  'connector-feishu',
  'connector-telegram',
  'connector-wecom-agent',
  'connector-wecom-bot',
  'connector-weixin',
  'connector-xiaoyi',
  'enterprise-workflow',
  'wechat-visible-reader',
  'weixin-mp',
];

async function packWorkspacePackage(packageDirectory) {
  const destination = await mkdtemp(join(tmpdir(), 'clowder-shrinkwrap-identity-'));
  try {
    const result = spawnSync(
      process.execPath,
      ['scripts/pack-publish-artifact.mjs', packageDirectory, destination],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: process.env,
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    assert.equal(
      result.status,
      0,
      [result.stdout, result.stderr].filter(Boolean).join('\n'),
    );
    const [artifact] = JSON.parse(result.stdout);
    assert.equal(typeof artifact?.version, 'string');
    assert.equal(typeof artifact?.integrity, 'string');
    return { version: artifact.version, integrity: artifact.integrity };
  } finally {
    await rm(destination, { recursive: true, force: true });
  }
}

test('every released Train C1 SDK consumer closes over the current workspace contract', async () => {
  for (const directory of releasedTrainC1Consumers) {
    const shrinkwrap = JSON.parse(
      await readFile(new URL(`../packages/${directory}/npm-shrinkwrap.json`, import.meta.url), 'utf8'),
    );
    assertWorkspaceSdkContractClosure(shrinkwrap, {
      contractVersion: workspaceContract.version,
    });
  }
});

test('current workspace contract and SDK shrinkwrap entries pin exact-head packed bytes', async () => {
  const workspacePackages = {
    [workspaceContract.name]: await packWorkspacePackage('packages/plugin-contract'),
    [workspaceSdk.name]: await packWorkspacePackage('packages/plugin-sdk'),
  };
  const mismatches = [];

  for (const directory of releasedTrainC1Consumers) {
    const shrinkwrap = JSON.parse(
      await readFile(new URL(`../packages/${directory}/npm-shrinkwrap.json`, import.meta.url), 'utf8'),
    );
    for (const mismatch of collectWorkspacePackageIntegrityMismatches(
      shrinkwrap,
      workspacePackages,
    )) {
      mismatches.push({ directory, ...mismatch });
    }
  }

  assert.deepEqual(mismatches, []);
});

test('rejects a workspace SDK shrinkwrap that still pins the previous contract', () => {
  assert.throws(
    () => assertWorkspaceSdkContractClosure(
      {
        packages: {
          'node_modules/@clowder-ai/plugin-contract': { version: '0.1.0-beta.18' },
          'node_modules/@clowder-ai/plugin-sdk': {
            version: '0.2.0-beta.2',
            dependencies: { '@clowder-ai/plugin-contract': '0.1.0-beta.18' },
          },
        },
      },
      { contractVersion: '0.1.0-beta.19' },
    ),
    /@clowder-ai\/plugin-sdk@0\.2\.0-beta\.2 through a stale @clowder-ai\/plugin-contract/u,
  );
});

test('a different SDK version cannot bypass the current contract closure', () => {
  assert.throws(
    () => assertWorkspaceSdkContractClosure(
      {
        packages: {
          'node_modules/@clowder-ai/plugin-contract': { version: '0.1.0-beta.18' },
          'node_modules/@clowder-ai/plugin-sdk': {
            version: '0.2.0-beta.3',
            dependencies: { '@clowder-ai/plugin-contract': '0.1.0-beta.18' },
          },
        },
      },
      { contractVersion: '0.1.0-beta.19' },
    ),
    /@clowder-ai\/plugin-sdk@0\.2\.0-beta\.3 through a stale @clowder-ai\/plugin-contract/u,
  );
});

test('accepts a workspace SDK shrinkwrap closed over the current contract', () => {
  assert.doesNotThrow(() => assertWorkspaceSdkContractClosure(
    {
      packages: {
        'node_modules/@clowder-ai/plugin-contract': { version: '0.1.0-beta.19' },
        'node_modules/@clowder-ai/plugin-sdk': {
          version: '0.2.0-beta.2',
          dependencies: { '@clowder-ai/plugin-contract': '0.1.0-beta.19' },
        },
      },
    },
    { contractVersion: '0.1.0-beta.19' },
  ));
});

test('exact-head integrity only constrains shrinkwrap entries at the current workspace version', () => {
  assert.deepEqual(
    collectWorkspacePackageIntegrityMismatches(
      {
        packages: {
          'node_modules/@clowder-ai/plugin-contract': {
            version: '0.1.0-beta.15',
            integrity: 'sha512-historical',
          },
          'node_modules/@clowder-ai/plugin-sdk': {
            version: '0.2.0-beta.3',
            integrity: 'sha512-current-sdk',
          },
        },
      },
      {
        '@clowder-ai/plugin-contract': {
          version: '0.1.0-beta.20',
          integrity: 'sha512-current-contract',
        },
        '@clowder-ai/plugin-sdk': {
          version: '0.2.0-beta.3',
          integrity: 'sha512-current-sdk',
        },
      },
    ),
    [],
  );
});

test('reports current-version workspace package integrity drift', () => {
  assert.deepEqual(
    collectWorkspacePackageIntegrityMismatches(
      {
        packages: {
          'node_modules/@clowder-ai/plugin-contract': {
            version: '0.1.0-beta.20',
            integrity: 'sha512-stale-contract',
          },
        },
      },
      {
        '@clowder-ai/plugin-contract': {
          version: '0.1.0-beta.20',
          integrity: 'sha512-current-contract',
        },
      },
    ),
    [{
      packageName: '@clowder-ai/plugin-contract',
      packagePath: 'node_modules/@clowder-ai/plugin-contract',
      version: '0.1.0-beta.20',
      actualIntegrity: 'sha512-stale-contract',
      expectedIntegrity: 'sha512-current-contract',
    }],
  );
});

test('accepts direct dependencies whose packed lock entries close over the package declaration', () => {
  assert.doesNotThrow(() => assertProductionDependencyClosure(
    {
      dependencies: {
        '@clowder-ai/plugin-sdk': '0.2.0-beta.2',
        yaml: '^2.9.0',
      },
    },
    {
      packages: {
        '': {
          dependencies: {
            '@clowder-ai/plugin-sdk': '0.2.0-beta.2',
            yaml: '^2.9.0',
          },
        },
        'node_modules/@clowder-ai/plugin-sdk': {
          version: '0.2.0-beta.2',
          resolved: 'https://registry.npmjs.org/@clowder-ai/plugin-sdk/-/plugin-sdk-0.2.0-beta.2.tgz',
        },
        'node_modules/yaml': {
          version: '2.9.0',
          resolved: 'https://registry.npmjs.org/yaml/-/yaml-2.9.0.tgz',
        },
      },
    },
  ));
});

test('rejects a missing direct dependency entry', () => {
  assert.throws(
    () => assertProductionDependencyClosure(
      { dependencies: { '@clowder-ai/plugin-sdk': '0.2.0-beta.2' } },
      {
        packages: {
          '': { dependencies: { '@clowder-ai/plugin-sdk': '0.2.0-beta.2' } },
        },
      },
    ),
    /missing direct dependency node_modules\/@clowder-ai\/plugin-sdk/u,
  );
});

test('rejects root dependency declarations that drift from package.json', () => {
  assert.throws(
    () => assertProductionDependencyClosure(
      { dependencies: { runtime: '1.0.0' } },
      {
        packages: {
          '': { dependencies: { runtime: '0.9.0' } },
          'node_modules/runtime': {
            version: '1.0.0',
            resolved: 'https://registry.npmjs.org/runtime/-/runtime-1.0.0.tgz',
          },
        },
      },
    ),
    /root dependencies do not match package\.json/u,
  );
});

test('rejects a stale exact-version direct dependency entry', () => {
  assert.throws(
    () => assertProductionDependencyClosure(
      { dependencies: { '@clowder-ai/plugin-sdk': '0.2.0-beta.2' } },
      {
        packages: {
          '': { dependencies: { '@clowder-ai/plugin-sdk': '0.2.0-beta.2' } },
          'node_modules/@clowder-ai/plugin-sdk': { version: '0.1.0-beta.13' },
        },
      },
    ),
    /resolves @clowder-ai\/plugin-sdk to 0\.1\.0-beta\.13, expected 0\.2\.0-beta\.2/u,
  );
});

test('rejects a missing transitive production dependency entry', () => {
  assert.throws(
    () => assertProductionDependencyClosure(
      { dependencies: { '@clowder-ai/plugin-sdk': '0.2.0-beta.2' } },
      {
        packages: {
          '': { dependencies: { '@clowder-ai/plugin-sdk': '0.2.0-beta.2' } },
          'node_modules/@clowder-ai/plugin-sdk': {
            version: '0.2.0-beta.2',
            resolved: 'https://registry.npmjs.org/@clowder-ai/plugin-sdk/-/plugin-sdk-0.2.0-beta.2.tgz',
            dependencies: { '@clowder-ai/plugin-contract': '0.1.0-beta.18' },
          },
        },
      },
    ),
    /@clowder-ai\/plugin-sdk requires missing production dependency @clowder-ai\/plugin-contract/u,
  );
});

test('resolves nested production dependencies using node module ancestry', () => {
  assert.doesNotThrow(() => assertProductionDependencyClosure(
    { dependencies: { parent: '1.0.0' } },
    {
      packages: {
        '': { dependencies: { parent: '1.0.0' } },
        'node_modules/parent': {
          version: '1.0.0',
          resolved: 'https://registry.npmjs.org/parent/-/parent-1.0.0.tgz',
          dependencies: { child: '^2.0.0' },
        },
        'node_modules/parent/node_modules/child': {
          version: '2.0.0',
          resolved: 'https://registry.npmjs.org/child/-/child-2.0.0.tgz',
          dependencies: { leaf: '^3.0.0' },
        },
        'node_modules/parent/node_modules/leaf': {
          version: '3.0.0',
          resolved: 'https://registry.npmjs.org/leaf/-/leaf-3.0.0.tgz',
        },
      },
    },
  ));
});

test('rejects a production dependency resolved outside the npm registry', () => {
  assert.throws(
    () => assertProductionDependencyClosure(
      { dependencies: { runtime: '1.0.0' } },
      {
        packages: {
          '': { dependencies: { runtime: '1.0.0' } },
          'node_modules/runtime': {
            version: '1.0.0',
            resolved: 'file:../runtime',
          },
        },
      },
    ),
    /node_modules\/runtime must resolve from https:\/\/registry\.npmjs\.org\//u,
  );
});

test('includes optional dependencies in the production closure', () => {
  assert.throws(
    () => assertProductionDependencyClosure(
      { dependencies: { runtime: '1.0.0' } },
      {
        packages: {
          '': { dependencies: { runtime: '1.0.0' } },
          'node_modules/runtime': {
            version: '1.0.0',
            resolved: 'https://registry.npmjs.org/runtime/-/runtime-1.0.0.tgz',
            optionalDependencies: { optional: '^1.0.0' },
          },
        },
      },
    ),
    /runtime requires missing optional production dependency optional/u,
  );
});
