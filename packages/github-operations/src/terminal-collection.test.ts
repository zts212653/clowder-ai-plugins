import assert from 'node:assert/strict';
import test from 'node:test';
import { providerObservation } from './community-read-model.js';
import { terminalFixture as fixture, terminalSnapshot, subject, head, oldHead, target, time, nativeHistory } from '../test/terminal-fixture.js';
import { createCommunityHttpRouter } from './community-http-router.js';

test('new HEAD, final review and merge arriving in one batch survive inspection and rebuild', async t => {
  const f = await fixture(); t.after(() => f.community.stop());
  const snapshot = terminalSnapshot();
  await f.community.observeTracking(target, snapshot);
  await f.community.collectTracking(target, snapshot);
  const events = await f.community.events.read(subject), projection = await f.community.objects.get(subject);
  const read = providerObservation(subject, events, projection);
  assert.equal(read.headSha, head, 'terminal read must use the final provider HEAD');
  assert.equal(read.ci, 'pass');
  assert.equal(events.find(event => event.payload.reviewId === 10)?.payload.commitId, head);
  assert.equal(projection?.externalReview?.lifecycle, 'terminal');
  assert.equal(projection?.externalReview?.currentHeadSha, head, 'the existing board reads the final provider HEAD');
  assert.equal(projection?.externalReview?.lastDeliveredHeadSha, null);
  assert.equal(projection?.externalReview?.reviewerCatId, 'original-cat');
  assert.equal(f.sends(), 0);
  const router = await createCommunityHttpRouter({ storage: f.storage,
    threads: { get: async () => null, create: async () => { throw new Error('unexpected thread'); } },
    projectionOperations: f.community.projectionOperations,
    issues: { taskStore: { listByKind: async () => [], getBySubject: async () => null, upsertBySubject: async () => { throw new Error('unexpected tracking'); }, delete: async () => false } },
    drafts: { publisher: { create: async () => { throw new Error('unexpected publication'); }, find: async () => null },
      config: { defaultRepo: target.repoFullName, repoAllowlist: [target.repoFullName] } },
  });
  t.after(() => router.stop());
  const board = await router.forwardOwner({ principal: { kind: 'owner', id: 'owner' }, method: 'GET', path: 'github/community-board', query: { repo: target.repoFullName } });
  assert.equal(board.status, 200);
  const row = board.body.prItems.find((item: { prNumber: number }) => item.prNumber === target.number);
  assert.equal(row.headSha, head); assert.equal(row.externalReview.currentHeadSha, head);
  assert.equal(row.externalReview.ci.status, 'pass'); assert.equal(row.terminalFacts.ci.source, 'github-status-check-rollup');
  await f.projector.rebuild(subject);
  assert.deepEqual(providerObservation(subject, await f.community.events.read(subject), await f.community.objects.get(subject)), read);
});

test('closed without merge preserves final facts across terminal retries without reviving native work', async t => {
  const f = await fixture(); t.after(() => f.community.stop());
  await f.community.collectTracking(target, terminalSnapshot('closed'));
  const before = (await f.community.objects.get(subject))!.externalReview;
  await Promise.all([f.community.collectTracking(target, terminalSnapshot('closed')), f.community.collectTracking(target, terminalSnapshot('closed'))]);
  const events = await f.community.events.read(subject), projection = await f.community.objects.get(subject);
  assert.equal(providerObservation(subject, events, projection).headSha, head);
  assert.equal(projection?.terminalFacts?.mergedAt, null); assert.equal(projection?.terminalFacts?.mergeCommitSha, null);
  assert.deepEqual(nativeHistory(projection?.externalReview), nativeHistory(before));
  assert.equal(events.filter(event => event.kind === 'pr.terminal_observed').length, 1);
  assert.equal(f.sends(), 0);
});

test('concurrent and late sparse facts cannot regress final HEAD, merge or newer CI; a later real rerun may change CI', async t => {
  const f = await fixture(); t.after(() => f.community.stop());
  const snapshot = terminalSnapshot(), original = snapshot.terminalFacts!;
  const failing = { ...snapshot, terminalFacts: { ...original, observedAt: time + 2000,
    ci: { ...original.ci!, status: 'fail' as const, observedAt: time + 2000, checks: [{ name: 'gate', bucket: 'fail' }] } } };
  await Promise.all([f.community.collectTracking(target, snapshot), f.community.collectTracking(target, failing)]);
  await f.community.collectTracking(target, snapshot);
  const sparse = { ...snapshot, terminalFacts: { ...original, source: 'github-webhook' as const,
    observedAt: time + 3000, reviews: [], ci: null } };
  await f.community.collectTracking(target, sparse);
  let read = providerObservation(subject, await f.community.events.read(subject), await f.community.objects.get(subject));
  assert.equal(read.headSha, head); assert.equal(read.state, 'merged'); assert.equal(read.ci, 'fail');
  const passingAgain = { ...snapshot, terminalFacts: { ...original, observedAt: time + 4000, ci: { ...original.ci!, observedAt: time + 4000 } } };
  await f.community.collectTracking(target, passingAgain);
  read = providerObservation(subject, await f.community.events.read(subject), await f.community.objects.get(subject));
  assert.equal(read.ci, 'pass');
  const wrongHead = { ...snapshot, headSha: oldHead, terminalFacts: { ...original, headSha: oldHead, ci: null, observedAt: time + 5000 } };
  await assert.rejects(f.community.collectTracking(target, wrongHead), /conflicting terminal/);
  await f.projector.rebuild(subject);
  const rebuilt = providerObservation(subject, await f.community.events.read(subject), await f.community.objects.get(subject));
  assert.equal(rebuilt.headSha, head); assert.equal(rebuilt.ci, 'pass');
});

test('unknown CI and unbound review commits never become final positive evidence', async t => {
  const f = await fixture(); t.after(() => f.community.stop());
  const snapshot = terminalSnapshot(), facts = snapshot.terminalFacts!;
  await f.community.collectTracking(target, { ...snapshot, reviews: [{ ...snapshot.reviews[0]!, commitId: undefined }], terminalFacts: { ...facts,
    reviews: [{ ...facts.reviews[0]!, commitId: null }, { ...facts.reviews[0]!, id: 11, commitId: oldHead }],
    ci: { ...facts.ci!, status: 'unknown', checkRollup: 'empty', checks: [] },
  } });
  const read = providerObservation(subject, await f.community.events.read(subject), await f.community.objects.get(subject));
  assert.equal(read.ci, 'unknown'); assert.deepEqual(read.finalReviews, []);
});

test('an observation or assignment queued while open cannot reopen a provider-terminal subject', async t => {
  const f = await fixture(); t.after(() => f.community.stop());
  await f.community.collectTracking(target, terminalSnapshot());
  const before = (await f.community.objects.get(subject))!.externalReview;
  for (const [i, [kind, payload]] of ([
    ['case.head_observed', { headSha: oldHead }],
    ['case.external_review_assigned', { mode: 'maintainer_review', cloudPolicy: 'optional', reviewerCatId: 'late-cat', reviewerThreadId: 'late-thread' }],
  ] as const).entries()) {
    const event = { sourceEventId: `late-open-observation-${i}`, subjectKey: subject, kind, payload, classification: 'informational' as const, at: time + 5000 + i };
    await f.community.events.append(event); await f.projector.apply(event);
  }
  assert.deepEqual((await f.community.objects.get(subject))?.externalReview, before);
  await f.projector.rebuild(subject);
  assert.deepEqual((await f.community.objects.get(subject))?.externalReview, before);
});
