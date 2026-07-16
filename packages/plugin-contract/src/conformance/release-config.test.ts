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

function assertPrereleaseDistTagsVerified(workflow: string): void {
  const publishJob = workflow.match(/^  publish:\n[\s\S]*$/m)?.[0];

  assert.ok(publishJob, 'publish job must be active');
  assert.match(
    publishJob,
    /^          DIST_TAGS_JSON_PATH: \$\{\{ runner\.temp \}\}\/plugin-contract-dist-tags\.json$/m,
  );
  assert.match(
    publishJob,
    /^            if npm view "\$PACKAGE_NAME@\$PACKAGE_VERSION" --json > "\$REGISTRY_JSON_PATH" 2>\/dev\/null &&\n              npm view "\$PACKAGE_NAME" dist-tags --json > "\$DIST_TAGS_JSON_PATH" 2>\/dev\/null; then$/m,
  );
  assert.match(
    publishJob,
    /^          if \(distTags\.next !== process\.env\.PACKAGE_VERSION\) \{\n            throw new Error\(`registry next tag mismatch: \$\{distTags\.next\}`\);\n          \}$/m,
    'registry verification must require next to resolve to the published beta',
  );
  assert.match(
    publishJob,
    /^          if \(distTags\.latest === process\.env\.PACKAGE_VERSION\) \{\n            throw new Error\(`registry latest tag unexpectedly points to beta: \$\{distTags\.latest\}`\);\n          \}$/m,
    'registry verification must reject the beta becoming latest',
  );
}

function assertReservedLatestUnchanged(workflow: string): void {
  assert.doesNotMatch(
    workflow,
    /--tag(?:=|\s+)["']?latest\b/i,
    'no workflow job may publish the prerelease with the latest tag',
  );
  assert.doesNotMatch(
    workflow,
    /\bnpm\s+dist-tag\b[^\n]*\blatest\b/i,
    'no workflow job may mutate the reserved latest dist-tag',
  );
}

function assertRegistryVerificationFailsClosed(workflow: string): void {
  const publishJob = workflow.match(/^  publish:\n[\s\S]*$/m)?.[0];

  assert.ok(publishJob, 'publish job must be active');
  assert.match(
    publishJob,
    /^          if \(metadata\.version !== process\.env\.PACKAGE_VERSION\) \{\n            throw new Error\(`registry version mismatch: \$\{metadata\.version\}`\);\n          \}$/m,
  );
  assert.match(
    publishJob,
    /^          if \(metadata\.dist\?\.integrity !== process\.env\.EXPECTED_INTEGRITY\) \{\n            throw new Error\(`registry integrity mismatch: \$\{metadata\.dist\?\.integrity\}`\);\n          \}$/m,
  );
  assert.match(
    publishJob,
    /^          NODE\n              then\n                exit 0\n              fi\n            fi$/m,
    'registry verification must exit successfully only after every comparison passes',
  );
  assert.equal(
    publishJob.match(/^\s*exit 0$/gm)?.length,
    1,
    'the publish job must have exactly one success exit',
  );
  assert.match(
    publishJob,
    /^          echo "registry verification failed for \$PACKAGE_NAME@\$PACKAGE_VERSION" >&2\n          exit 1$/m,
    'registry verification exhaustion must fail the publish job',
  );
}

function replaceWorkflowOnce(search: string, replacement: string): string {
  const mutated = releaseWorkflow.replace(search, replacement);
  assert.notEqual(mutated, releaseWorkflow, `mutation target missing: ${search}`);
  return mutated;
}

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
    releaseWorkflow,
    /\b(?:pnpm|yarn)\b[^\n]*\bpublish\b/i,
    'the workflow must not add a second package-manager publish path',
  );
  assertReservedLatestUnchanged(releaseWorkflow);
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
  assertRegistryVerificationFailsClosed(releaseWorkflow);
});

test('publish verifies next points to the beta without moving latest', () => {
  assertPrereleaseDistTagsVerified(releaseWorkflow);
});

test('prerelease dist-tag guards reject fail-open workflow mutations', () => {
  const mutations = [
    replaceWorkflowOnce(
      'npm view "$PACKAGE_NAME" dist-tags --json > "$DIST_TAGS_JSON_PATH" 2>/dev/null',
      'true',
    ),
    replaceWorkflowOnce(
      'distTags.next !== process.env.PACKAGE_VERSION',
      'distTags.next === process.env.PACKAGE_VERSION',
    ),
    replaceWorkflowOnce(
      'distTags.latest === process.env.PACKAGE_VERSION',
      'distTags.latest !== process.env.PACKAGE_VERSION',
    ),
    replaceWorkflowOnce(
      'throw new Error(`registry next tag mismatch: ${distTags.next}`);',
      'console.warn(`registry next tag mismatch: ${distTags.next}`);',
    ),
  ];

  for (const mutatedWorkflow of mutations) {
    assert.throws(() => assertPrereleaseDistTagsVerified(mutatedWorkflow));
  }
});

test('registry verification rejects hollow comparisons and early success', () => {
  const mutations = [
    replaceWorkflowOnce(
      'throw new Error(`registry version mismatch: ${metadata.version}`);',
      'console.warn(`registry version mismatch: ${metadata.version}`);',
    ),
    replaceWorkflowOnce(
      'throw new Error(`registry integrity mismatch: ${metadata.dist?.integrity}`);',
      'console.warn(`registry integrity mismatch: ${metadata.dist?.integrity}`);',
    ),
    replaceWorkflowOnce(
      '          echo "registry verification failed for $PACKAGE_NAME@$PACKAGE_VERSION" >&2',
      '          exit 0\n          echo "registry verification failed for $PACKAGE_NAME@$PACKAGE_VERSION" >&2',
    ),
  ];

  for (const mutatedWorkflow of mutations) {
    assert.throws(() => assertRegistryVerificationFailsClosed(mutatedWorkflow));
  }
});

test('reserved latest guard spans every workflow job', () => {
  const mutatedWorkflow = replaceWorkflowOnce(
    '      - name: Conformance runner\n        run: pnpm --filter @clowder-ai/plugin-contract conformance',
    '      - name: Conformance runner\n        run: pnpm --filter @clowder-ai/plugin-contract conformance\n\n      - name: Promote beta to latest\n        run: npm dist-tag add @clowder-ai/plugin-contract@0.1.0-beta.1 latest',
  );

  assertReservedLatestUnchanged(releaseWorkflow);
  assert.throws(() => assertReservedLatestUnchanged(mutatedWorkflow));
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
