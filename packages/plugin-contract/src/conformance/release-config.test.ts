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
