import assert from 'node:assert/strict';
import test from 'node:test';
import { terminalFixture, terminalSnapshot, subject, target, head, oldHead, time } from './terminal-fixture.js';
import { TerminalFactCollection } from '../src/terminal-fact-collection.js';

// A native review can be declined while the GitHub PR is still open. The normal
// typed-wait poll invokes observeTracking before collectTracking on every read.
test('observe then collect preserves native terminal reviewer and wake fence', async () => {
  const f = await terminalFixture();
  try {
    await f.community.configs.upsert({ repo: target.repoFullName, guardThreadId: 'guard',
      guardCatId: 'guard', reviewMode: 'maintainer_review' });
    const declined = { sourceEventId: 'r3-declined-before-open-observation', subjectKey: subject,
      kind: 'case.declined', classification: 'state-changing', payload: {}, at: 100 };
    await f.community.events.append(declined); await f.projector.apply(declined);
    const before = await f.community.objects.get(subject);
    await f.community.observeTracking({ ...target, catId: 'new-cat', threadId: 'new-thread' },
      { state: 'open', headSha: head, ci: 'pass', comments: [], reviews: [] });
    const after = await f.community.objects.get(subject);
    assert.equal(before.externalReview.lifecycle, 'terminal');
    await f.community.collectTracking({ ...target, catId: 'new-cat', threadId: 'new-thread' },
      { state: 'open', headSha: head, ci: 'pass', comments: [], reviews: [] });
    assert.deepEqual(after.externalReview, before.externalReview);
    assert.equal(after.externalReview.reviewerCatId, 'original-cat');
    assert.equal(after.externalReview.wake, null);
  } finally { await f.community.stop(); }
});

// A pre-upgrade closed-unmerged PR can later be reopened and merged. A new
// active tracking observation is not a request to repair the earlier closure.
test('a new provider open and merge does not backfill the old closed period', async () => {
  const f = await terminalFixture();
  try {
    await f.community.collectTracking(target, { state: 'closed', comments: [], reviews: [] });
    const before = await f.community.events.read(subject);
    await f.community.collectTracking(target, { state: 'open', headSha: oldHead, ci: 'pass',
      comments: [{ id: 42, author: 'user', body: 'new activity', commentType: 'conversation' }],
      reviews: [], commentsComplete: true });
    await f.community.collectTracking(target, terminalSnapshot('merged'));
    const after = await f.community.events.read(subject), projection = await f.community.objects.get(subject);
    assert.deepEqual(after.slice(0,before.length), before);
    assert.equal(projection.terminalFacts?.headSha, head);
    assert.equal(projection.externalReview.lifecycle, 'terminal');
    assert.equal(projection.externalReview.reviewerCatId, 'original-cat');
    assert.equal(projection.externalReview.wake, null);
  } finally { await f.community.stop(); }
});

// Scheduled collection can persist an API snapshot as only a terminal event;
// it does not necessarily create separate review events. A later merged webhook
// is sparse but the previous same-HEAD CI and review remain valid provenance.
test('sparse new merge preserves prior review and CI provenance without stale current success', async () => {
  const f = await terminalFixture();
  try {
    const collector = new TerminalFactCollection(f.storage, f.community.events, f.projector, f.community.projectionOperations);
    const closed = terminalSnapshot('closed').terminalFacts;
    await collector.collect(subject, [], closed);
    const before = (await f.community.objects.get(subject)).terminalFacts;
    const merged = { ...closed, state: 'merged', closedAt: new Date(time + 20000).toISOString(),
      mergedAt: new Date(time + 20000).toISOString(), mergeCommitSha: 'c'.repeat(40),
      reviews: [], ci: null, source: 'github-webhook', observedAt: time + 20000 };
    await collector.collect(subject, [], merged);
    let after = (await f.community.objects.get(subject)).terminalFacts;
    assert.equal(before.ci.status, 'pass'); assert.equal(before.reviews.length, 1);
    assert.equal(after.state, 'merged'); assert.equal(after.ci, null); assert.equal(after.reviews.length, 1); assert.equal(after.ciHistory?.[0]?.status, 'pass');
    await f.projector.rebuild(subject);
    after = (await f.community.objects.get(subject)).terminalFacts;
    assert.equal(after.ci, null); assert.equal(after.reviews.length, 1); assert.equal(after.ciHistory?.[0]?.status, 'pass');
  } finally { await f.community.stop(); }
});
