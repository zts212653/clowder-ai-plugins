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
    /^          process\.stdout\.write\(distTags\.latest \?\? ''\);$/m,
    'registry verification must expose the current latest target for guarded reconciliation',
  );
  assertReservedLatestProtected(workflow);
}

function assertExactRegistryArtifactCanResume(workflow: string): void {
  const publishJob = workflow.match(/^  publish:\n[\s\S]*$/m)?.[0];

  assert.ok(publishJob, 'publish job must be active');
  assert.match(publishJob, /^      - name: Inspect existing registry version$/m);
  assert.match(publishJob, /^        id: registry$/m);
  assert.match(
    publishJob,
    /^          if npm view "\$PACKAGE_NAME@\$PACKAGE_VERSION" --json > "\$REGISTRY_JSON_PATH" 2>\/dev\/null; then$/m,
  );
  assert.match(
    publishJob,
    /^            if \(metadata\.version !== process\.env\.PACKAGE_VERSION\) \{\n              throw new Error\(`registry version mismatch: \$\{metadata\.version\}`\);\n            \}$/m,
  );
  assert.match(
    publishJob,
    /^            if \(metadata\.dist\?\.integrity !== process\.env\.EXPECTED_INTEGRITY\) \{\n              throw new Error\(`registry integrity mismatch: \$\{metadata\.dist\?\.integrity\}`\);\n            \}$/m,
  );
  assert.match(publishJob, /^            echo "already_published=true" >> "\$GITHUB_OUTPUT"$/m);
  assert.match(publishJob, /^            echo "already_published=false" >> "\$GITHUB_OUTPUT"$/m);
  assert.match(
    publishJob,
    /^        if: steps\.registry\.outputs\.already_published != 'true'$/m,
    'the publish command must be skipped only for an exact registry artifact match',
  );
}

function assertReservedLatestProtected(workflow: string): void {
  assert.doesNotMatch(
    workflow,
    /--tag(?:=|\s+)["']?latest\b/i,
    'no workflow job may publish the prerelease with the latest tag',
  );
  assert.doesNotMatch(
    workflow,
    /\bnpm\s+dist-tag\s+add\b[^\n]*\blatest\b/i,
    'no workflow job may add or move the reserved latest dist-tag',
  );
  assert.ok(
    workflow.includes(
      '                if [[ "$LATEST_VERSION" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+- ]]; then\n' +
        '                  npm dist-tag rm "$PACKAGE_NAME" latest\n' +
        '                  continue\n' +
        '                fi',
    ),
    'the workflow may remove latest only when npm assigned it to a prerelease',
  );
  assert.equal(
    workflow.match(/npm dist-tag rm "\$PACKAGE_NAME" latest/g)?.length,
    1,
    'the workflow must have exactly one guarded latest-removal path',
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
  assert.ok(
    publishJob.includes(
      '          NODE\n' +
        '              );\n' +
        '              then\n' +
        '                if [[ "$LATEST_VERSION" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+- ]]; then\n' +
        '                  npm dist-tag rm "$PACKAGE_NAME" latest\n' +
        '                  continue\n' +
        '                fi\n' +
        '                exit 0\n' +
        '              fi\n' +
        '            fi',
    ),
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

test('contract package is the current v0.1 beta while the protocol stays at signed v0.1', () => {
  assert.equal(contractPackage.version, '0.1.0-beta.2');
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
  assertReservedLatestProtected(releaseWorkflow);
});

test('publish resumes only when the existing registry artifact is an exact match', () => {
  assertExactRegistryArtifactCanResume(releaseWorkflow);
});

test('registry resume guard rejects hollow matches and inverted publish conditions', () => {
  const mutations = [
    replaceWorkflowOnce(
      '              throw new Error(`registry version mismatch: ${metadata.version}`);',
      '              console.warn(`registry version mismatch: ${metadata.version}`);',
    ),
    replaceWorkflowOnce(
      '              throw new Error(`registry integrity mismatch: ${metadata.dist?.integrity}`);',
      '              console.warn(`registry integrity mismatch: ${metadata.dist?.integrity}`);',
    ),
    replaceWorkflowOnce(
      '            echo "already_published=true" >> "$GITHUB_OUTPUT"',
      '            echo "already_published=false" >> "$GITHUB_OUTPUT"',
    ),
    replaceWorkflowOnce(
      "        if: steps.registry.outputs.already_published != 'true'",
      "        if: steps.registry.outputs.already_published == 'true'",
    ),
  ];

  for (const mutatedWorkflow of mutations) {
    assert.throws(() => assertExactRegistryArtifactCanResume(mutatedWorkflow));
  }
});

test('publish verifies the exact registry version and artifact integrity', () => {
  const publishJob = releaseWorkflow.match(/^  publish:\n[\s\S]*$/m)?.[0];

  assert.ok(publishJob, 'publish job must be active');
  assert.match(publishJob, /^      - name: Build package$/m);
  assert.match(publishJob, /^      - name: Pack release candidate$/m);
  assert.match(publishJob, /^        id: pack$/m);
  assert.match(publishJob, /^          npm pack --json --ignore-scripts > "\$PACK_JSON_PATH"$/m);
  assert.match(publishJob, /^      - name: Reconcile and verify registry version, integrity, and tags$/m);
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
      "process.stdout.write(distTags.latest ?? '');",
      "process.stdout.write('');",
    ),
    replaceWorkflowOnce(
      'throw new Error(`registry next tag mismatch: ${distTags.next}`);',
      'console.warn(`registry next tag mismatch: ${distTags.next}`);',
    ),
    replaceWorkflowOnce(
      'if [[ "$LATEST_VERSION" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+- ]]; then',
      'if true; then',
    ),
    replaceWorkflowOnce(
      'npm dist-tag rm "$PACKAGE_NAME" latest',
      'true',
    ),
  ];

  for (const mutatedWorkflow of mutations) {
    assert.throws(() => {
      assertPrereleaseDistTagsVerified(mutatedWorkflow);
      assertReservedLatestProtected(mutatedWorkflow);
    });
  }
});

test('registry verification rejects hollow comparisons and early success', () => {
  const mutations = [
    replaceWorkflowOnce(
      '          if (metadata.version !== process.env.PACKAGE_VERSION) {\n            throw new Error(`registry version mismatch: ${metadata.version}`);\n          }',
      '          if (metadata.version !== process.env.PACKAGE_VERSION) {\n            console.warn(`registry version mismatch: ${metadata.version}`);\n          }',
    ),
    replaceWorkflowOnce(
      '          if (metadata.dist?.integrity !== process.env.EXPECTED_INTEGRITY) {\n            throw new Error(`registry integrity mismatch: ${metadata.dist?.integrity}`);\n          }',
      '          if (metadata.dist?.integrity !== process.env.EXPECTED_INTEGRITY) {\n            console.warn(`registry integrity mismatch: ${metadata.dist?.integrity}`);\n          }',
    ),
    replaceWorkflowOnce(
      '          echo "registry verification failed for $PACKAGE_NAME@$PACKAGE_VERSION" >&2',
      '          exit 0\n          echo "registry verification failed for $PACKAGE_NAME@$PACKAGE_VERSION" >&2',
    ),
  ];

  for (const [index, mutatedWorkflow] of mutations.entries()) {
    assert.throws(
      () => assertRegistryVerificationFailsClosed(mutatedWorkflow),
      `registry verification mutation ${index + 1} must fail`,
    );
  }
});

test('reserved latest guard spans every workflow job', () => {
  const mutatedWorkflow = replaceWorkflowOnce(
    '      - name: Conformance runner\n        run: pnpm --filter @clowder-ai/plugin-contract conformance',
    '      - name: Conformance runner\n        run: pnpm --filter @clowder-ai/plugin-contract conformance\n\n      - name: Promote beta to latest\n        run: npm dist-tag add @clowder-ai/plugin-contract@0.1.0-beta.1 latest',
  );

  assertReservedLatestProtected(releaseWorkflow);
  assert.throws(() => assertReservedLatestProtected(mutatedWorkflow));
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
