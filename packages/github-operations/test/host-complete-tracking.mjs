import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { installedTrackingHost } from './installed-tracking-host.mjs';
import { artifactImports, seedLiveCollectors, measuredActions } from './installed-tracking-history.mjs';

const hostRoot = await realpath(process.env.CLOWDER_1843_HOST_ROOT ?? 'missing-explicit-host-root');
const artifact = await realpath(process.env.CLOWDER_1843_GITHUB_ARTIFACT_ROOT ?? 'missing-explicit-artifact-root');
const host = path => import(pathToFileURL(join(hostRoot, 'packages/api', path)).href);
const { ownedRedisFixture } = await host('test/helpers/owned-redis-fixture.js');
const { auditRecoveryRedis } = await host('test/helpers/recovery-store-audit.js');
const redisFixture = ownedRedisFixture('1843-installed-complete-tracking');
const load = artifactImports(artifact);

test('complete packed PR and issue actions await every original owner, with zero due work and zero provider calls', async t => {
  const f = await installedTrackingHost(t, { hostRoot, artifact, redisFixture });
  await f.runtime.start('instance', f.record);
  const audit = await auditRecoveryRedis(f.redis);
  try {
    await f.call('github.pr-tracking'); await f.call('github.issue-tracking'); await audit.flush();
    audit.assertIndexed();
    assert.equal(audit.reads.some(row => ['hscan', 'hgetall', 'smembers'].includes(row.command)), false);
    assert.equal(f.providerCalls(), 0);
  } finally { audit.stop(); }
});

test('import-only remains held through the real installed factory and never admits either complete action', async t => {
  const f = await installedTrackingHost(t, { hostRoot, artifact, redisFixture, held: true });
  await f.runtime.start('instance', f.record);
  await assert.rejects(f.call('github.pr-tracking'), /hold|import/i);
  await assert.rejects(f.call('github.issue-tracking'), /hold|import/i);
  assert.equal(f.providerCalls(), 0);
  assert.deepEqual(await f.facade.list(), {});
});

test('complete installed actions reach typed, collection, journal and migrated outbox consumers with original Host binding', async t => {
  const f = await installedTrackingHost(t, { hostRoot, artifact, redisFixture });
  await f.runtime.start('instance', f.record);
  const live = await seedLiveCollectors(f, load);
  await f.call('github.typed-wait.register-pr', { registrationId: 'native-pr', repoFullName: 'owner/repo', prNumber: 1,
    when: [{ kind: 'pr_ci_terminal' }] });
  await f.call('github.typed-wait.register-issue', { registrationId: 'native-issue', repoFullName: 'owner/repo', issueNumber: 1,
    when: [{ kind: 'issue_comment_added', authorLogins: ['not-observed'] }] });
  f.mode.scenario = 'event:11';
  const first = await measuredActions(f, auditRecoveryRedis);
  assert.equal(first.providerCalls, 5);
  assert.equal(f.sends.length, 1, JSON.stringify({ events: f.events, legacy: await f.facade.get(live.legacyKey) }));
  assert.deepEqual(f.sends[0].wake, { catId: 'codex61-sol' });
  const retained = await f.facade.get(live.legacyKey);
  assert.equal(retained.value.outbox, undefined);
  assert.equal(retained.value.task.id, live.legacyId);
  assert.equal(retained.value.task.automationState.issue.lastDeliveredCursor, 11);
  assert.equal((await f.tasks.get(live.legacyId)).updatedAt, retained.value.sourceUpdatedAt);
  f.mode.now += 60_001; f.mode.scenario = 'event:12';
  const second = await measuredActions(f, auditRecoveryRedis);
  assert.equal(second.providerCalls, 5); assert.equal(f.sends.length, 2);
  console.log(JSON.stringify({ first, second }));
});
