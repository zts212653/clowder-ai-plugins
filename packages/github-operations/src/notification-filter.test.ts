import assert from 'node:assert/strict';
import test from 'node:test';
import { readNotificationFilter } from './notification-filter.js';
import type { GitHubSnapshot } from './tracking-runtime.js';
import { fixture, seedReceipt } from '../test/typed-wait-fixture.js';

for (const mode of ['allow', 'block'] as const) {
  for (const surface of ['conversation', 'inline'] as const) {
  test(`${mode} policy resolves ${surface} evidence separately from an unrelated review with the same ID`, async () => {
    const snapshot: GitHubSnapshot = { state: 'open',
      comments: [{ id: 7, author: 'comment-author', body: 'clean review', commentType: surface }],
      reviews: [{ id: 7, author: 'review-author', state: 'COMMENTED' }] };
    const allowed = await readNotificationFilter({ config: { get: async key =>
      key === (mode === 'allow' ? 'notificationAllowlist' : 'notificationBlocklist') ? 'comment-author' : '' } }, snapshot, 'fallback-reviewer');
    assert.equal(allowed({ kind: 'pr_review_result_available', delta: 'clean', sourceRef: `${surface}:7` }), mode === 'allow');
    assert.equal(allowed({ kind: 'pr_review_result_available', delta: 'result', sourceRef: 'review:7' }), mode === 'block');
  });
  }
}

test('inline and conversation comments with the same numeric ID retain their own actor policy', async () => {
  const snapshot: GitHubSnapshot = { state: 'open', reviews: [], comments: [
    { id: 7, author: 'blocked-bot', body: 'conversation', commentType: 'conversation' },
    { id: 7, author: 'allowed-reviewer', body: 'inline', commentType: 'inline' },
  ] };
  const allowed = await readNotificationFilter({ config: { get: async key => key === 'notificationAllowlist' ? 'allowed-reviewer' : '' } }, snapshot);
  assert.equal(allowed({ kind: 'pr_inline_comment_added', delta: 'inline', sourceRef: 'github:pr-comment:7' }), true);
  assert.equal(allowed({ kind: 'pr_conversation_comment_added', delta: 'conversation', sourceRef: 'github:pr-comment:7' }), false);
});

for (const surface of ['conversation', 'inline'] as const) {
  test(`review-result self proof requires an unambiguous ${surface} source`, async () => {
    const f = fixture(), runtime = f.runtime();
    try {
      const task = await runtime.registerPr({ registrationId: 'proof', repoFullName: 'owner/repo', prNumber: 1 }, f.caller);
      const anchor = surface === 'conversation' ? 'issuecomment-77' : 'r77';
      await seedReceipt(f, {}, `https://github.com/owner/repo/pull/1/files#${anchor}`);
      const allowed = await readNotificationFilter(f.context, { state: 'open', headSha: 'a'.repeat(40), reviews: [], comments: [] },
        undefined, { task, storage: f.storage });
      const match = { kind: 'pr_review_result_available' as const, delta: 'result' };
      assert.equal(allowed({ ...match, sourceRef: `${surface}:77` }), false);
      assert.equal(allowed({ ...match, sourceRef: `${surface === 'inline' ? 'conversation' : 'inline'}:77` }), true);
      assert.equal(allowed({ ...match, sourceRef: 'github:pr-comment:77' }), true, 'a result kind cannot disambiguate this shared ID');
    } finally { await runtime.stop(); }
  });
}

test('self-proof lookup is read-only and bounded; missing immutable history leaves the event visible', async () => {
  const f = fixture(), runtime = f.runtime();
  try {
    const task = await runtime.registerPr({ registrationId: 'proof', repoFullName: 'owner/repo', prNumber: 1 }, f.caller);
    await seedReceipt(f);
    const { SdkCommunityObjectStore } = await import('./business/domains/community/CommunityObjectStore.js');
    const objects = new SdkCommunityObjectStore(f.storage), projection = (await objects.get(task.subjectKey!))!;
    await objects.save({ ...projection, externalReview: { ...projection.externalReview!, reviewerCatId: 'new-assignee' } });
    const before = await f.storage.list();
    f.storage.list = async () => assert.fail('notification proof cannot list the journal');
    f.storage.scan = async () => assert.fail('notification proof cannot scan the journal');
    const get = f.storage.get, reads: string[] = [];
    let missing = false;
    f.storage.get = async key => { reads.push(key); return missing && key.startsWith('community.event.') ? undefined : get(key); };
    const snapshot: GitHubSnapshot = { state: 'open', headSha: 'a'.repeat(40), reviews: [], comments: [] };
    const match = { kind: 'pr_review_decision_changed' as const, delta: 'review', sourceRef: 'review:42' };
    const filter = () => readNotificationFilter(f.context, snapshot, undefined, { task, storage: f.storage });
    assert.equal((await filter())(match), false, 'the immutable delivery author survives reassignment');
    assert.equal(reads.length, 2, 'one projection and one exact immutable event read');
    missing = true;
    assert.equal((await filter())(match), true);
    for (const [key, entry] of Object.entries(before)) assert.deepEqual(await get(key), entry, 'proof reads preserve every existing row');
  } finally { await runtime.stop(); }
});
