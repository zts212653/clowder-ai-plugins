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

const familyOwnedInputs = [
  'plugins/foreground-cat/',
  'assets/foreground-cat/',
  'LICENSE-ASSETS',
];

const messagingBehaviorSuite = JSON.parse(
  readFileSync(
    new URL('../../fixtures/behavior/messaging/adversarial-invariants.json', import.meta.url),
    'utf8',
  ),
) as BehaviorSuite;

test('contract package is a v0.1 beta while the protocol stays at signed v0.1', () => {
  assert.equal(contractPackage.version, '0.1.0-beta.1');
  assert.equal(contractPackage.private, false);
  assert.equal(messagingBehaviorSuite._meta?.contractVersion, '0.1.0');
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
    /^        run: npm publish "packages\/plugin-contract\/\$\{\{ steps\.pack\.outputs\.filename \}\}" --tag next --provenance --access public$/m,
  );
  assert.equal(
    releaseWorkflow.match(/\bnpm\s+publish\b/g)?.length,
    1,
    'the workflow must contain exactly one npm publish path',
  );
  assert.doesNotMatch(
    publishJob,
    /--tag(?:=|\s+)["']?latest\b/i,
    'the prerelease publish job must not publish with the latest tag',
  );
  assert.doesNotMatch(
    publishJob,
    /\bnpm\s+dist-tag\b[^\n]*\blatest\b/i,
    'the prerelease publish job must not mutate the latest dist-tag',
  );
});

test('publish verifies the exact registry version and artifact integrity', () => {
  const publishJob = releaseWorkflow.match(/^  publish:\n[\s\S]*$/m)?.[0];

  assert.ok(publishJob, 'publish job must be active');
  assert.match(publishJob, /^      - name: Build package$/m);
  assert.match(publishJob, /^      - name: Pack release candidate$/m);
  assert.match(publishJob, /^        id: pack$/m);
  assert.match(publishJob, /^          npm pack --json --ignore-scripts > "\$PACK_JSON_PATH"$/m);
  assert.match(publishJob, /^      - name: Verify registry version and integrity$/m);
  assert.match(publishJob, /npm view "\$PACKAGE_NAME@\$PACKAGE_VERSION" --json/);
  assert.match(
    publishJob,
    /^          if \(metadata\.version !== process\.env\.PACKAGE_VERSION\) \{$/m,
  );
  assert.match(
    publishJob,
    /^          if \(metadata\.dist\?\.integrity !== process\.env\.EXPECTED_INTEGRITY\) \{$/m,
  );
  assert.match(
    publishJob,
    /^          NODE\n              then\n                exit 0\n              fi\n            fi$/m,
    'registry verification must exit successfully only after both comparisons pass',
  );
  assert.match(
    publishJob,
    /^          echo "registry verification failed for \$PACKAGE_NAME@\$PACKAGE_VERSION" >&2\n          exit 1$/m,
    'registry verification exhaustion must fail the publish job',
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

test('family assets require cross-party review without owning ordinary plugin paths', () => {
  const ownerRules = new Set(
    codeowners
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  );

  for (const input of familyOwnedInputs) {
    assert.ok(
      ownerRules.has(`/${input} @zts212653 @mindfn`),
      `${input} must keep family-first ownership with cross-party review`,
    );
  }

  assert.equal(
    [...ownerRules].some((line) => line.startsWith('* ')),
    false,
    'ordinary plugin paths must remain unowned so their authors can merge after CI',
  );
});

test('contract validation reports on every pull request', () => {
  assert.match(releaseWorkflow, /^  pull_request: \{\}$/m);
});
