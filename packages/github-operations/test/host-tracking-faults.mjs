import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { installedTrackingHost } from './installed-tracking-host.mjs';
import { artifactImports, seedLiveCollectors } from './installed-tracking-history.mjs';

const hostRoot = await realpath(process.env.CLOWDER_1843_HOST_ROOT ?? 'missing-explicit-host-root');
const artifact = await realpath(process.env.CLOWDER_1843_GITHUB_ARTIFACT_ROOT ?? 'missing-explicit-artifact-root');
const host = path => import(pathToFileURL(join(hostRoot, 'packages/api', path)).href);
const { ownedRedisFixture } = await host('test/helpers/owned-redis-fixture.js');
const redisFixture = ownedRedisFixture('1843-installed-faults'), load = artifactImports(artifact);
const { SdkCommunityEventLog } = await load('business/domains/community/CommunityEventLog.js');
const { SdkCommunityCollectionStore } = await load('community-collection.js');
const { SdkCommunityRepoConfigStore } = await load('business/domains/community/CommunityRepoConfigStore.js');
const { SUBJECTS, eventKey, journalIndex } = await load('business/domains/community/journal-directory.js');
const { collectionIndex } = await load('community-collection-record.js');
const { MIGRATED_ISSUE_INDEX } = await load('migrated-issue-record.js');
const route = (f, id, thread = f.thread.id) => ({ sourceEventId: id, subjectKey: 'issue:owner/repo#2',
  kind: 'case.routed', classification: 'state-changing', at: f.mode.now,
  payload: { ownerThreadId: thread, catId: 'codex61-sol', userId: 'owner' } });

test('installed issue action recovers an original append reservation after directory-write crash and process restart', async t => {
  const f = await installedTrackingHost(t, { hostRoot, artifact, redisFixture });
  await f.runtime.start('instance', f.record);
  await new SdkCommunityRepoConfigStore(f.facade).upsert({ repo: 'owner/repo', guardThreadId: f.thread.id, guardCatId: 'codex61-sol' });
  let crash = true;
  f.faults.beforeIndexed = async (...args) => {
    if (crash && args[1].startsWith(SUBJECTS)) { crash = false; throw new Error('synthetic directory disk failure'); }
  };
  await assert.rejects(new SdkCommunityEventLog(f.facade).append(route(f, 'original-route')), /disk failure/);
  assert.ok(await f.facade.get(eventKey('original-route')), 'immutable original event survived');
  await f.runtime.stop('instance', 'synthetic-crash-boundary'); await f.runtime.start('instance', f.record);
  await f.call('github.issue-tracking');
  const store = new SdkCommunityCollectionStore(f.facade, () => f.mode.now);
  assert.equal((await store.getBySubject('issue:owner/repo#2')).ownerCatId, 'codex61-sol');
  const journal = new SdkCommunityEventLog(f.facade);
  assert.deepEqual((await journal.read('issue:owner/repo#2')).filter(e => e.kind === 'case.routed').map(e => e.sourceEventId), ['original-route']);
  assert.equal((await journal.pendingRoutes('issue', f.mode.now)).length, 0);
});

test('installed route reconciliation preserves a reroute against late ack and cancellation against index rebuild', async t => {
  const f = await installedTrackingHost(t, { hostRoot, artifact, redisFixture });
  await f.runtime.start('instance', f.record);
  const live = await seedLiveCollectors(f, load), journal = new SdkCommunityEventLog(f.facade);
  await journal.append(route(f, 'old-route'));
  const selected = (await journal.pendingRoutes('issue', f.mode.now))[0];
  const next = await f.threads.create('owner', 'Next original route');
  await journal.append(route(f, 'new-route', next.id));
  await journal.finishRoute(selected.entry, false, f.mode.now);
  assert.equal((await journal.pendingRoutes('issue', f.mode.now)).length, 1);
  await f.call('github.issue-tracking');
  const task = await live.store.getBySubject('issue:owner/repo#2');
  assert.equal(task.threadId, next.id);
  assert.equal(await live.store.delete(task.id), true);
  await f.facade.rebuildIndex(collectionIndex('issue')); await f.facade.rebuildIndex(journalIndex('issue'));
  await f.runtime.stop('instance', 'synthetic-cold-recovery'); await f.runtime.start('instance', f.record);
  f.mode.now += 60_001;
  const before = f.events.length; await f.call('github.issue-tracking');
  assert.equal((await live.store.read(task.id)).task.status, 'done');
  assert.equal(f.events.slice(before).some(e => e.message === 'fixture-provider-read' && e.fields.number === 2), false);
});

test('installed migrated outbox retains exact receipt key after accepted message and failed ack; rebuild never duplicates it', async t => {
  const f = await installedTrackingHost(t, { hostRoot, artifact, redisFixture });
  await f.runtime.start('instance', f.record);
  const live = await seedLiveCollectors(f, load);
  let failAck = true;
  f.faults.beforeIndexed = async (...args) => {
    if (args[1] === live.legacyKey && failAck && !args[3].outbox && (await f.facade.get(live.legacyKey))?.value.outbox) {
      failAck = false; throw new Error('synthetic post-accept ack disk failure');
    }
  };
  f.mode.scenario = 'event:11'; await f.call('github.issue-tracking');
  const pending = await f.facade.get(live.legacyKey);
  assert.equal(pending.value.recovery.failures, 1); assert.ok(pending.value.outbox);
  assert.equal(f.sends.length, 1);
  await f.facade.rebuildIndex(MIGRATED_ISSUE_INDEX);
  await f.runtime.stop('instance', 'synthetic-cold-recovery'); await f.runtime.start('instance', f.record);
  f.mode.now += 60_001; await f.call('github.issue-tracking');
  const settled = await f.facade.get(live.legacyKey);
  assert.equal(settled.value.outbox, undefined); assert.equal(settled.value.task.id, live.legacyId);
  assert.equal(settled.value.sourceUpdatedAt, pending.value.sourceUpdatedAt);
  assert.equal(settled.value.task.automationState.issue.lastDeliveredCursor, 11);
  assert.equal(settled.value.recovery.failures, 1);
  assert.equal(f.events.filter(e => e.message === 'fixture-provider-read' && e.fields.number === 3).length, 1);
  assert.equal(f.sends.length, 2); assert.equal(f.sends[1].deduplicated, true);
  assert.equal(f.sends[0].messageId, f.sends[1].messageId);
  assert.equal(f.sends[0].idempotencyKey, pending.value.outbox.key);
});
