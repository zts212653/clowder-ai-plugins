import assert from 'node:assert/strict';
import test from 'node:test';
import { terminalFixture, terminalSnapshot, subject, target, time } from './terminal-fixture.js';
import { CommunityProjector } from '../src/business/domains/community/community-projector.js';
import { TerminalReconciliationRuntime } from '../src/terminal-reconciliation.js';

const pr = 'pr:example/project#13', issue = 'issue:example/project#99';

async function appendAndApply(f, event) {
  await f.community.events.append(event);
  await f.projector.apply(event);
}

// A body-enrichment event discovers a link after an earlier merge event.
// Rebuilding the PR must not replay that earlier merge against the new link.
test('rebuild never backdates a later issue association', async () => {
  const f = await terminalFixture();
  try {
    await appendAndApply(f, { sourceEventId: 'r2-old-merge', subjectKey: pr, kind: 'pr.merged',
      classification: 'state-changing', payload: { body: null }, at: 1 });
    await appendAndApply(f, { sourceEventId: 'r2-merge-body-enrichment', subjectKey: pr, kind: 'pr.merged',
      classification: 'state-changing', payload: { body: 'Fixes #99' }, at: 2 });
    await appendAndApply(f, { sourceEventId: 'r2-issue-reported', subjectKey: issue, kind: 'case.reported',
      classification: 'state-changing', payload: {}, at: 3 });
    await appendAndApply(f, { sourceEventId: 'r2-issue-closed', subjectKey: issue, kind: 'issue.closed',
      classification: 'state-changing', payload: {}, at: 4 });
    assert.equal((await f.community.objects.get(issue)).state, 'closed');
    await f.projector.rebuild(pr);
    const after = await f.community.objects.get(issue);
    const ids = (await f.community.events.read(issue)).map(e => e.sourceEventId);
    assert.equal(after.state, 'closed');
    assert.equal(ids.includes(`r2-old-merge:cascade:${issue}`), false);
  } finally { await f.community.stop(); }
});

// A later event's failure cannot discard an earlier merge's committed operation.
test('a later tail failure cannot discard a committed merge cascade', async () => {
  const f = await terminalFixture();
  try {
    await appendAndApply(f, { sourceEventId: 'r2-issue-bootstrap', subjectKey: issue, kind: 'case.bootstrap',
      classification: 'state-changing', payload: { mappedState: 'in_progress' }, at: 1 });
    await appendAndApply(f, { sourceEventId: 'r2-pr-open', subjectKey: pr, kind: 'pr.opened',
      classification: 'state-changing', payload: { body: 'Fixes #99' }, at: 1 });
    const merge = { sourceEventId: 'r2-pr-merge', subjectKey: pr, kind: 'pr.merged',
      classification: 'state-changing', payload: {}, at: 2 };
    const comment = { sourceEventId: 'r2-pr-comment', subjectKey: pr, kind: 'pr.review_submitted',
      classification: 'informational', payload: {}, at: 3 };
    await f.community.events.append(merge); await f.community.events.append(comment);
    let interrupted = false;
    const projector = new CommunityProjector(f.community.events, {
      get: key => f.community.objects.get(key), delete: key => f.community.objects.delete(key),
      listSubjectKeys: () => f.community.objects.listSubjectKeys(),
      save: async value => {
        if (!interrupted && value.subjectKey === pr && value.lastExternalActivityAt === 3) {
          interrupted = true; throw new Error('later event storage interrupted');
        }
        await f.community.objects.save(value);
      },
    }, f.community.projectionOperations);
    await assert.rejects(projector.apply(comment), /later event storage interrupted/);
    await f.projector.apply(comment);
    assert.equal((await f.community.objects.get(pr)).state, 'fixed');
    assert.equal((await f.community.objects.get(issue)).state, 'fixed');
    assert.equal((await f.community.events.read(issue)).filter(e => e.kind === 'pr.merged').length, 1);
  } finally { await f.community.stop(); }
});

// The full historical snapshot shares one provider-history admission decision.
test('legacy retry appends no review or activity', async () => {
  const f = await terminalFixture();
  try {
    await f.community.collectTracking(target, { state: 'merged', comments: [], reviews: [] });
    const before = await f.community.events.read(subject);
    await f.community.collectTracking(target, terminalSnapshot());
    const after = await f.community.events.read(subject), projected = await f.community.objects.get(subject);
    const added = after.slice(before.length);
    assert.equal(projected.terminalFacts, undefined);
    assert.deepEqual(added, []);
    assert.equal(projected.lastExternalActivityAt, null);
  } finally { await f.community.stop(); }
});

// An independently running projector temporarily deletes the legacy projection.
// Admission must use persistent history while the derived object is absent.
test('legacy admission survives a missing rebuild projection', async () => {
  const f = await terminalFixture();
  let unblock;
  try {
    await f.community.collectTracking(target, { state: 'merged', comments: [], reviews: [] });
    let deleted;
    const deletion = new Promise(resolve => { deleted = resolve; });
    const gate = new Promise(resolve => { unblock = resolve; });
    const projector = new CommunityProjector(f.community.events, {
      get: key => f.community.objects.get(key), save: value => f.community.objects.save(value),
      listSubjectKeys: () => f.community.objects.listSubjectKeys(),
      delete: async key => { await f.community.objects.delete(key); if (key === subject) { deleted(); await gate; } },
    }, f.community.projectionOperations);
    const rebuilding = projector.rebuild(subject);
    await deletion;
    const collecting = f.community.collectTracking(target, { ...terminalSnapshot(), reviews: [] });
    await new Promise(resolve => setImmediate(resolve)); unblock();
    await rebuilding; await collecting;
    assert.equal((await f.community.objects.get(subject)).terminalFacts, undefined);
  } finally { unblock?.(); await f.community.stop(); }
});

// A new GitHub merge after native case decline is not the same thing as an old
// GitHub terminal PR; an extant tracker can still deliver its final snapshot.
test('new provider merge after native decline preserves facts', async () => {
  const f = await terminalFixture();
  try {
    await appendAndApply(f, { sourceEventId: 'r2-declined-before-merge', subjectKey: subject,
      kind: 'case.declined', classification: 'state-changing', payload: {}, at: 100 });
    await f.community.collectTracking(target, terminalSnapshot());
    const projected = await f.community.objects.get(subject), events = await f.community.events.read(subject);
    assert.equal(projected.terminalFacts?.headSha, 'b'.repeat(40));
    assert.equal(projected.externalReview?.lifecycle, 'terminal');
    assert.equal(projected.externalReview?.lastDeliveredHeadSha, null);
    assert.ok(events.some(event => event.kind === 'pr.merged'));
  } finally { await f.community.stop(); }
});

// Observation time alone is progress, not a new business fact.
test('identical facts with newer read times are unchanged', async () => {
  const f = await terminalFixture();
  let action;
  try {
    await f.community.configs.upsert({ repo: target.repoFullName, guardThreadId: 'guard', guardCatId: 'guard' });
    await f.community.collectTracking(target, { state: 'merged', comments: [], reviews: [] });
    let now = time + 1000;
    action = new TerminalReconciliationRuntime({ storage: f.storage, projectionOperations: f.community.projectionOperations,
      provider: { read: async () => { const s = terminalSnapshot(), at = now++;
        return { ...s, terminalFacts: { ...s.terminalFacts, observedAt: at, ci: { ...s.terminalFacts.ci, observedAt: at } } };
      } } });
    const caller = { catId: 'cat', threadId: 'thread', userId: 'owner', invocationId: 'inv', assertCurrent: async () => {} };
    const first = await action.reconcile({ subjectKey: subject }, caller);
    const second = await action.reconcile({ subjectKey: subject }, caller);
    const count = (await f.community.events.read(subject)).filter(e => e.kind === 'pr.terminal_observed').length;
    assert.deepEqual([first.data.outcome, second.data.outcome, count], ['recorded', 'unchanged', 1]);
  } finally { await action?.stop(); await f.community.stop(); }
});
