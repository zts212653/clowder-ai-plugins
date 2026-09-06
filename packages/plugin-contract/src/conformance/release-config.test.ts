import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

interface ContractPackage {
  private?: boolean;
  version?: string;
  exports?: Record<string, unknown>;
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

const prereleasePublishActionUrl = new URL(
  '../../../../.github/actions/publish-prerelease/action.yml',
  import.meta.url,
);
const prereleasePublishAction = existsSync(prereleasePublishActionUrl)
  ? readFileSync(prereleasePublishActionUrl, 'utf8')
  : '';

const publishArtifactPackerUrl = new URL(
  '../../../../scripts/pack-publish-artifact.mjs',
  import.meta.url,
);
const publishArtifactPacker = existsSync(publishArtifactPackerUrl)
  ? readFileSync(publishArtifactPackerUrl, 'utf8')
  : '';

const artifactToolchainVerifierUrl = new URL(
  '../../scripts/verify-artifact-toolchain.mjs',
  import.meta.url,
);

const prereleaseLatestClassifierUrl = new URL(
  '../../scripts/classify-prerelease-latest.mjs',
  import.meta.url,
);

const releasePlan = readFileSync(
  new URL(
    '../../../../docs/plans/2026-07-16-p2-loopback-executor.md',
    import.meta.url,
  ),
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
  'scripts/pack-publish-artifact.mjs',
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

function assertPrereleaseDistTagsVerified(action: string): void {
  assert.equal(action.match(/npm view "\$PACKAGE_NAME" dist-tags --json/g)?.length, 3);
  assert.equal(
    action.match(/distTags\.next !== process\.env\.PACKAGE_VERSION/g)?.length,
    2,
  );
  assert.equal(
    action.match(/distTags\.latest !== process\.env\.PREVIOUS_LATEST/g)?.length,
    2,
  );
  assert.match(action, /process\.env\.HAD_PREVIOUS_LATEST === 'true'/);
  assert.equal(
    action.match(/!process\.env\.PACKAGE_VERSION\.includes\('-'\)/g)?.length,
    2,
    'both registry inspections must reject stable versions on the prerelease path',
  );
  assert.equal(
    action.match(
      /distTags\.latest !== undefined &&\n\s+distTags\.latest !== process\.env\.PACKAGE_VERSION/g,
    )?.length,
    2,
    'a first prerelease may keep npm-assigned latest only when it targets the exact artifact',
  );
  assert.doesNotMatch(
    action,
    /\bnpm\s+dist-tag\s+rm\b/,
    'the historical NPM_TOKEN route must not require unproven dist-tag deletion authority',
  );
}

function assertAuthorizedTokenPublicationBaseline(workflow: string): void {
  const validateJob = workflow.match(/^  validate:\n[\s\S]*?(?=^  publish:)/m)?.[0];
  const publishJob = workflow.match(/^  publish:\n[\s\S]*$/m)?.[0];

  assert.ok(validateJob, 'validate job must be active');
  assert.ok(publishJob, 'publish job must be active');
  assert.equal(
    workflow.match(/uses: actions\/setup-node@v6/g)?.length,
    2,
    'both validation and publication must use setup-node v6',
  );
  assert.equal(
    workflow.match(
      /node-version: \$\{\{ env\.ARTIFACT_NODE_VERSION \}\}/g,
    )?.length,
    2,
    'both jobs must consume the exact artifact-producing Node pin',
  );
  assert.match(workflow, /^  ARTIFACT_NODE_VERSION: '24\.18\.0'$/m);
  assert.match(workflow, /^  ARTIFACT_NPM_VERSION: '11\.16\.0'$/m);
  assert.match(workflow, /^  ARTIFACT_ZLIB_VERSION: '1\.3\.1-e00f703'$/m);
  assert.equal(
    workflow.match(
      /^        run: node packages\/plugin-contract\/scripts\/verify-artifact-toolchain\.mjs$/gm,
    )?.length,
    2,
    'both jobs must verify Node, npm, and zlib before producing package bytes',
  );
  assert.equal(
    existsSync(artifactToolchainVerifierUrl),
    true,
    'artifact toolchain verifier must be committed',
  );
  const verifier = readFileSync(artifactToolchainVerifierUrl, 'utf8');
  assert.match(verifier, /process\.version\.replace\(\/\^v\//);
  assert.match(verifier, /execFileSync\('npm', \['--version'\]/);
  assert.match(verifier, /zlib: process\.versions\.zlib/);
  assert.match(verifier, /actual\[name\] !== expected\[name\]/);
  assert.ok(
    validateJob.indexOf('Verify artifact toolchain') <
      validateJob.indexOf('- name: Build'),
    'validation must verify the toolchain before building package bytes',
  );
  assert.ok(
    publishJob.indexOf('Verify artifact toolchain') <
      publishJob.indexOf('- name: Build public packages'),
    'publication must verify the toolchain before building package bytes',
  );
  assert.match(workflow, /^      id-token: write$/m);
  assert.equal(
    workflow.match(/npm-token: \$\{\{ secrets\.NPM_TOKEN \}\}/g)?.length,
    5,
    'each public package action must receive the operator-authorized npm token',
  );
  assert.equal(
    prereleasePublishAction.match(/NODE_AUTH_TOKEN: \$\{\{ inputs\.npm-token \}\}/g)?.length,
    1,
    'the write token must be scoped to publication only',
  );
  assert.doesNotMatch(
    validateJob,
    /NPM_TOKEN|NODE_AUTH_TOKEN/,
    'pull-request validation must never receive the npm write token',
  );
}

function assertIdempotentExactArtifactResume(action: string): void {
  const inspectionStep = namedActionStep(action, 'Inspect registry before publish');
  assert.match(inspectionStep, /^      id: registry$/m);
  assert.match(
    inspectionStep,
    /if npm view "\$PACKAGE_NAME@\$PACKAGE_VERSION" --json > "\$VERSION_METADATA_PATH" 2> "\$VERSION_METADATA_ERROR_PATH"; then/,
  );
  assert.match(
    inspectionStep,
    /^          printf 'already_published=true\\n' >> "\$GITHUB_OUTPUT"$/m,
  );
  assert.match(
    inspectionStep,
    /^          printf 'already_published=false\\n' >> "\$GITHUB_OUTPUT"$/m,
  );
  assert.match(
    action,
    /^      if: steps\.registry\.outputs\.already_published != 'true'$/m,
    'npm publish may be skipped only after exact artifact verification',
  );
  assert.match(
    inspectionStep,
    /if \(metadata\.version !== process\.env\.PACKAGE_VERSION\) \{\n          throw new Error\(`registry version mismatch: \$\{metadata\.version\}`\);/,
  );
  assert.match(
    inspectionStep,
    /if \(metadata\.dist\?\.integrity !== process\.env\.EXPECTED_INTEGRITY\) \{\n          throw new Error\(`registry integrity mismatch: \$\{metadata\.dist\?\.integrity\}`\);/,
  );
}

function classifyPreviousLatest(
  distTags: Record<string, unknown>,
  packageVersion: string,
): string {
  const fixtureDirectory = mkdtempSync(join(tmpdir(), 'clowder-prerelease-tags-'));
  const fixturePath = join(fixtureDirectory, 'dist-tags.json');
  writeFileSync(fixturePath, JSON.stringify(distTags));

  try {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(prereleaseLatestClassifierUrl)],
      {
        env: {
          ...process.env,
          PACKAGE_TAGS_PATH: fixturePath,
          PACKAGE_VERSION: packageVersion,
        },
        encoding: 'utf8',
      },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  } finally {
    rmSync(fixtureDirectory, { recursive: true, force: true });
  }
}

function assertReservedLatestUnchanged(surface: string): void {
  assert.doesNotMatch(
    surface,
    /--tag(?:=|\s+)["']?latest\b/i,
    'no workflow job may publish the prerelease with the latest tag',
  );
  assert.doesNotMatch(
    surface,
    /\bnpm\s+dist-tag\s+add\b[^\n]*\blatest\b/i,
    'no release surface may add or move the reserved latest dist-tag',
  );
}

function namedWorkflowStep(workflow: string, name: string): string {
  const marker = `      - name: ${name}\n`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `workflow step missing: ${name}`);
  const next = workflow.indexOf('\n      - ', start + marker.length);
  return workflow.slice(start, next === -1 ? undefined : next);
}

function namedActionStep(action: string, name: string): string {
  const marker = `    - name: ${name}\n`;
  const start = action.indexOf(marker);
  assert.notEqual(start, -1, `action step missing: ${name}`);
  const next = action.indexOf('\n    - ', start + marker.length);
  return action.slice(start, next === -1 ? undefined : next);
}

function assertRegistryVerificationFailsClosed(action: string): void {
  const verificationStep = namedActionStep(action, 'Verify final registry state');

  assert.match(
    verificationStep,
    /if \(metadata\.version !== process\.env\.PACKAGE_VERSION\) \{\n          throw new Error\(`registry version mismatch: \$\{metadata\.version\}`\);/,
  );
  assert.match(
    verificationStep,
    /if \(metadata\.dist\?\.integrity !== process\.env\.EXPECTED_INTEGRITY\) \{\n          throw new Error\(`registry integrity mismatch: \$\{metadata\.dist\?\.integrity\}`\);/,
  );
  assert.match(
    verificationStep,
    /^        NODE\n            then\n              exit 0\n            fi\n          fi$/m,
    'registry verification must exit successfully only after every comparison passes',
  );
  assert.equal(
    verificationStep.match(/^\s*exit 0$/gm)?.length,
    1,
    'the publish job must have exactly one success exit',
  );
  assert.match(
    verificationStep,
    /^        echo "registry verification failed for \$PACKAGE_NAME@\$PACKAGE_VERSION" >&2\n        exit 1$/m,
    'registry verification exhaustion must fail the publish job',
  );
}

function replaceWorkflowOnce(search: string, replacement: string): string {
  const mutated = releaseWorkflow.replace(search, replacement);
  assert.notEqual(mutated, releaseWorkflow, `mutation target missing: ${search}`);
  return mutated;
}

function replaceActionOnce(search: string, replacement: string): string {
  const mutated = prereleasePublishAction.replace(search, replacement);
  assert.notEqual(mutated, prereleasePublishAction, `action mutation target missing: ${search}`);
  return mutated;
}

function replaceNamedStepOnce(
  stepName: string,
  search: string,
  replacement: string,
): string {
  const step = namedWorkflowStep(releaseWorkflow, stepName);
  const mutatedStep = step.replace(search, replacement);
  assert.notEqual(mutatedStep, step, `${stepName} mutation target missing: ${search}`);
  return releaseWorkflow.replace(step, mutatedStep);
}

function replaceNamedActionStepOnce(
  stepName: string,
  search: string,
  replacement: string,
): string {
  const step = namedActionStep(prereleasePublishAction, stepName);
  const mutatedStep = step.replace(search, replacement);
  assert.notEqual(mutatedStep, step, `${stepName} mutation target missing: ${search}`);
  return prereleasePublishAction.replace(step, mutatedStep);
}

test('independent content materialization publishes beta.15 while the broker protocol stays at signed v0.1', () => {
  assert.equal(contractPackage.version, '0.1.0-beta.15');
  assert.equal(contractPackage.private, false);
  assert.equal(messagingBehaviorSuite._meta?.contractVersion, '0.1.0');
});

test('host and SDK consumers can import the conformance and behavior boundaries', () => {
  assert.deepEqual(contractPackage.exports?.['./conformance'], {
    types: './dist/conformance/index.d.ts',
    import: './dist/conformance/index.js',
  });
  assert.equal(
    contractPackage.exports?.['./fixtures/behavior/messaging/adversarial-invariants'],
    './fixtures/behavior/messaging/adversarial-invariants.json',
  );
});

test('CI and release use the pinned toolchain and authorized token path', () => {
  assertAuthorizedTokenPublicationBaseline(releaseWorkflow);
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
  assert.equal(
    prereleasePublishAction.match(/\bnpm\s+publish\b/g)?.length,
    1,
    'the shared action must contain exactly one npm publish path',
  );
  assert.doesNotMatch(releaseWorkflow, /\bnpm\s+publish\b/);
  assert.doesNotMatch(
    `${releaseWorkflow}\n${prereleasePublishAction}`,
    /\b(?:pnpm|yarn)\b[^\n]*\bpublish\b/i,
    'the workflow must not add a second package-manager publish path',
  );
  assertIdempotentExactArtifactResume(prereleasePublishAction);
  assertReservedLatestUnchanged(`${releaseWorkflow}\n${prereleasePublishAction}`);
});

test('main publishes the public dependency chain through one hardened action', () => {
  assert.equal(
    existsSync(prereleasePublishActionUrl),
    true,
    'the prerelease publication action must be committed',
  );
  const orderedPackages = [
    'packages/plugin-contract',
    'packages/plugin-sdk',
    'packages/video-analysis',
    'packages/genoffice-docx',
    'packages/feishu-meeting-intake',
  ];
  let previousIndex = -1;

  for (const packageDirectory of orderedPackages) {
    const marker = `          package-directory: ${packageDirectory}`;
    const index = releaseWorkflow.indexOf(marker);
    assert.ok(index > previousIndex, `${packageDirectory} must publish in dependency order`);
    previousIndex = index;
  }
  assert.equal(
    releaseWorkflow.match(/uses: \.\/\.github\/actions\/publish-prerelease/g)?.length,
    orderedPackages.length,
    'all public packages must use the same hardened publication action',
  );
  assert.match(
    releaseWorkflow,
    /^      - '\.github\/actions\/publish-prerelease\/\*\*'$/m,
    'changes to the publication action must trigger the workflow',
  );
  assert.match(
    prereleasePublishAction,
    /node scripts\/pack-publish-artifact\.mjs "\$PACKAGE_DIRECTORY" "\$RUNNER_TEMP"/,
  );
  assert.match(
    publishArtifactPacker,
    /'pnpm',[\s\S]*'--config\.ignore-scripts=true',[\s\S]*'--config\.node-linker=hoisted',[\s\S]*'pack'/,
    'runtime closure materialization must be script-free and explicit',
  );
  assert.match(publishArtifactPacker, /assertCanonicalArchiveMembers/);
  assert.match(publishArtifactPacker, /assertPhysicalTree\(stagedPackageRoot\)/);
  assert.match(publishArtifactPacker, /createHash\('sha512'\)/);
  assert.match(prereleasePublishAction, /npm publish "\$PACKAGE_TARBALL"/);
  assert.match(prereleasePublishAction, /metadata\.dist\?\.integrity !== process\.env\.EXPECTED_INTEGRITY/);
  assert.match(prereleasePublishAction, /npm publish "\$PACKAGE_TARBALL" --tag next --provenance --access public/);
  assert.match(prereleasePublishAction, /distTags\.next !== process\.env\.PACKAGE_VERSION/);
  assert.match(prereleasePublishAction, /distTags\.latest !== process\.env\.PREVIOUS_LATEST/);
  assert.match(prereleasePublishAction, /process\.env\.PACKAGE_VERSION\.includes\('-'\)/);
  assert.doesNotMatch(prereleasePublishAction, /npm dist-tag rm "\$PACKAGE_NAME" latest/);
  assert.doesNotMatch(prereleasePublishAction, /npm dist-tag add[^\n]*latest/);
});

test('publish verifies the exact registry version and artifact integrity', () => {
  const publishJob = releaseWorkflow.match(/^  publish:\n[\s\S]*$/m)?.[0];

  assert.ok(publishJob, 'publish job must be active');
  assert.match(publishJob, /^      - name: Build public packages$/m);
  assert.match(prereleasePublishAction, /^    - name: Pack release candidate$/m);
  assert.match(prereleasePublishAction, /^      id: pack$/m);
  assert.match(prereleasePublishAction, /node scripts\/pack-publish-artifact\.mjs/);
  assert.match(publishArtifactPacker, /createHash\('sha512'\)/);
  assert.match(prereleasePublishAction, /^    - name: Verify final registry state$/m);
  assert.match(prereleasePublishAction, /npm view "\$PACKAGE_NAME@\$PACKAGE_VERSION" --json/);
  assertRegistryVerificationFailsClosed(prereleasePublishAction);
});

test('review pack evidence uses the publication package manager', () => {
  assert.match(releasePlan, /npm pack --json --ignore-scripts/);
  assert.doesNotMatch(
    releasePlan,
    /^pnpm\b[^\n]*\bpack\b/m,
    'pnpm pack produces different package contents and cannot prove npm publication bytes',
  );
});

test('required CI binds pack evidence to the exact checked-out head', () => {
  const validateJob = releaseWorkflow.match(
    /^  validate:\n[\s\S]*?(?=^  publish:)/m,
  )?.[0];
  const captureStep = namedWorkflowStep(
    releaseWorkflow,
    'Capture exact-head pack evidence',
  );
  const uploadStep = namedWorkflowStep(
    releaseWorkflow,
    'Upload exact-head pack evidence',
  );

  assert.ok(validateJob, 'validate job must be active');
  assert.match(
    validateJob,
    /^          ref: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}$/m,
  );
  assert.match(
    captureStep,
    /^          EXPECTED_HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}$/m,
  );
  assert.match(captureStep, /ACTUAL_HEAD_SHA=\$\(git rev-parse HEAD\)/);
  assert.match(captureStep, /"\$ACTUAL_HEAD_SHA" != "\$EXPECTED_HEAD_SHA"/);
  assert.match(captureStep, /git status --porcelain --untracked-files=no/);
  assert.match(
    captureStep,
    /npm pack --json --ignore-scripts --pack-destination "\$RUNNER_TEMP"/,
  );
  assert.match(captureStep, /headSha: process\.env\.ACTUAL_HEAD_SHA/);
  assert.match(captureStep, /node: process\.version/);
  assert.match(captureStep, /execFileSync\('npm', \['--version'\]/);
  assert.match(captureStep, /zlib: process\.versions\.zlib/);
  assert.match(
    uploadStep,
    /^          name: plugin-contract-pack-evidence-\$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}$/m,
  );
  assert.match(
    uploadStep,
    /^          path: \$\{\{ runner\.temp \}\}\/plugin-contract-pack-evidence\.json$/m,
  );
});

function assertImmutablePublishedPackageIdentity(workflow: string): void {
  const step = namedWorkflowStep(
    workflow,
    'Verify immutable published package identity',
  );

  assert.match(
    step,
    /^          PACK_JSON_PATH: \$\{\{ runner\.temp \}\}\/plugin-contract-pack\.json$/m,
  );
  assert.match(
    step,
    /^          REGISTRY_JSON_PATH: \$\{\{ runner\.temp \}\}\/plugin-contract-existing-registry\.json$/m,
  );
  assert.match(step, /npm view "\$PACKAGE_NAME@\$PACKAGE_VERSION" --json/);
  assert.match(
    step,
    /metadata\.dist\?\.integrity !== process\.env\.EXPECTED_INTEGRITY/,
    'an existing immutable version must compare registry integrity to exact-head pack bytes',
  );
  assert.match(
    step,
    /throw new Error\(`immutable registry integrity mismatch: \$\{metadata\.dist\?\.integrity\}`\);/,
    'an immutable package mismatch must fail validation rather than merely report evidence',
  );
}

test('validation fails before merge when an immutable registry version has different bytes', () => {
  assertImmutablePublishedPackageIdentity(releaseWorkflow);
});

test('artifact toolchain verifier accepts the exact runtime tuple', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(artifactToolchainVerifierUrl)], {
    env: {
      ...process.env,
      ARTIFACT_NODE_VERSION: process.version.replace(/^v/, ''),
      ARTIFACT_NPM_VERSION: execFileSync('npm', ['--version'], {
        encoding: 'utf8',
      }).trim(),
      ARTIFACT_ZLIB_VERSION: process.versions.zlib,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
});

test('artifact toolchain verifier rejects runtime drift', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(artifactToolchainVerifierUrl)], {
    env: {
      ...process.env,
      ARTIFACT_NODE_VERSION: process.version.replace(/^v/, ''),
      ARTIFACT_NPM_VERSION: execFileSync('npm', ['--version'], {
        encoding: 'utf8',
      }).trim(),
      ARTIFACT_ZLIB_VERSION: '0.0.0-drifted',
    },
    encoding: 'utf8',
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /artifact zlib version mismatch/);
});

test('subsequent prereleases preserve the pre-publish latest target', () => {
  assertPrereleaseDistTagsVerified(prereleasePublishAction);
});

test('first-release resume preserves npm-assigned latest without erasing historical latest', () => {
  assert.match(
    prereleasePublishAction,
    /node packages\/plugin-contract\/scripts\/classify-prerelease-latest\.mjs/,
  );
  assert.equal(
    classifyPreviousLatest(
      { latest: '0.1.0-beta.5', next: '0.1.0-beta.5' },
      '0.1.0-beta.5',
    ),
    '0.1.0-beta.5',
    'an npm-assigned latest on the exact prerelease is valid historical release state',
  );
  assert.equal(
    classifyPreviousLatest(
      { latest: '0.1.0-beta.1', next: '0.1.0-beta.9' },
      '0.1.0-beta.9',
    ),
    '0.1.0-beta.1',
    'an earlier historical latest must remain reserved',
  );
});

test('prerelease dist-tag guards reject fail-open action mutations', () => {
  const mutations = [
    replaceActionOnce(
      'npm view "$PACKAGE_NAME" dist-tags --json',
      'true',
    ),
    replaceActionOnce(
      'distTags.next !== process.env.PACKAGE_VERSION',
      'distTags.next === process.env.PACKAGE_VERSION',
    ),
    replaceActionOnce(
      'distTags.latest !== process.env.PREVIOUS_LATEST',
      'distTags.latest === process.env.PREVIOUS_LATEST',
    ),
    replaceActionOnce(
      "!process.env.PACKAGE_VERSION.includes('-')",
      "process.env.PACKAGE_VERSION.includes('-')",
    ),
    replaceActionOnce(
      'distTags.latest !== undefined &&\n          distTags.latest !== process.env.PACKAGE_VERSION',
      'distTags.latest === undefined ||\n          distTags.latest !== process.env.PACKAGE_VERSION',
    ),
  ];

  for (const mutatedAction of mutations) {
    assert.throws(() => assertPrereleaseDistTagsVerified(mutatedAction));
  }
});

test('authorized token publication and exact-resume guards reject workflow mutations', () => {
  const tokenRemovalMutation = replaceWorkflowOnce(
    '          npm-token: ${{ secrets.NPM_TOKEN }}\n',
    '',
  );
  const skipMutation = replaceActionOnce(
    "      if: steps.registry.outputs.already_published != 'true'",
    "      if: steps.registry.outputs.already_published == 'true'",
  );
  const hollowResumeMutation = replaceNamedActionStepOnce(
    'Inspect registry before publish',
    'throw new Error(`registry integrity mismatch: ${metadata.dist?.integrity}`);',
    'console.warn(`registry integrity mismatch: ${metadata.dist?.integrity}`);',
  );
  const floatingNodeMutation = replaceWorkflowOnce(
    'node-version: ${{ env.ARTIFACT_NODE_VERSION }}',
    "node-version: '24'",
  );

  assert.throws(() => assertAuthorizedTokenPublicationBaseline(tokenRemovalMutation));
  assert.throws(() => assertAuthorizedTokenPublicationBaseline(floatingNodeMutation));
  assert.throws(() => assertIdempotentExactArtifactResume(skipMutation));
  assert.throws(() => assertIdempotentExactArtifactResume(hollowResumeMutation));
});

test('registry verification rejects hollow comparisons and early success', () => {
  const mutations = [
    replaceNamedActionStepOnce(
      'Verify final registry state',
      'throw new Error(`registry version mismatch: ${metadata.version}`);',
      'console.warn(`registry version mismatch: ${metadata.version}`);',
    ),
    replaceNamedActionStepOnce(
      'Verify final registry state',
      'throw new Error(`registry integrity mismatch: ${metadata.dist?.integrity}`);',
      'console.warn(`registry integrity mismatch: ${metadata.dist?.integrity}`);',
    ),
    replaceNamedActionStepOnce(
      'Verify final registry state',
      '        echo "registry verification failed for $PACKAGE_NAME@$PACKAGE_VERSION" >&2',
      '        exit 0\n        echo "registry verification failed for $PACKAGE_NAME@$PACKAGE_VERSION" >&2',
    ),
  ];

  for (const mutatedAction of mutations) {
    assert.throws(() => assertRegistryVerificationFailsClosed(mutatedAction));
  }
});

test('immutable package identity guard rejects a fail-open workflow mutation', () => {
  const mutatedWorkflow = replaceNamedStepOnce(
    'Verify immutable published package identity',
    'throw new Error(`immutable registry integrity mismatch: ${metadata.dist?.integrity}`);',
    'console.warn(`immutable registry integrity mismatch: ${metadata.dist?.integrity}`);',
  );

  assert.throws(() => assertImmutablePublishedPackageIdentity(mutatedWorkflow));
});

test('reserved latest guard spans every workflow job', () => {
  const mutatedWorkflow = replaceWorkflowOnce(
    '      - name: Conformance runner\n        run: pnpm --filter @clowder-ai/plugin-contract conformance',
    '      - name: Conformance runner\n        run: pnpm --filter @clowder-ai/plugin-contract conformance\n\n      - name: Promote beta to latest\n        run: npm dist-tag add @clowder-ai/plugin-contract@0.1.0-beta.2 latest',
  );

  assertReservedLatestUnchanged(`${releaseWorkflow}\n${prereleasePublishAction}`);
  assert.throws(() =>
    assertReservedLatestUnchanged(`${mutatedWorkflow}\n${prereleasePublishAction}`),
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
  assert.match(
    codeowners,
    /^\/\.github\/actions\/publish-prerelease\/ @mindfn @zts212653$/m,
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

test('SDK changes execute pull-request validation', () => {
  const validateJob = releaseWorkflow.match(/^  validate:\n[\s\S]*?(?=^  publish:)/m)?.[0];

  assert.ok(validateJob, 'validation job must be active');
  assert.match(releaseWorkflow, /^  pull_request: \{\}$/m);
  assert.match(
    validateJob,
    /^      - name: SDK typecheck\n        run: pnpm --filter @clowder-ai\/plugin-sdk typecheck$/m,
  );
  assert.match(
    validateJob,
    /^      - name: SDK unit tests\n        run: pnpm --filter @clowder-ai\/plugin-sdk test$/m,
  );
  assert.match(
    validateJob,
    /^      - name: SDK build\n        run: pnpm --filter @clowder-ai\/plugin-sdk build$/m,
  );
  assert.ok(
    validateJob.indexOf('- name: Build\n        run: pnpm --filter @clowder-ai/plugin-contract build') <
      validateJob.indexOf('- name: SDK typecheck\n        run: pnpm --filter @clowder-ai/plugin-sdk typecheck'),
    'SDK checks must run after the contract build that provides their conformance import',
  );
});

test('loopback fixture changes execute pull-request validation', () => {
  const validateJob = releaseWorkflow.match(/^  validate:\n[\s\S]*?(?=^  publish:)/m)?.[0];

  assert.ok(validateJob, 'validation job must be active');
  assert.match(
    validateJob,
    /^      - name: Loopback fixture typecheck\n        run: pnpm --filter @clowder-ai\/loopback-fixture-plugin typecheck$/m,
  );
  assert.match(
    validateJob,
    /^      - name: Loopback fixture tests\n        run: pnpm --filter @clowder-ai\/loopback-fixture-plugin test$/m,
  );
  assert.match(
    validateJob,
    /^      - name: Loopback fixture lint\n        run: pnpm --filter @clowder-ai\/loopback-fixture-plugin lint$/m,
  );
  assert.match(
    validateJob,
    /^      - name: Loopback fixture build\n        run: pnpm --filter @clowder-ai\/loopback-fixture-plugin build$/m,
  );
  assert.ok(
    validateJob.indexOf('- name: SDK build\n        run: pnpm --filter @clowder-ai/plugin-sdk build') <
      validateJob.indexOf('- name: Loopback fixture typecheck\n        run: pnpm --filter @clowder-ai/loopback-fixture-plugin typecheck'),
    'loopback validation must run after its SDK dependency is built',
  );
});

test('official Feishu intake changes execute pull-request validation', () => {
  const validateJob = releaseWorkflow.match(/^  validate:\n[\s\S]*?(?=^  publish:)/m)?.[0];

  assert.ok(validateJob, 'validation job must be active');
  for (const [name, command] of [
    ['Feishu intake typecheck', 'pnpm --filter @clowder-ai/feishu-meeting-intake typecheck'],
    ['Feishu intake tests', 'pnpm --filter @clowder-ai/feishu-meeting-intake test'],
    ['Feishu intake lint', 'pnpm --filter @clowder-ai/feishu-meeting-intake lint'],
    ['Feishu intake build', 'pnpm --filter @clowder-ai/feishu-meeting-intake build'],
  ] as const) {
    assert.match(
      validateJob,
      new RegExp(`^      - name: ${name}\\n        run: ${command.replaceAll('/', '\\/')}$$`, 'm'),
    );
  }
  assert.ok(
    validateJob.indexOf('- name: SDK build\n        run: pnpm --filter @clowder-ai/plugin-sdk build') <
      validateJob.indexOf('- name: Feishu intake typecheck\n        run: pnpm --filter @clowder-ai/feishu-meeting-intake typecheck'),
    'Feishu intake validation must run after its SDK dependency is built',
  );
});

test('official video analysis changes execute pull-request validation', () => {
  const validateJob = releaseWorkflow.match(/^  validate:\n[\s\S]*?(?=^  publish:)/m)?.[0];

  assert.ok(validateJob, 'validation job must be active');
  for (const [name, command] of [
    ['Video analysis typecheck', 'pnpm --filter @clowder-ai/video-analysis typecheck'],
    ['Video analysis tests', 'pnpm --filter @clowder-ai/video-analysis test'],
    ['Video analysis lint', 'pnpm --filter @clowder-ai/video-analysis lint'],
    ['Video analysis build', 'pnpm --filter @clowder-ai/video-analysis build'],
    ['Machine catalog', 'pnpm catalog:check'],
  ] as const) {
    assert.match(
      validateJob,
      new RegExp(`^      - name: ${name}\\n        run: ${command.replaceAll('/', '\\/')}$$`, 'm'),
    );
  }
});

test('public consumer packages contain no workspace protocol and CI installs packed artifacts', () => {
  const npmrc = readFileSync(new URL('../../../../.npmrc', import.meta.url), 'utf8');
  const sdkPackage = JSON.parse(
    readFileSync(new URL('../../../../packages/plugin-sdk/package.json', import.meta.url), 'utf8'),
  ) as { dependencies: Record<string, string> };
  const feishuPackage = JSON.parse(
    readFileSync(
      new URL('../../../../packages/feishu-meeting-intake/package.json', import.meta.url),
      'utf8',
    ),
  ) as { dependencies: Record<string, string> };
  const videoPackage = JSON.parse(
    readFileSync(new URL('../../../../packages/video-analysis/package.json', import.meta.url), 'utf8'),
  ) as { dependencies: Record<string, string> };
  for (const dependencies of [sdkPackage.dependencies, feishuPackage.dependencies, videoPackage.dependencies]) {
    assert.equal(
      Object.values(dependencies).some((version) => version.startsWith('workspace:')),
      false,
    );
  }
  assert.match(npmrc, /^link-workspace-packages=true$/m);
  assert.match(releaseWorkflow, /pnpm test:fresh-consumer/);
});
