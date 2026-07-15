import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

interface ContractPackage {
  private?: boolean;
  version?: string;
}

interface BehaviorSuite {
  _meta?: {
    contractVersion?: string;
  };
}

const contractPackage = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as ContractPackage;

const releaseWorkflow = readFileSync(
  new URL('../../../../.github/workflows/contract-ci.yml', import.meta.url),
  'utf8',
);

const codeowners = readFileSync(
  new URL('../../../../.github/CODEOWNERS', import.meta.url),
  'utf8',
);

const releaseDependencyInputs = [
  '.npmrc',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
];

const releaseGovernanceInputs = [
  '.github/CODEOWNERS',
  '.github/workflows/contract-ci.yml',
];

const messagingBehaviorSuite = JSON.parse(
  readFileSync(
    new URL('../../fixtures/behavior/messaging/adversarial-invariants.json', import.meta.url),
    'utf8',
  ),
) as BehaviorSuite;

test('contract package is the publishable v0.1 release', () => {
  assert.equal(contractPackage.version, '0.1.0');
  assert.equal(contractPackage.private, false);
  assert.equal(messagingBehaviorSuite._meta?.contractVersion, contractPackage.version);
});

test('main pushes publish only after contract validation', () => {
  const publishJob = releaseWorkflow.match(/^  publish:\n[\s\S]*$/m)?.[0];

  assert.ok(publishJob, 'publish job must be active');
  assert.match(publishJob, /^    needs: validate$/m);
  assert.match(
    publishJob,
    /^    if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'$/m,
  );
  assert.match(publishJob, /^      id-token: write$/m);
  assert.match(
    publishJob,
    /^          NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}$/m,
  );
  assert.match(
    publishJob,
    /^        run: pnpm --filter @clowder-ai\/plugin-contract publish --provenance --access public$/m,
  );
});

test('release dependency inputs require contract owner review', () => {
  const ownerRules = new Set(
    codeowners
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  );

  for (const input of releaseDependencyInputs) {
    assert.ok(
      ownerRules.has(`/${input} @mindfn @zts212653`),
      `${input} must require both contract owners`,
    );
  }
});

test('release dependency inputs trigger pull request validation', () => {
  for (const input of releaseDependencyInputs) {
    assert.match(
      releaseWorkflow,
      new RegExp(`^      - '${input.replace('.', '\\.')}'$`, 'm'),
      `${input} must trigger contract validation`,
    );
  }
});

test('release governance inputs require contract owner review', () => {
  assert.match(
    codeowners,
    /^\/\.github\/CODEOWNERS @mindfn @zts212653$/m,
  );
  assert.match(
    codeowners,
    /^\.github\/workflows\/ @mindfn @zts212653$/m,
  );
});

test('release governance inputs trigger pull request validation', () => {
  for (const input of releaseGovernanceInputs) {
    assert.match(
      releaseWorkflow,
      new RegExp(`^      - '${input.replaceAll('.', '\\.')}'$`, 'm'),
      `${input} must trigger contract validation`,
    );
  }
});
