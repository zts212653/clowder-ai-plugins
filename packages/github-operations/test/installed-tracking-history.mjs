import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function artifactImports(artifact) {
  return async path => import(pathToFileURL(join(artifact, 'dist', path)).href);
}
function task(f, kind, number, status = 'done') {
  return { id: `settled-${kind}-${number}`, kind: `${kind}_tracking`, subjectKey: `${kind}:history/repo#${number}`,
    status, title: 'Retained synthetic history', why: '', createdBy: 'system', createdAt: 1, updatedAt: 1,
    threadId: f.thread.id, ownerCatId: 'codex61-sol', userId: 'owner' };
}
/** Synthetic setup calls the packed original owners and real Host adapter. It never calls a provider. */
export async function seedSettled(f, load, family, start, stop) {
  if (family === 'typed') {
    const { GitHubWaitStorage } = await load('typed-wait-storage.js');
    const store = new GitHubWaitStorage(f.facade);
    for (let n = start; n < stop; n++) await store.create(task(f, n % 2 ? 'issue' : 'pr', n + 1));
  } else if (family === 'collection') {
    const { collectionId, collectionKey, collectionIndexOwner } = await load('community-collection-record.js');
    const owner = collectionIndexOwner(f.facade);
    for (let n = start; n < stop; n++) {
      const row = task(f, n % 2 ? 'issue' : 'pr', n + 1); row.id = collectionId(row.subjectKey);
      assert.equal((await owner.publish(collectionKey(row.id), null, { schemaVersion: 1, task: row })).applied, true);
    }
  } else if (family === 'migrated') {
    const { migratedIssueKey, publishMigratedIssue } = await load('migrated-issue-record.js');
    for (let n = start; n < stop; n++) {
      const row = task(f, 'issue', n + 1);
      assert.equal((await publishMigratedIssue(f.facade, migratedIssueKey(row.id), null,
        { schemaVersion: 1, task: row, sourceUpdatedAt: row.updatedAt })).applied, true);
    }
  } else throw new Error('journal history is prepared as a separate original census case');
}

/** Retained legacy journal bytes are seeded before activation, then the real factory resumes its census. */
export async function seedJournal(f, load, size) {
  const { eventKey, JOURNAL_HEAD } = await load('business/domains/community/journal-directory.js');
  for (let n = 0; n < size; n++) {
    const event = { sourceEventId: `settled-journal-${n}`, subjectKey: 'issue:history/repo#1', kind: 'issue.commented',
      classification: 'informational', payload: { commentId: n + 1 }, at: n + 1 };
    await f.facade.set(eventKey(event.sourceEventId), { sequence: n, event });
  }
  await f.facade.set(JOURNAL_HEAD, { next: size, pending: null });
}

export async function seedLiveCollectors(f, load) {
  const { SdkCommunityEventLog } = await load('business/domains/community/CommunityEventLog.js');
  const { SdkCommunityCollectionStore } = await load('community-collection.js');
  const { SdkCommunityRepoConfigStore } = await load('business/domains/community/CommunityRepoConfigStore.js');
  const { migratedIssueKey, publishMigratedIssue } = await load('migrated-issue-record.js');
  await new SdkCommunityRepoConfigStore(f.facade).upsert({ repo: 'owner/repo', guardThreadId: f.thread.id, guardCatId: 'codex61-sol' });
  const journal = new SdkCommunityEventLog(f.facade), store = new SdkCommunityCollectionStore(f.facade, () => f.mode.now);
  for (const kind of ['pr', 'issue']) {
    await journal.append({ sourceEventId: `live-${kind}-route`, subjectKey: `${kind}:owner/repo#2`, kind: 'case.routed',
      classification: 'state-changing', at: 1, payload: { ownerThreadId: f.thread.id, catId: 'codex61-sol', userId: 'owner' } });
    await store.reconcileRoutes(kind);
  }
  const original = await f.tasks.create({ kind: 'issue_tracking', subjectKey: 'issue:owner/repo#3',
    title: 'Original synthetic legacy issue', why: '', userId: 'owner', createdBy: 'codex61-sol',
    ownerCatId: 'codex61-sol', threadId: f.thread.id });
  const legacy = { ...original, automationState: { issue: { issueState: 'open', lastCommentCursor: 0, lastDeliveredCursor: 0 } } };
  await publishMigratedIssue(f.facade, migratedIssueKey(original.id), null,
    { schemaVersion: 1, task: legacy, sourceUpdatedAt: original.updatedAt });
  return { store, legacyId: original.id, legacyKey: migratedIssueKey(original.id) };
}

export async function measuredActions(f, auditRecoveryRedis) {
  const before = f.providerCalls(), audit = await auditRecoveryRedis(f.redis);
  try {
    await f.call('github.pr-tracking'); await f.call('github.issue-tracking'); await audit.flush();
    audit.assertIndexed();
    assert.equal(audit.reads.some(row => row.command === 'hscan'), false, 'no periodic namespace or prefix scan');
    assert.equal(audit.reads.some(row => row.command === 'hgetall' && row.args[0]?.includes('plugin-private-state:')), false);
    return { commands: audit.reads.length, providerCalls: f.providerCalls() - before,
      hgets: audit.reads.filter(row => row.command === 'hget').length,
      hgetalls: audit.reads.filter(row => row.command === 'hgetall').length };
  } finally { audit.stop(); }
}
