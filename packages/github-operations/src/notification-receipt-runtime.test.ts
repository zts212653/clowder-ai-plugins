import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, seedReceipt } from '../test/typed-wait-fixture.js';

const input = { registrationId: 'original-registration', repoFullName: 'owner/repo', prNumber: 1 };
const reviewedHead = 'a'.repeat(40);

for (const subscriptionGeneration of [1, 2, 4, 7]) {
test(`exact self receipt survives wait generation ${subscriptionGeneration}, baseline consumption and restart`, async () => {
  const f = fixture();
  let runtime = f.runtime();
  try {
    const task = await runtime.registerPr(input, f.caller);
    for (let generation = 1; generation < subscriptionGeneration; generation++) {
      await runtime.registerPr({ ...input, registrationId: `resume-${generation}` }, f.caller);
    }
    assert.equal((await runtime.store.get(task.id))!.automationState!.await!.generation, subscriptionGeneration);
    const priorOutcome = (await runtime.store.get(task.id))!.automationState!.waitOutcome;
    await seedReceipt(f, { headGeneration: 2, lastReviewedHeadGeneration: 2, lastDeliveredHeadGeneration: 2 });
    const { SdkCommunityObjectStore } = await import('./business/domains/community/CommunityObjectStore.js');
    const objects = new SdkCommunityObjectStore(f.storage), receipt = await objects.get(task.subjectKey!);
    f.update({ reviews: [{ id: 42, author: 'shared-account', state: 'APPROVED', commitId: reviewedHead }] });
    f.advance(); await runtime.poll('pr');
    assert.equal(f.sent.length, 0, 'the exact review just persisted by this owner must not wake that owner again');
    const current = (await runtime.store.get(task.id))!;
    assert.deepEqual(current.automationState!.waitOutcome, priorOutcome, 'silent evidence creates no notification outcome');
    const active = current.automationState!.await!;
    assert.equal(active.generation, subscriptionGeneration);
    assert.deepEqual(active.ownerFence, { kind: 'containing_task', generation: active.generation });
    assert.equal('headSha' in active.baseline && active.baseline.review?.decisionCursor, 42);
    assert.equal(f.observed.at(-1)!.reviews[0]!.id, 42, 'observation still receives suppressed evidence');
    assert.equal(f.collected.at(-1)!.reviews[0]!.id, 42, 'collection still receives suppressed evidence');
    assert.deepEqual(await objects.get(task.subjectKey!), receipt, 'filtering never rewrites the receipt');
    await runtime.stop(); runtime = f.runtime();
    f.advance(); await runtime.poll('pr');
    assert.equal(f.sent.length, 0, 'restart does not replay consumed self evidence');

    f.update({ reviews: [
      { id: 42, author: 'shared-account', state: 'APPROVED', commitId: reviewedHead },
      { id: 43, author: 'shared-account', state: 'CHANGES_REQUESTED', commitId: reviewedHead },
    ] });
    f.advance(); await runtime.poll('pr');
    assert.equal(f.sent.length, 1, 'a different review id with no matching persisted self-receipt is actionable');
    await runtime.stop(); runtime = f.runtime();
    f.advance(); await runtime.poll('pr');
    assert.equal(f.sent.length, 1, 'new findings remain once-only after restart');
  } finally { await runtime.stop(); }
});
}

test('a returning HEAD cannot reuse delivery from its earlier provider period', async () => {
  const f = fixture(), runtime = f.runtime();
  try {
    const task = await runtime.registerPr(input, f.caller);
    await runtime.registerPr({ ...input, registrationId: 'resume-1' }, f.caller);
    await seedReceipt(f);
    const { SdkCommunityObjectStore } = await import('./business/domains/community/CommunityObjectStore.js');
    const { applyProviderPeriodObservation } = await import('./business/domains/community/external-review/external-review-aggregate.js');
    const store = new SdkCommunityObjectStore(f.storage), projection = (await store.get(task.subjectKey!))!;
    const changed = applyProviderPeriodObservation(projection.externalReview!, 'b'.repeat(40), 2000);
    await store.save({ ...projection, externalReview: changed });
    f.update({ headSha: 'b'.repeat(40) });
    f.advance(); await runtime.poll('pr');
    const returned = applyProviderPeriodObservation(changed, reviewedHead, 3000);
    assert.equal(returned!.headGeneration, 3);
    assert.equal(returned!.lastDeliveredHeadGeneration, 1);
    assert.equal(returned!.delivery!.kind, 'delivered');
    await store.save({ ...projection, externalReview: returned });
    f.update({ headSha: reviewedHead, reviews: [{ id: 42, author: 'shared-account', state: 'APPROVED', commitId: reviewedHead }] });
    const before = f.sent.length;
    assert.equal((await runtime.store.get(task.id))!.automationState!.await!.generation, 3);
    f.advance(); await runtime.poll('pr');
    assert.equal(f.sent.length, before + 1, 'the identical SHA has a new HEAD generation requiring fresh delivery proof');
    assert.ok((await runtime.store.get(task.id))!.automationState!.waitOutcome!.matched!.some(
      match => match.kind === 'pr_review_decision_changed' && match.sourceRef === 'review:42'),
      'the returning review remains in the actionable result alongside the HEAD change');
  } finally { await runtime.stop(); }
});

test('silent self evidence preserves the original deadline and local expiry delivery', async () => {
  const f = fixture(), runtime = f.runtime();
  try {
    const task = await runtime.registerPr({ ...input, expiresAt: 120_000 }, f.caller);
    await seedReceipt(f);
    f.update({ reviews: [{ id: 42, author: 'shared-account', state: 'APPROVED', commitId: reviewedHead }] });
    f.advance(); await runtime.poll('pr');
    assert.equal(f.sent.length, 0);
    assert.equal((await runtime.store.get(task.id))!.automationState!.await!.expiresAt, 120_000);
    const reads = f.reads();
    f.advance(); await runtime.poll('pr');
    assert.equal(f.reads(), reads, 'an expired wait needs no provider read');
    assert.equal((await runtime.store.get(task.id))!.automationState!.waitOutcome!.reason, 'expired');
    assert.equal(f.sent.length, 1);
  } finally { await runtime.stop(); }
});

test('missing self receipt keeps shared-account review evidence deliverable', async () => {
  const f = fixture(), runtime = f.runtime();
  try {
    await runtime.registerPr(input, f.caller);
    f.update({ reviews: [{ id: 42, author: 'shared-account', state: 'APPROVED', commitId: reviewedHead }] });
    f.advance(); await runtime.poll('pr');
    assert.equal(f.sent.length, 1);
  } finally { await runtime.stop(); }
});

test('a reviewed PR defers only a no-action pending HEAD update, then wakes for its current-head CI result', async () => {
  const f = fixture(), runtime = f.runtime(), oldHead = 'a'.repeat(40), newHead = 'b'.repeat(40);
  try {
    f.update({ reviews: [{ id: 1, author: 'previous-reviewer', state: 'APPROVED', commitId: oldHead }] });
    const task = await runtime.registerPr(input, f.caller);
    f.update({ headSha: newHead, ci: 'pending', ciRollup: 'present' });
    f.advance(); await runtime.poll('pr');
    assert.equal(f.sent.length, 0, 'a pure rebase/update while CI is pending needs no immediate duplicate wake');
    const followed = (await runtime.store.get(task.id))!.automationState!.await!;
    assert.equal(followed.generation, 2, 'the deferred notification still renews the original wait instead of creating a parallel one');
    assert.equal('headSha' in followed.baseline && followed.baseline.headSha, newHead, 'the silent update still advances the durable head baseline');

    f.update({ ci: 'pass' });
    f.advance(); await runtime.poll('pr');
    assert.equal(f.sent.length, 1, 'the current-head terminal CI result still arrives');
    assert.equal((await runtime.store.get(task.id))!.automationState!.waitOutcome!.reason, 'matched');
  } finally { await runtime.stop(); }
});

for (const scenario of [
  {
    name: 'changes-requested',
    patch: {
      reviews: [
        { id: 1, author: 'previous-reviewer', state: 'APPROVED', commitId: 'a'.repeat(40) },
        { id: 2, author: 'zts212653', state: 'CHANGES_REQUESTED', commitId: 'b'.repeat(40) },
      ],
    },
  },
  {
    name: 'author-help',
    patch: {
      comments: [{ id: 9, author: 'contributor', body: 'please re-review after the rebase', commentType: 'conversation' as const }],
    },
  },
  {
    name: 'conflict',
    patch: { mergeState: 'CONFLICTING' },
  },
  {
    name: 'no-ci',
    patch: { ci: 'external_infrastructure' as const },
  },
] as const) {
  test(`CI-pending coalescing never hides ${scenario.name}`, async () => {
    const f = fixture(), runtime = f.runtime(), oldHead = 'a'.repeat(40), newHead = 'b'.repeat(40);
    try {
      f.update({ reviews: [{ id: 1, author: 'previous-reviewer', state: 'APPROVED', commitId: oldHead }] });
      await runtime.registerPr(input, f.caller);
      f.update({ headSha: newHead, ci: scenario.name === 'no-ci' ? 'external_infrastructure' : 'pending', ciRollup: 'present', ...scenario.patch });
      f.advance(); await runtime.poll('pr');
      assert.equal(f.sent.length, 1, `${scenario.name} must remain immediately visible`);
    } finally { await runtime.stop(); }
  });
}

test('CI failure and subject terminal are never deferred behind a green result', async () => {
  for (const terminal of [{ ci: 'fail' as const }, { state: 'merged' as const }]) {
    const f = fixture(), runtime = f.runtime(), oldHead = 'a'.repeat(40);
    try {
      f.update({ reviews: [{ id: 1, author: 'previous-reviewer', state: 'APPROVED', commitId: oldHead }] });
      await runtime.registerPr(input, f.caller);
      f.update({ headSha: 'b'.repeat(40), ci: 'pending', ciRollup: 'present', ...terminal });
      f.advance(); await runtime.poll('pr');
      assert.equal(f.sent.length, 1, JSON.stringify(terminal));
    } finally { await runtime.stop(); }
  }
});


test('empty CI rollup never defers a reviewed HEAD update into permanent silence', async () => {
  const f = fixture(), runtime = f.runtime();
  try {
    f.update({ reviews: [{ id: 1, author: 'previous-reviewer', state: 'APPROVED', commitId: reviewedHead }] });
    await runtime.registerPr(input, f.caller);
    f.update({ headSha: 'b'.repeat(40), ci: 'pending', ciRollup: 'empty' });
    for (let i = 0; i < 6; i++) { f.advance(); await runtime.poll('pr'); }
    assert.equal(f.sent.length, 1, 'an empty check rollup cannot be treated as a future CI terminal');
  } finally { await runtime.stop(); }
});

test('pending coalescing requires an armed CI terminal predicate', async () => {
  const f = fixture(), runtime = f.runtime();
  try {
    f.update({ reviews: [{ id: 1, author: 'previous-reviewer', state: 'APPROVED', commitId: reviewedHead }] });
    await runtime.registerPr({ ...input, when: [{ kind: 'pr_head_changed' }, { kind: 'pr_review_decision_changed' }] }, f.caller);
    f.update({ headSha: 'b'.repeat(40), ci: 'pending', ciRollup: 'present' });
    f.advance(); await runtime.poll('pr');
    f.update({ ci: 'pass' });
    for (let i = 0; i < 3; i++) { f.advance(); await runtime.poll('pr'); }
    assert.equal(f.sent.length, 1, 'an unarmed CI terminal cannot be the reason to suppress the awaited HEAD update');
  } finally { await runtime.stop(); }
});

test('dismissing the owner review is a new fact, not an exact self receipt', async () => {
  const f = fixture(), runtime = f.runtime();
  try {
    await runtime.registerPr(input, f.caller);
    await seedReceipt(f);
    f.update({ reviews: [{ id: 42, author: 'zts212653', state: 'APPROVED', commitId: reviewedHead }] });
    f.advance(); await runtime.poll('pr');
    assert.equal(f.sent.length, 0);
    f.update({ reviews: [{ id: 42, author: 'zts212653', state: 'DISMISSED', commitId: reviewedHead }] });
    f.advance(); await runtime.poll('pr');
    assert.equal(f.sent.length, 1, 'a revoked approval must remain visible even when its original delivery was private');
  } finally { await runtime.stop(); }
});

test('a same-tick other cat changes-requested review is not swallowed with the exact self receipt', async () => {
  const f = fixture(), runtime = f.runtime();
  try {
    await runtime.registerPr(input, f.caller);
    await seedReceipt(f);
    f.update({ reviews: [
      { id: 42, author: 'zts212653', state: 'APPROVED', commitId: reviewedHead },
      { id: 43, author: 'zts212653', state: 'CHANGES_REQUESTED', commitId: reviewedHead },
    ] });
    f.advance(); await runtime.poll('pr');
    assert.equal(f.sent.length, 1);
  } finally { await runtime.stop(); }
});

for (const mismatch of [
  { reviewerCatId: 'some-other-cat' },
  { reviewerThreadId: 'other-thread' },
  { headGeneration: 9 },
  { headGeneration: 0 },
  { lastDeliveredHeadGeneration: 9 },
  { lastDeliveredHeadGeneration: null },
  { lastDeliveredHeadGeneration: undefined },
  { lastDeliveredHeadSha: 'c'.repeat(40) },
  { lastDeliveredHeadSha: null },
  { currentHeadSha: 'c'.repeat(40) },
  { delivery: null },
  { deliveredVerdictFingerprint: null },
  { delivery: { kind: 'delivered', headSha: reviewedHead, githubUrl: 'https://github.com/owner/repo/pull/1', deliveredAt: 1000 } },
  { delivery: { kind: 'delivered', headSha: reviewedHead, githubUrl: 'https://github.com/owner/repo/pull/1#pullrequestreview-43', deliveredAt: 1000 } },
  { delivery: { kind: 'delivered', headSha: 'c'.repeat(40), githubUrl: 'https://github.com/owner/repo/pull/1#pullrequestreview-42', deliveredAt: 1000 } },
  { delivery: { kind: 'pending_delivery', headSha: reviewedHead, ownerCatId: 'codex61-sol', reason: 'not yet', createdAt: 1000 } },
] as const) {
  test(`self-receipt proof mismatch fails open: ${Object.keys(mismatch).join(',')}`, async () => {
    const f = fixture(), runtime = f.runtime();
    try {
      await runtime.registerPr(input, f.caller);
      await seedReceipt(f, mismatch);
      f.update({ reviews: [{ id: 42, author: 'zts212653', state: 'APPROVED', commitId: reviewedHead }] });
      f.advance(); await runtime.poll('pr');
      assert.equal(f.sent.length, 1, 'every owner/thread/head/generation/delivery coordinate is required before suppressing');
    } finally { await runtime.stop(); }
  });
}

for (const surface of ['conversation', 'inline'] as const) {
test(`a persisted ${surface} self-comment stays private after renewals while another comment still wakes`, async () => {
  const f = fixture(), runtime = f.runtime();
  try {
    await runtime.registerPr(input, f.caller);
    for (const registrationId of ['resume-1', 'resume-2']) await runtime.registerPr({ ...input, registrationId }, f.caller);
    const anchor = surface === 'conversation' ? 'issuecomment-77' : 'discussion_r77';
    await seedReceipt(f, { headGeneration: 2, lastReviewedHeadGeneration: 2, lastDeliveredHeadGeneration: 2 },
      `https://github.com/owner/repo/pull/1#${anchor}`);
    f.update({ comments: [{ id: 77, author: 'shared-account', body: 'ok', commentType: surface }] });
    f.advance(); await runtime.poll('pr');
    assert.equal(f.sent.length, 0);
    f.update({ comments: [
      { id: 77, author: 'shared-account', body: 'ok', commentType: surface },
      { id: 78, author: 'contributor', body: 'help please', commentType: surface },
    ] });
    f.advance(); await runtime.poll('pr');
    assert.equal(f.sent.length, 1);
  } finally { await runtime.stop(); }
});
}

test('unreadable self proof fails open without losing provider collection', async () => {
  const f = fixture(), runtime = f.runtime();
  try {
    await runtime.registerPr(input, f.caller);
    const get = f.storage.get;
    f.storage.get = async key => {
      if (key.startsWith('community.object.')) throw new Error('receipt read unavailable');
      return get(key);
    };
    f.update({ reviews: [{ id: 42, author: 'shared-account', state: 'APPROVED', commitId: reviewedHead }] });
    f.advance(); await runtime.poll('pr');
    assert.equal(f.sent.length, 1);
    assert.equal(f.collected.at(-1)!.reviews[0]!.id, 42);
  } finally { await runtime.stop(); }
});


test('an unreviewed HEAD update is never coalesced even with a real pending rollup', async () => {
  const f = fixture(), runtime = f.runtime();
  try {
    await runtime.registerPr(input, f.caller);
    f.update({ headSha: 'b'.repeat(40), ci: 'pending', ciRollup: 'present' });
    f.advance(); await runtime.poll('pr');
    assert.equal(f.sent.length, 1, 'without a formal prior review there is no redundant review wake to merge');
  } finally { await runtime.stop(); }
});
