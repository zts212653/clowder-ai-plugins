import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { terminalFixture, terminalSnapshot, subject, head, target, time, nativeHistory } from '../test/terminal-fixture.js';
import { GitHubRepoWebhookHandler } from './business/infrastructure/connectors/github-repo-event/GitHubRepoWebhookHandler.js';
import { runCommunityReconciliation } from './business/domains/community/reconciliation/CommunityReconcilerTaskSpec.js';
import { providerObservation } from './community-read-model.js';

test('verified webhook HEAD and review associations survive either arrival order without CI fabrication', async t => {
  for (const reviewFirst of [true, false]) {
    const f = await terminalFixture(); t.after(() => f.community.stop());
    let notices = 0;
    const handler = new GitHubRepoWebhookHandler({ webhookSecret: 'isolated-test-secret', repoAllowlist: [target.repoFullName] }, {
      eventLog: f.community.events, projector: f.projector,
      dedup: { claim: async () => true, confirm: async () => {}, rollback: async () => {} },
      deliver: async () => { notices++; return { messageId: 'ordinary-lifecycle-notice' }; },
    });
    const pr = { number: 12, title: 'Terminal', html_url: 'https://github.com/example/project/pull/12', user: { login: 'contributor' },
      state: 'closed', merged: true, head: { sha: head }, closed_at: new Date(time).toISOString(), merged_at: new Date(time).toISOString(), merge_commit_sha: 'c'.repeat(40),
      author_association: reviewFirst ? 'NONE' : 'OWNER' };
    const closed = { action: 'closed', repository: { full_name: target.repoFullName }, pull_request: pr };
    const reviewed = { action: 'submitted', repository: { full_name: target.repoFullName }, pull_request: pr,
      review: { id: 10, user: { login: 'reviewer' }, state: 'APPROVED', commit_id: head, submitted_at: new Date(time - 1000).toISOString() } };
    for (const body of reviewFirst ? [reviewed, closed] : [closed, reviewed]) {
      const raw = Buffer.from(JSON.stringify(body));
      const result = await handler.handleWebhook(body, { 'x-github-event': body.action === 'closed' ? 'pull_request' : 'pull_request_review',
        'x-github-delivery': 'fixture-' + body.action, 'x-hub-signature-256': 'sha256=' + createHmac('sha256', 'isolated-test-secret').update(raw).digest('hex') }, raw);
      assert.equal(result.kind, 'processed');
    }
    const read = providerObservation(subject, await f.community.events.read(subject), await f.community.objects.get(subject));
    assert.equal(read.headSha, head); assert.equal(read.ci, 'unknown'); assert.equal(read.finalReviews?.[0]?.commitId, head);
    await f.projector.rebuild(subject);
    assert.deepEqual(providerObservation(subject, await f.community.events.read(subject), await f.community.objects.get(subject)), read);
    assert.equal(f.sends(), 0);
    assert.equal(notices, reviewFirst ? 1 : 0, 'owner terminal facts are preserved without new intake notification');
  }
});

test('existing repository reconciler enriches terminal historical cases after its quiet baseline', async t => {
  const f = await terminalFixture(); t.after(() => f.community.stop());
  await f.community.collectTracking(target, { state: 'closed', comments: [], reviews: [] });
  const native = (await f.community.objects.get(subject))!.externalReview;
  let baseline = false;
  const options = { objectStore: f.community.objects, eventLog: f.community.events, projector: f.projector, findingStore: f.community.findings,
    fetchIssueState: async () => null,
    fetchPrState: async () => ({ state: 'closed' as const, closedAt: new Date(time).toISOString(), mergedAt: null, terminalFacts: terminalSnapshot('closed').terminalFacts }),
    isBaselineEstablished: async () => baseline, markBaselineEstablished: async () => { baseline = true; }, log: { info() {}, warn() {} } };
  const initial = await f.community.events.read(subject);
  await runCommunityReconciliation(options, new AbortController().signal);
  assert.deepEqual(await f.community.events.read(subject), initial);
  await runCommunityReconciliation(options, new AbortController().signal);
  const read = providerObservation(subject, await f.community.events.read(subject), await f.community.objects.get(subject));
  assert.equal(read.headSha, head); assert.equal(read.ci, 'pass');
  assert.deepEqual(nativeHistory((await f.community.objects.get(subject))?.externalReview), nativeHistory(native));
  await f.projector.rebuild(subject);
  assert.deepEqual(providerObservation(subject, await f.community.events.read(subject), await f.community.objects.get(subject)), read);
});
