import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { installedTrackingHost } from './installed-tracking-host.mjs';
import { artifactImports } from './installed-tracking-history.mjs';

const hostRoot = await realpath(process.env.CLOWDER_1843_HOST_ROOT ?? 'missing-explicit-host-root');
const artifact = await realpath(process.env.CLOWDER_1843_GITHUB_ARTIFACT_ROOT ?? 'missing-explicit-artifact-root');
const host = path => import(pathToFileURL(join(hostRoot, 'packages/api', path)).href);
const { ownedRedisFixture } = await host('test/helpers/owned-redis-fixture.js');
const redisFixture = ownedRedisFixture('1843-installed-recovery-boundaries'), load = artifactImports(artifact);
const { collectionId, collectionKey, collectionPrefix, collectionIndexOwner } = await load('community-collection-record.js');
const { SdkCommunityRepoConfigStore } = await load('business/domains/community/CommunityRepoConfigStore.js');
const { eventKey, JOURNAL_HEAD } = await load('business/domains/community/journal-directory.js');
const { waitKey } = await load('typed-wait-record.js');

function collection(f, number) {
  const subjectKey = `issue:owner/repo#${number}`;
  return { schemaVersion: 1, task: { id: collectionId(subjectKey), kind: 'issue_tracking', subjectKey, userId: 'owner',
    ownerCatId: 'codex61-sol', threadId: f.thread.id, title: 'Retained original', why: '', status: 'doing',
    createdBy: 'system', createdAt: 1, updatedAt: 1 } };
}

test('twenty miskeyed collection records leave the real scheduled queue; history, concurrent repair and rebuild are preserved', async t => {
  const f = await installedTrackingHost(t, { hostRoot, artifact, redisFixture });
  await new SdkCommunityRepoConfigStore(f.facade).upsert({ repo: 'owner/repo', guardThreadId: f.thread.id, guardCatId: 'codex61-sol' });
  const bad = new Map();
  for (let n = 1; n <= 20; n++) {
    const key = collectionPrefix + n.toString(16).padStart(64, '0'), row = collection(f, n + 10);
    assert.notEqual(key, collectionKey(row.task.id)); bad.set(key, row); await f.facade.set(key, row);
  }
  const healthy = collection(f, 500); await f.facade.set(collectionKey(healthy.task.id), healthy);
  await f.runtime.start('instance', f.record);
  for (let n = 0; n < 8; n++) { await f.call('github.issue-tracking'); f.mode.now += 60_001; }
  assert.equal(f.providerCalls(), 8, 'a full bad batch cannot starve the healthy original');
  for (const [key, original] of bad) {
    const parked = (await f.facade.get(key)).value;
    assert.equal(parked.disposition, 'needs_attention'); assert.deepEqual(parked._collectionRecoveryCorruption, original);
  }
  await f.facade.rebuildIndex('github-collection-issue');
  await f.runtime.stop('instance', 'synthetic-cold-recovery'); await f.runtime.start('instance', f.record);
  await f.call('github.issue-tracking'); assert.equal(f.providerCalls(), 9);
  const due = await f.facade.readDue({ index: 'github-collection-issue', before: f.mode.now, limit: 20 });
  assert.equal(Object.keys(due.entries).some(key => bad.has(key)), false);
  const wrong = collectionKey(collection(f, 502).task.id), selected = collection(f, 501), repair = collection(f, 502);
  await f.facade.compareAndSetIndexed(wrong, null, selected, { index: 'github-collection-issue', score: 0 });
  let repairWon = false;
  f.faults.beforeIndexed = async (_plugin, key, revision, value) => {
    if (key === wrong && value._collectionRecoveryCorruption && !repairWon) {
      repairWon = true; await collectionIndexOwner(f.facade).publish(wrong, revision, repair);
    }
  };
  f.mode.now += 60_001; await f.call('github.issue-tracking');
  assert.equal(repairWon, true); assert.equal((await f.facade.get(wrong)).value.task.id, repair.task.id);
  f.mode.now += 60_001; await f.call('github.issue-tracking');
  assert.ok(f.events.some(row => row.message === 'fixture-provider-read' && row.fields.number === 502));
});

test('an installed old Host can read original subject and repository observations without any storage mutation', async t => {
  const f = await installedTrackingHost(t, { hostRoot, artifact, redisFixture, indexedCapabilities: false });
  const event = { sourceEventId: 'old-host-original', subjectKey: 'issue:owner/repo#1', kind: 'issue.commented',
    classification: 'informational', at: 1, payload: { commentId: 10 } };
  await f.facade.set(eventKey(event.sourceEventId), { sequence: 0, event });
  await f.facade.set(JOURNAL_HEAD, { next: 1, pending: null });
  const before = await f.facade.list();
  await f.runtime.start('instance', f.record);
  assert.deepEqual((await f.call('github.subject.inspect', { subjectKey: event.subjectKey })).data.events, [event]);
  assert.equal((await f.call('github.repository.observations', { repo: 'owner/repo' })).data.items.length, 1);
  await assert.rejects(f.call('github.typed-wait.register-pr', { registrationId: 'unsupported', repoFullName: 'owner/repo', prNumber: 1 }), /Indexed private storage is unavailable/);
  await assert.rejects(f.call('github.issue-tracking'), /Indexed private storage is unavailable/);
  assert.deepEqual(await f.facade.list(), before); assert.equal(f.providerCalls(), 0);
});

test('the installed tracking report exposes paused typed facts and quarantined original rows', async t => {
  const f = await installedTrackingHost(t, { hostRoot, artifact, redisFixture });
  await f.runtime.start('instance', f.record);
  await f.call('github.typed-wait.register-pr', { registrationId: 'paused-wait', repoFullName: 'owner/repo', prNumber: 1 });
  f.mode.scenario = 'provider-error';
  for (let n = 0; n < 7; n++) { f.mode.now += 60_001; await f.call('github.pr-tracking'); }
  const corruptKey = waitKey('corrupt-original'), original = { schemaVersion: 1, task: { id: 'corrupt-original', kind: 'broken' } };
  await f.facade.compareAndSetIndexed(corruptKey, null, original, { index: 'github-pr-waits', score: 0 });
  f.mode.now += 60_001; await f.call('github.pr-tracking');
  const before = await f.facade.list();
  const report = await f.call('github.tracking.list'), typed = report.data.recoveryOwners.typed;
  const paused = typed.find(row => row.recovery.reasonCode === 'github_observation_failed');
  assert.ok(paused); assert.equal(paused.recovery.failures, 5); assert.equal(paused.recovery.disposition, 'needs_attention');
  assert.equal(paused.sourceRevision, before[paused.sourceKey].revision);
  const corrupt = typed.find(row => row.sourceKey === corruptKey);
  assert.equal(corrupt.recovery.reasonCode, 'invalid_wait_record'); assert.equal(corrupt.recovery.disposition, 'needs_attention');
  assert.deepEqual((await f.facade.get(corruptKey)).value.task, original.task);
  assert.equal(report.data.tracking.length, 1); assert.deepEqual(await f.facade.list(), before);
  assert.equal(report.data.tracking[0].polling.state, 'paused');
  assert.equal(f.providerCalls(), 6, 'one baseline plus five true failures, no repeated failed observations');
  const originalTask = before[paused.sourceKey].value.task;
  assert.match(paused.recovery.lastError.message, /isolated provider observation failed/);
  await f.call('github.tracking.retry', { taskId: paused.taskId, expectedScope: paused.recovery.scope,
    expectedRecoveryRevision: paused.recovery.revision });
  assert.deepEqual((await f.facade.get(paused.sourceKey)).value.task, originalTask);
  assert.equal(f.providerCalls(), 6, 'the native retry must not capture a replacement baseline');
  assert.equal((await f.call('github.tracking.list')).data.tracking[0].polling.state, 'scheduled');
  f.mode.scenario = 'event:11'; f.mode.now += 60_001;
  await f.call('github.pr-tracking');
  assert.equal(f.sends.filter(send => send.wake?.catId === 'codex61-sol').length, 1,
    'an event that happened while paused reaches the original owner through the real Host');
});
