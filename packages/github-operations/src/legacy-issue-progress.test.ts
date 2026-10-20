import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { memoryStorage } from '../test/memory-storage.js';
import { copyLegacyIssueProgress, legacyIssueProgressBytes, readLegacyIssueProgress } from './legacy-issue-progress.js';

const subject = 'issue:example/project#12';
const signal = () => new AbortController().signal;
const raw = (issue: Record<string, unknown> = { lastCommentCursor: 9, lastDeliveredCursor: 4 }) => ({
  id: 'task', kind: 'issue_tracking', status: 'doing', subjectKey: subject,
  automationState: JSON.stringify({ issue }),
});
const envelope = (tasks: Record<string, Record<string, string>>) => ({ protocolVersion: 1,
  sourceDigest: createHash('sha256').update(legacyIssueProgressBytes(tasks)).digest('hex'), snapshot: { tasks } });

test('copy preserves independent frontiers and old single-cursor fallback, strips identity, and is insert-only', async () => {
  const storage = memoryStorage();
  const input = envelope({ task: { ...raw(), threadId: 'private-thread', userId: 'private-user' } });
  assert.equal((await copyLegacyIssueProgress(input, storage, signal())).data.imported, 1);
  assert.deepEqual(await readLegacyIssueProgress(subject, storage), { schema: 1, subject, collected: 9, delivered: 4 });
  assert.doesNotMatch(JSON.stringify(await storage.list()), /private/);
  assert.equal((await copyLegacyIssueProgress(input, storage, signal())).data.identical, 1);
  assert.equal((await copyLegacyIssueProgress(envelope({ task: raw({ lastCommentCursor: 20 }) }), storage, signal())).data.preserved, 1);
  const single = memoryStorage();
  await copyLegacyIssueProgress(envelope({ task: raw({ lastCommentCursor: 9 }) }), single, signal());
  assert.equal((await readLegacyIssueProgress(subject, single))?.delivered, 9);
});

test('full-batch validation refuses Host obligations, unknown fields, invalid frontiers and duplicate subjects before any write', async () => {
  const invalid = [
    raw({ lastCommentCursor: 9, pendingWake: { messageId: 'already-routed' } }),
    raw({ lastCommentCursor: 9, lastDeliveredCursor: 10 }), raw({ lastCommentCursor: -1 }),
    raw({ lastCommentCursor: 1.5 }), raw({ lastCommentCursor: 1, issueState: 'closed' }),
    raw({ lastCommentCursor: 1, arbitraryAuthority: true }),
    { ...raw(), automationState: JSON.stringify({ issue: { lastCommentCursor: 1 }, await: { kind: 'review' } }) },
    { ...raw(), deploymentWait: '{}' }, { ...raw(), probe: '{}' }, { ...raw(), resolveMode: 'wait' },
    { ...raw(), dispatchGate: '{}' }, { ...raw(), entrustedWork: '{}' },
    { ...raw(), status: 'done' }, { ...raw(), kind: 'pr_tracking' }, { ...raw(), unknown: 'field' },
    { ...raw(), subjectKey: 'issue:example/project#01' }, { ...raw(), automationState: '{' },
  ];
  for (const bad of invalid) {
    const storage = memoryStorage();
    await assert.rejects(copyLegacyIssueProgress(envelope({ a: { ...raw(), id: 'a', subjectKey: 'issue:example/project#1' }, task: bad }), storage, signal()));
    assert.deepEqual(await storage.list(), {});
  }
  const storage = memoryStorage();
  await assert.rejects(copyLegacyIssueProgress(envelope({ task: raw(), other: { ...raw(), id: 'other', subjectKey: subject.toUpperCase().replace('ISSUE:', 'issue:') } }), storage, signal()), /duplicate/);
  const input = envelope({ task: raw() });
  await assert.rejects(copyLegacyIssueProgress({ ...input, sourceDigest: '0'.repeat(64) }, storage, signal()), /digest/);
  await assert.rejects(copyLegacyIssueProgress(envelope({ task: { ...raw(), title: 'x'.repeat(256 * 1024) } }), storage, signal()), /256 KiB/);
  const many = Object.fromEntries(Array.from({ length: 101 }, (_, n) => [String(n), { ...raw(), id: String(n), subjectKey: `issue:example/project#${n + 1}` }]));
  await assert.rejects(copyLegacyIssueProgress(envelope(many), storage, signal()), /100 tasks/);
  assert.deepEqual(await storage.list(), {});
});

test('concurrent/partial copies converge; existing registrations and corrupt staging are never overwritten', async () => {
  const storage = memoryStorage(), input = envelope({ task: raw() });
  const results = await Promise.all([copyLegacyIssueProgress(input, storage, signal()), copyLegacyIssueProgress(input, storage, signal())]);
  assert.equal(results.reduce((n, result) => n + result.data.imported, 0), 1);
  const key = Object.keys(await storage.list())[0]!;
  await storage.set(key, { schema: 1, subject, collected: 1, delivered: 2 });
  await assert.rejects(readLegacyIssueProgress(subject, storage), /exceeds/);
  await assert.rejects(copyLegacyIssueProgress(input, storage, signal()), /exceeds/);
  const existing = memoryStorage();
  await existing.set('github.tracking.v1.' + createHash('sha256').update(subject).digest('hex'), { active: false });
  assert.equal((await copyLegacyIssueProgress(input, existing, signal())).data.preserved, 1);
  const partial = memoryStorage(), cas = partial.compareAndSet; let count = 0;
  partial.compareAndSet = async (...args) => { if (++count === 2) throw new Error('disk'); return cas(...args); };
  const batch = envelope({ task: raw(), z: { ...raw(), id: 'z', subjectKey: 'issue:example/project#13' } });
  await assert.rejects(copyLegacyIssueProgress(batch, partial, signal()), /disk/);
  partial.compareAndSet = cas;
  const retried = await copyLegacyIssueProgress(batch, partial, signal());
  assert.equal(retried.data.identical, 1); assert.equal(retried.data.imported, 1);
  const aborted = new AbortController(); aborted.abort(new Error('stopped'));
  await assert.rejects(copyLegacyIssueProgress(input, partial, aborted.signal), /stopped/);
});
