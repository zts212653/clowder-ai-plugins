import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

// Operator043 moves the whole Community business to the package. This is
// source/build inventory only; authenticated workflow and installed acceptance
// remain separate evidence, never inferred from presence.
for (const name of [
  'GuardianMatcher', 'RoleResolver', 'TriageOrchestrator',
  'community-closure-checklist', 'community-decision-queue',
  'community-decision-queue-closure', 'community-decision-queue-types',
  'community-route-recommendation', 'community-bootstrap', 'community-auto-tracking',
  'narrator/NarratorDriver',
]) {
  test(`whole Community migration accounts for ${name} without claiming installed replacement`, async () => {
    for (const directory of ['src', 'dist']) {
      await access(new URL(`../${directory}/business/domains/community/${name}.${directory === 'src' ? 'ts' : 'js'}`, import.meta.url));
    }
    const map = JSON.parse(await readFile(new URL('../migration/source-map.json', import.meta.url), 'utf8'));
    const entry = map.entries.find((entry: { source: string }) => entry.source.endsWith(`/${name}.ts`));
    assert.equal(entry.sourceHead, 'bb9f9f08ec574ee8888fbde9819ff95da96bb614');
    assert.equal(entry.removedPackageCopy, undefined);
    assert.equal(entry.realPackageReplacementVerified, false);
  });
}

test('default package does not ship the legacy automatic rebase/push executor', async () => {
  for (const directory of ['src', 'dist']) {
    await assert.rejects(access(new URL(`../${directory}/business/infrastructure/email/ConflictAutoExecutor.${directory === 'src' ? 'ts' : 'js'}`, import.meta.url)), { code: 'ENOENT' });
  }
});

test('package does not restore the old Host admission coverage helper', async () => {
  for (const directory of ['src', 'dist']) {
    await assert.rejects(access(new URL(`../${directory}/business/infrastructure/github/pr-review-event-wait-coverage.${directory === 'src' ? 'ts' : 'js'}`, import.meta.url)), { code: 'ENOENT' });
  }
});

test('narrator production source uses SDK persistence rather than a private Redis client', async () => {
  for (const directory of ['src', 'dist']) {
    const extension = directory === 'src' ? 'ts' : 'js';
    await access(new URL(`../${directory}/business/domains/community/narrator/SdkNarratorDelivery.${extension}`, import.meta.url));
    await assert.rejects(access(new URL(`../${directory}/business/domains/community/narrator/RedisNarratorDedupStore.${extension}`, import.meta.url)), { code: 'ENOENT' });
  }
});
