import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

import {
  buildProvenanceReceiptFields,
  buildProvenanceVerificationEnvironment,
} from './provenance-release-contract.mjs';

const repository = 'zts212653/clowder-ai-plugins';
const packageName = '@clowder-ai/feishu-meeting-intake';
const version = '0.1.0-alpha.10';
const integrity =
  'sha512-vjDAjFC15ELcrOzB0uLibsyrTDS7IOjzi/E2qCwfRA+njjcgJ1m9hVIOUOtNonBsvIsHJNl3dwJM2F2FKrPHHQ==';
const attestationUrl =
  'https://registry.npmjs.org/-/npm/v1/attestations/@clowder-ai%2ffeishu-meeting-intake@0.1.0-alpha.10';
const publishedRef = 'refs/heads/main';
const publishedCommit = '4b38777fa8f51fbae2cc4608b748f94fad3fbc6d';
const publishedRun =
  'https://github.com/zts212653/clowder-ai-plugins/actions/runs/35447079338/attempts/1';
const laterAttempt = '2';

const output = resolve(process.argv[2] ?? '');
assert(process.argv[2], 'output directory is required');
await mkdir(output, { recursive: true });

const root = fileURLToPath(new URL('../../', import.meta.url));
const verifier = join(root, '.github/scripts/verify-registry-provenance.mjs');
const verifierArguments = [packageName, version, integrity, attestationUrl];

function runVerifier(directory, environment) {
  return spawnSync(
    process.execPath,
    [verifier, ...verifierArguments, directory],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ...environment },
      maxBuffer: 16 * 1024 * 1024,
    },
  );
}

const recoveryEnvironment = buildProvenanceVerificationEnvironment({
  publishedNow: false,
  repository,
  ref: publishedRef,
  commit: publishedCommit,
  runId: '35447079338',
  runAttempt: laterAttempt,
});
assert.equal(recoveryEnvironment.EXPECTED_PROVENANCE_RUN, '');

const recoveryDirectory = join(output, 'existing-version-recovery');
const recoveryResult = runVerifier(recoveryDirectory, recoveryEnvironment);
assert.equal(
  recoveryResult.status,
  0,
  `existing-version recovery failed:\n${recoveryResult.stdout}\n${recoveryResult.stderr}`,
);
const recoveryVerification = JSON.parse(
  await readFile(join(recoveryDirectory, 'provenance-verification.json'), 'utf8'),
);
const recoveryReceipt = buildProvenanceReceiptFields({
  verification: recoveryVerification,
  repository,
});
assert.equal(recoveryReceipt.workflowHead, publishedCommit);
assert.equal(recoveryReceipt.sourceRun, publishedRun);

const strictEnvironment = buildProvenanceVerificationEnvironment({
  publishedNow: true,
  repository,
  ref: publishedRef,
  commit: publishedCommit,
  runId: '35447079338',
  runAttempt: laterAttempt,
});
const strictResult = runVerifier(join(output, 'new-upload-wrong-run'), strictEnvironment);
assert.notEqual(strictResult.status, 0, 'a fresh upload accepted the wrong run attempt');
assert.match(strictResult.stderr, /35447079338\/attempts\/1/u);
assert.match(strictResult.stderr, /35447079338\/attempts\/2/u);

const wrongSourceResult = runVerifier(join(output, 'wrong-source'), {
  ...recoveryEnvironment,
  EXPECTED_PROVENANCE_COMMIT: '0000000000000000000000000000000000000000',
});
assert.notEqual(wrongSourceResult.status, 0, 'provenance accepted the wrong source commit');
assert.match(wrongSourceResult.stderr, new RegExp(publishedCommit, 'u'));

const summary = {
  package: packageName,
  version,
  recovery: {
    publishedNow: false,
    expectedRef: publishedRef,
    expectedCommit: publishedCommit,
    expectedRun: null,
    receipt: recoveryReceipt,
  },
  freshUploadGuards: {
    wrongRunRejected: true,
    wrongSourceRejected: true,
  },
};
await writeFile(
  join(output, 'provenance-recovery-validation.json'),
  JSON.stringify(summary, null, 2) + '\n',
);
process.stdout.write(`${JSON.stringify(summary)}\n`);
