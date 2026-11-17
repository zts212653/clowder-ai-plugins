import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { installedTrackingHost } from './installed-tracking-host.mjs';

const hostRoot = await realpath(process.env.CLOWDER_1843_HOST_ROOT ?? 'missing-explicit-host-root');
const artifact = await realpath(process.env.CLOWDER_1843_GITHUB_ARTIFACT_ROOT ?? 'missing-explicit-artifact-root');
const { ownedRedisFixture } = await import(pathToFileURL(join(hostRoot, 'packages/api/test/helpers/owned-redis-fixture.js')).href);
const redisFixture = ownedRedisFixture('github-network-recovery');
const original = async f => Object.entries(await f.facade.list()).find(([key]) => key.startsWith('github.typed-wait.v1.'));

for (const kind of ['pr', 'issue']) test(`packed ${kind} recovers eight network failures and offline changes through the native Host`, async t => {
  const f = await installedTrackingHost(t, { hostRoot, artifact, redisFixture });
  await f.runtime.start('instance', f.record);
  await f.call(`github.typed-wait.register-${kind}`, { registrationId: `network-${kind}`, repoFullName: 'owner/repo',
    [kind === 'pr' ? 'prNumber' : 'issueNumber']: 1, autoRenew: false,
    when: [kind === 'pr' ? { kind: 'pr_conversation_comment_added', authorLogins: ['contributor'] } : { kind: 'issue_comment_added' }] });
  const [key, entry] = await original(f), task = entry.value.task, baselineReads = f.providerCalls();
  f.mode.scenario = 'provider-network-error';
  for (let n = 0; n < 8; n++) {
    f.mode.now = (await f.facade.get(key)).value.recovery.nextPollAt + 1;
    await f.call(`github.${kind}-tracking`);
    assert.deepEqual((await f.facade.get(key)).value.task, task, 'failed observations never rewrite business progress');
    if (n === 4) { await f.runtime.stop('instance', 'simulated-restart'); await f.runtime.start('instance', f.record); }
  }
  assert.equal(f.providerCalls() - baselineReads, 8);
  const backedOff = await f.facade.get(key);
  assert.equal(backedOff.value.recovery.failures, 8); assert.equal(backedOff.value.recovery.disposition, undefined);
  assert.ok(backedOff.value.recovery.nextPollAt - f.mode.now <= 15 * 60_000);
  await f.runtime.stop('instance', 'network-recovered'); await f.runtime.start('instance', f.record);
  f.mode.scenario = 'event:11'; f.mode.now = backedOff.value.recovery.nextPollAt + 1;
  await f.call(`github.${kind}-tracking`);
  const after = (await f.facade.get(key)).value;
  assert.equal(after.task.automationState.waitOutcome.reason, 'matched');
  assert.equal(after.task.automationState.waitOutcome.generation, task.automationState.await.generation);
  assert.equal(after.task.automationState.waitOutcome.delivery, 'delivered');
  assert.equal(after.task.ownerCatId, task.ownerCatId); assert.equal(after.task.threadId, task.threadId);
  assert.equal(after.recovery.failures, 0);
  assert.equal(f.sends.filter(send => send.wake?.catId === task.ownerCatId).length, 1);
});

test('packed startup reindexes a legacy network pause without replacing its original wait', async t => {
  const f = await installedTrackingHost(t, { hostRoot, artifact, redisFixture });
  await f.runtime.start('instance', f.record);
  await f.call('github.typed-wait.register-issue', { registrationId: 'legacy-network', repoFullName: 'owner/repo', issueNumber: 1,
    autoRenew: false, when: [{ kind: 'issue_comment_added' }] });
  await f.runtime.stop('instance', 'before-upgrade');
  const [key, entry] = await original(f), task = entry.value.task;
  const recovery = { ...entry.value.recovery, failures: 5, disposition: 'needs_attention', reasonCode: 'github_observation_failed',
    lastError: { name: 'Error', message: 'GitHub command failed', code: 1, stderr: 'Get "https://api.github.com/user": EOF' } };
  delete recovery.retryable;
  await f.facade.compareAndSetIndexed(key, entry.revision, { ...entry.value, recovery }, { index: 'github-issue-waits', score: null });
  await f.facade.set('github.typed-wait.recovery-census.v1', { v: 1, status: 'ready', cursor: '0' });
  await f.facade.delete('github.typed-wait.recovery-census.v2');
  await f.runtime.start('instance', f.record);
  assert.deepEqual((await f.facade.get(key)).value.task, task);
  f.mode.now = (await f.facade.get(key)).value.recovery.nextPollAt + 1; f.mode.scenario = 'event:11';
  await f.call('github.issue-tracking');
  const after = (await f.facade.get(key)).value;
  assert.equal(after.task.automationState.waitOutcome.reason, 'matched');
  assert.equal(after.task.automationState.waitOutcome.delivery, 'delivered');
});
