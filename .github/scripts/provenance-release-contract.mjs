import assert from 'node:assert/strict';

const RUN_URL_PATTERN =
  /^https:\/\/github\.com\/zts212653\/clowder-ai-plugins\/actions\/runs\/\d+\/attempts\/\d+$/u;

export function buildProvenanceVerificationEnvironment({
  publishedNow,
  repository,
  ref,
  commit,
  runId,
  runAttempt,
}) {
  assert.equal(typeof publishedNow, 'boolean');
  assert.equal(repository, 'zts212653/clowder-ai-plugins');
  assert.match(ref ?? '', /^refs\/heads\/[A-Za-z0-9._/-]+$/u);
  assert.match(commit ?? '', /^[a-f0-9]{40}$/u);
  assert.match(runId ?? '', /^\d+$/u);
  assert.match(runAttempt ?? '', /^\d+$/u);

  return {
    EXPECTED_PROVENANCE_REF: ref,
    EXPECTED_PROVENANCE_COMMIT: commit,
    // An immutable package keeps the run that originally uploaded it. A later
    // read-only recovery validates that signed run instead of rewriting it to
    // the recovery attempt. Only a fresh upload may claim the current run.
    EXPECTED_PROVENANCE_RUN: publishedNow
      ? `https://github.com/${repository}/actions/runs/${runId}/attempts/${runAttempt}`
      : '',
  };
}

export function buildProvenanceReceiptFields({ verification, repository }) {
  assert.equal(repository, 'zts212653/clowder-ai-plugins');
  assert.equal(verification?.provenanceVerified, true);
  assert.equal(
    verification.workflow?.repository,
    `https://github.com/${repository}`,
  );
  assert.equal(verification.workflow?.path, '.github/workflows/contract-ci.yml');
  assert.match(verification.workflow?.ref ?? '', /^refs\/heads\/[A-Za-z0-9._/-]+$/u);
  assert.equal(verification.source?.length, 1);
  assert.match(verification.source[0]?.digest?.gitCommit ?? '', /^[a-f0-9]{40}$/u);
  assert.match(verification.run ?? '', RUN_URL_PATTERN);

  return {
    repository: verification.workflow.repository,
    workflowRef: `${repository}/${verification.workflow.path}@${verification.workflow.ref}`,
    workflowHead: verification.source[0].digest.gitCommit,
    sourceRun: verification.run,
    provenance: {
      predicateType: verification.predicateType,
      source: verification.source,
      workflow: verification.workflow,
      run: verification.run,
    },
    provenanceVerified: true,
  };
}
