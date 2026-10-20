import assert from 'node:assert/strict';
import test from 'node:test';
import { SdkCommunityEventLog } from './business/domains/community/CommunityEventLog.js';
import { SdkCommunityObjectStore } from './business/domains/community/CommunityObjectStore.js';
import { SdkCommunityRepoConfigStore } from './business/domains/community/CommunityRepoConfigStore.js';
import { CommunityProjector } from './business/domains/community/community-projector.js';
import { CommunityReconciliationFindingStore } from './business/domains/community/reconciliation/CommunityReconciliationFindingStore.js';
import type { CommunityEvent } from './business/model/index.js';
import { memoryStorage } from '../test/memory-storage.js';
import { SdkCommunityIssueStore } from './business/domains/community/CommunityIssueStore.js';

const event = (id: string, subjectKey = 'issue:example/project#1'): CommunityEvent => ({
  sourceEventId: id, subjectKey, kind: 'issue.opened', classification: 'state-changing', payload: {}, at: 1,
});

test('SDK event log preserves global dedup, concurrent insertion order and subject-relative cursors', async () => {
  const storage = memoryStorage(); const log = new SdkCommunityEventLog(storage);
  const results = await Promise.all([log.append(event('one')), log.append(event('one', 'pr:example/project#2'))]);
  assert.equal(results.filter(r => r.appended).length, 1);
  await log.append(event('two')); await log.append(event('three'));
  assert.deepEqual((await log.read('issue:example/project#1')).map(e => e.sourceEventId), ['one', 'two', 'three']);
  assert.deepEqual((await new SdkCommunityEventLog(storage).read('issue:example/project#1', 1)).map(e => e.sourceEventId), ['two', 'three']);
  assert.deepEqual(await log.listSubjects(), ['issue:example/project#1']);
});

test('a crash between journal reservation and materialization is recovered without losing or duplicating a fact', async () => {
  const storage = memoryStorage(); const original = storage.compareAndSet;
  let crash = true;
  const log = new SdkCommunityEventLog({ ...storage, async compareAndSet(key, revision, value) {
    if (crash && key.startsWith('community.event.')) { crash = false; throw new Error('simulated storage outage'); }
    return original(key, revision, value);
  } });
  await assert.rejects(log.append(event('one')), /storage outage/);
  const recovered = new SdkCommunityEventLog(storage);
  assert.deepEqual((await recovered.read('issue:example/project#1')).map(e => e.sourceEventId), ['one']);
  assert.equal((await recovered.append(event('one'))).appended, false);
  assert.equal((await recovered.append(event('two'))).sequence, 1);
});

test('existing projector and configuration work with SDK storage and survive runtime recreation', async () => {
  const storage = memoryStorage(); const events = new SdkCommunityEventLog(storage);
  const objects = new SdkCommunityObjectStore(storage);
  const projector = new CommunityProjector(events, objects);
  await events.append(event('one')); await projector.rebuild('issue:example/project#1');
  assert.equal((await objects.get('issue:EXAMPLE/PROJECT#1'))?.state, 'new');
  const config = new SdkCommunityRepoConfigStore(storage);
  await config.upsert({ repo: 'Example/Project', guardThreadId: 'thread-1', guardCatId: 'cat-1', reviewMode: 'maintainer_review' });
  await config.upsert({ repo: 'example/project', guardThreadId: 'thread-2', guardCatId: 'cat-2' });
  assert.equal((await new SdkCommunityRepoConfigStore(storage).getByRepo('EXAMPLE/project'))?.reviewMode, 'maintainer_review');
  await projector.rebuild('issue:example/project#1');
  assert.equal((await events.read('issue:example/project#1')).length, 1);
});

test('finding waivers remain sticky, changed evidence reopens, absent findings resolve without erasing history', async () => {
  const storage = memoryStorage(); const findings = new CommunityReconciliationFindingStore(storage);
  const input = { findingId: 'finding-1', subjectKey: 'issue:example/project#1', findingKind: 'drift', severity: 'warning', message: 'drift', evidenceFingerprint: 'a' };
  await findings.upsert(input);
  await assert.rejects(findings.waive(input.findingId, { reason: '', actor: 'owner', evidence: 'evidence' }), /reason/);
  await findings.waive(input.findingId, { reason: 'accepted', actor: 'owner', evidence: 'evidence' });
  await findings.upsert(input); await findings.resolveAbsent(input.subjectKey, []);
  assert.equal((await findings.get(input.findingId))?.status, 'waived');
  await findings.upsert({ ...input, evidenceFingerprint: 'b' });
  assert.equal((await findings.get(input.findingId))?.status, 'open');
  await findings.resolveAbsent(input.subjectKey, []);
  const restored = new CommunityReconciliationFindingStore(storage);
  assert.equal((await restored.get(input.findingId))?.status, 'resolved');
  assert.equal((await restored.listAll()).length, 1);
  await restored.upsert({ ...input, evidenceFingerprint: 'b' });
  assert.equal((await restored.get(input.findingId))?.status, 'open');
});

test('SDK issue observations deduplicate subjects without creating governance authority', async () => {
  const storage = memoryStorage(), first = new SdkCommunityIssueStore(storage), second = new SdkCommunityIssueStore(storage);
  const input = { repo: 'example/project', issueNumber: 3, issueType: 'bug' as const, title: 'broken parser' };
  const created = await Promise.all([first.create(input), second.create(input)]);
  assert.equal(created.filter(Boolean).length, 1);
  const issue = created.find(Boolean)!;
  await first.update(issue.id, { title: 'observed title', linkedPrNumbers: [12] });
  assert.equal((await second.get(issue.id))?.title, 'observed title');
  assert.equal('guardianAssignment' in issue, false);
  for (const field of ['state', 'assignedCatId', 'assignedThreadId', 'guardianAssignment', 'ownerDecision', 'routeAcceptance', 'routeSource']) {
    await assert.rejects(first.update(issue.id, { [field]: 'forged' }), /unsupported/);
  }
  assert.equal((await second.listByRepo('example/project')).length, 1);
});

test('issue observation storage fails closed on corrupt metadata or historical authority fields', async () => {
  const storage = memoryStorage(), issues = new SdkCommunityIssueStore(storage);
  const issue = (await issues.create({ repo: 'example/project', issueNumber: 3, issueType: 'bug', title: 'observed' }))!;
  await assert.rejects(issues.update(issue.id, { linkedPrNumbers: [-1] }), /invalid/);
  await assert.rejects(issues.update(issue.id, { title: '' }), /invalid/);
  assert.equal((await issues.get(issue.id))?.title, 'observed');
  await storage.set(`community.issue.${issue.id}`, { ...issue, guardianAssignment: { signedOff: true } });
  await assert.rejects(issues.get(issue.id), /unsupported/);
  await assert.rejects(issues.listAll(), /unsupported/);
  await assert.rejects(issues.update(issue.id, { title: 'cannot silently preserve governance' }), /unsupported/);
});
