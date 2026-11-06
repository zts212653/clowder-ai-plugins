import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';
const pkgRoot = new URL('..', import.meta.url).pathname;
const local = (p) => import(pathToFileURL(join(pkgRoot, p)).href);
const { terminalFixture, terminalSnapshot, subject, target, head, time } = await local('test/terminal-fixture.ts');
const { TerminalFactCollection } = await local('src/terminal-fact-collection.ts');
const { CommunityReconciler } = await local('src/business/domains/community/reconciliation/CommunityReconciler.ts');
const { GitHubRepoWebhookHandler } = await local('src/business/infrastructure/connectors/github-repo-event/GitHubRepoWebhookHandler.ts');
const { providerStateEvidence } = await local('src/business/domains/community/provider-open-observation.ts');
const { shouldObserveTerminalFacts, providerProjectionFields } = await local('src/business/domains/community/terminal-provider-facts.ts');
const { TerminalReconciliationRuntime } = await local('src/terminal-reconciliation.ts');
const { SdkCommunityRepoConfigStore } = await local('src/business/domains/community/CommunityRepoConfigStore.ts');
test('stale signed close after merge has no journal or notification effects', async t => {
  const f = await terminalFixture(); t.after(() => f.community.stop());
  const closedSnap = terminalSnapshot('closed');
  await f.community.collectTracking(target, closedSnap);
  await f.community.collectTracking(target, {
    state: 'open',
    headSha: head,
    ci: 'pass',
    reviews: [],
    comments: [],
    commentsComplete: true,
    observedAt: time + 10000,
    providerUpdatedAt: new Date(time + 10000).toISOString(),
  });
  const mergedSnap = terminalSnapshot('merged');
  mergedSnap.observedAt = time + 20000;
  mergedSnap.terminalFacts = {
    ...mergedSnap.terminalFacts,
    closedAt: new Date(time + 20000).toISOString(),
    mergedAt: new Date(time + 20000).toISOString(),
    observedAt: time + 20000,
  };
  await f.community.collectTracking(target, mergedSnap);
  let deliveries = 0;
  const collector = new TerminalFactCollection(
    f.storage,
    f.community.events,
    f.projector,
    f.community.projectionOperations
  );
  const handler = new GitHubRepoWebhookHandler(
    { webhookSecret: 'isolated-test-secret', repoAllowlist: [target.repoFullName] },
    {
      eventLog: f.community.events,
      projector: f.projector,
      mayObserveTerminalFacts: (key) => collector.allowed(key),
      collectTerminalFacts: async (facts) => !(await collector.collect(subject, [], facts)).denied,
      dedup: { claim: async () => true, confirm: async () => {}, rollback: async () => {} },
      deliver: async () => {
        deliveries++;
        return { messageId: 'false-close-after-merge' };
      },
    }
  );
  const body = {
    action: 'closed',
    repository: { full_name: target.repoFullName },
    pull_request: {
      number: 12,
      title: 'Delayed close from before reopen+merge',
      html_url: 'https://github.com/example/project/pull/12',
      user: { login: 'contributor' },
      state: 'closed',
      merged: false,
      head: { sha: head },
      closed_at: closedSnap.terminalFacts.closedAt,
      body: 'Old close body',
    },
  };
  const raw = Buffer.from(JSON.stringify(body));
  const before = await f.community.events.read(subject);
  const res = await handler.handleWebhook(
    body,
    {
      'x-github-event': 'pull_request',
      'x-github-delivery': 'r5-stale-close-after-merge',
      'x-hub-signature-256': 'sha256=' + createHmac('sha256', 'isolated-test-secret').update(raw).digest('hex'),
    },
    raw
  );
  const after = await f.community.events.read(subject);
  assert.equal(res.kind, 'processed');
  assert.equal(deliveries, 0);
  assert.deepEqual(after, before);
});
test('native repair rejects an older close after merge', async t => {
  const f = await terminalFixture(); t.after(() => f.community.stop());
  await new SdkCommunityRepoConfigStore(f.storage).upsert({
    repo: target.repoFullName,
    guardCatId: 'cat',
    guardThreadId: 'thread',
  });
  const mergedSnap = terminalSnapshot('merged');
  mergedSnap.observedAt = time + 20000;
  mergedSnap.terminalFacts = {
    ...mergedSnap.terminalFacts,
    closedAt: new Date(time + 20000).toISOString(),
    mergedAt: new Date(time + 20000).toISOString(),
    observedAt: time + 20000,
  };
  await f.community.collectTracking(target, mergedSnap);
  const staleClosedSnap = terminalSnapshot('closed');
  staleClosedSnap.observedAt = time + 1000;
  staleClosedSnap.terminalFacts = {
    ...staleClosedSnap.terminalFacts,
    closedAt: new Date(time).toISOString(),
    observedAt: time + 1000,
  };
  const reconciler = new TerminalReconciliationRuntime({
    storage: f.storage,
    provider: { read: async () => staleClosedSnap },
    projectionOperations: f.community.projectionOperations,
  });
  await assert.rejects(reconciler.reconcile(
    { subjectKey: subject },
    { catId: 'cat', threadId: 'thread', userId: 'owner', invocationId: 'inv-1', assertCurrent() {} }
  ), /older|stale|Provider/);
  await reconciler.stop();
});
test('stale summary merge cannot alter a reopened provider period', async t => {
  const f = await terminalFixture(); t.after(() => f.community.stop());
  await f.community.collectTracking(target, terminalSnapshot('closed'));
  await f.community.collectTracking(target, {
    state: 'open',
    headSha: head,
    ci: 'pass',
    reviews: [],
    comments: [],
    commentsComplete: true,
    observedAt: time + 10000,
    providerUpdatedAt: new Date(time + 10000).toISOString(),
  });
  await f.community.collectTracking(target, {
    state: 'merged',
    headSha: head,
    ci: 'pass',
    reviews: [],
    comments: [],
    commentsComplete: true,
    observedAt: time + 1000,
  });
  const proj = await f.community.objects.get(subject);
  const boardFields = providerProjectionFields(proj);
  assert.equal(proj.state, 'closed');
  assert.equal(Boolean(proj.providerOpen), true);
  assert.equal(boardFields.state, 'open');
});
test('a new summary close has a period identity and clears the open marker', async t => {
  const f = await terminalFixture(); t.after(() => f.community.stop());
  await f.community.collectTracking(target, terminalSnapshot('closed'));
  await f.community.collectTracking(target, {
    state: 'open',
    headSha: head,
    ci: 'pass',
    reviews: [],
    comments: [],
    commentsComplete: true,
    observedAt: time + 10000,
    providerUpdatedAt: new Date(time + 10000).toISOString(),
  });
  await f.community.collectTracking(target, {
    state: 'closed',
    headSha: head,
    ci: 'pass',
    reviews: [],
    comments: [],
    commentsComplete: true,
    observedAt: time + 20000,
  });
  const historyAfterCollect = await f.community.events.read(subject);
  assert.equal(
    historyAfterCollect.at(-1)?.kind,
    'pr.closed',
  );
  const freshCloseEvent = {
    sourceEventId: `reconciler:${subject}:pr.closed:${time + 20000}`,
    subjectKey: subject,
    kind: 'pr.closed',
    payload: { closedAt: new Date(time + 20000).toISOString() },
    classification: 'actionable',
    at: time + 20000,
  };
  await f.community.events.append(freshCloseEvent);
  await f.projector.apply(freshCloseEvent);
  const proj = await f.community.objects.get(subject);
  const boardFields = providerProjectionFields(proj);
  assert.equal(proj.state, 'closed');
  assert.equal(Boolean(proj.providerOpen), false);
  assert.equal(boardFields.state, 'closed');
});
test('repository reconciliation records a reopened PR merge and cascades its linked issue', async t => {
  const f = await terminalFixture(); t.after(() => f.community.stop());
  const issueKey = 'issue:example/project#99';
  const issueOpened = {
    sourceEventId: 'seed-issue-99',
    subjectKey: issueKey,
    kind: 'issue.opened',
    payload: { title: 'Bug 99', author: 'user' },
    classification: 'actionable',
    at: 1,
  };
  await f.community.events.append(issueOpened);
  await f.projector.apply(issueOpened);
  const prOpenedWithLink = {
    sourceEventId: 'seed-pr-link-99',
    subjectKey: subject,
    kind: 'pr.opened',
    payload: { title: 'Fixes #99', author: 'user', body: 'Fixes #99', linkedIssues: [99] },
    classification: 'actionable',
    at: 2,
  };
  await f.community.events.append(prOpenedWithLink);
  await f.projector.apply(prOpenedWithLink);
  await f.community.collectTracking(target, terminalSnapshot('closed'));
  await f.community.collectTracking(target, {
    state: 'open',
    headSha: head,
    ci: 'pass',
    reviews: [],
    comments: [],
    commentsComplete: true,
    observedAt: time + 10000,
    providerUpdatedAt: new Date(time + 10000).toISOString(),
  });
  const mergedSnap = terminalSnapshot('merged');
  mergedSnap.observedAt = time + 20000;
  mergedSnap.terminalFacts = {
    ...mergedSnap.terminalFacts,
    closedAt: new Date(time + 20000).toISOString(),
    mergedAt: new Date(time + 20000).toISOString(),
    observedAt: time + 20000,
  };
  const { runCommunityReconciliation } = await local(
    'src/business/domains/community/reconciliation/CommunityReconcilerTaskSpec.ts'
  );
  const collector = new TerminalFactCollection(
    f.storage,
    f.community.events,
    f.projector,
    f.community.projectionOperations
  );
  await runCommunityReconciliation(
    {
      terminalCollection: collector,
      objectStore: f.community.objects,
      eventLog: f.community.events,
      projector: f.projector,
      findingStore: f.community.findings,
      fetchIssueState: async () => ({ state: 'open', closedAt: null, mergedAt: null }),
      fetchPrState: async () => ({
        state: 'closed',
        closedAt: new Date(time + 20000).toISOString(),
        mergedAt: new Date(time + 20000).toISOString(),
        terminalFacts: mergedSnap.terminalFacts,
        headSha: head,
        observedAt: time + 20000,
        providerUpdatedAt: new Date(time + 20000).toISOString(),
      }),
      log: { info() {}, warn() {} },
      isBaselineEstablished: async () => true,
      markBaselineEstablished: async () => {},
    },
    new AbortController().signal
  );
  const prProj = await f.community.objects.get(subject);
  const issueProj = await f.community.objects.get(issueKey);
  assert.equal(prProj.state, 'fixed');
  assert.ok(prProj.linkedIssues.includes(99));
  assert.equal(prProj.terminalFacts?.state, 'merged');
  assert.equal(issueProj.state, 'fixed');
});
test('rejected old opens cannot become the canonical baseline for later opens', async t => {
  const f = await terminalFixture(); t.after(() => f.community.stop());
  const closedSnap = terminalSnapshot('closed');
  closedSnap.observedAt = time + 5000;
  closedSnap.terminalFacts = {
    ...closedSnap.terminalFacts,
    closedAt: new Date(time + 5000).toISOString(),
    observedAt: time + 5000,
  };
  await f.community.collectTracking(target, closedSnap);
  const staleOpen1 = {
    sourceEventId: 'stale-open-1',
    subjectKey: subject,
    kind: 'pr.open_observed',
    payload: {
      headSha: head,
      observedAt: time + 1000,
      providerUpdatedAt: new Date(time + 1000).toISOString(),
    },
    classification: 'informational',
    at: time + 1000,
  };
  await f.community.events.append(staleOpen1);
  await f.projector.apply(staleOpen1);
  const proj1 = await f.community.objects.get(subject);
  assert.equal(proj1.providerOpen, undefined);
  const history1 = await f.community.events.read(subject);
  assert.equal(
    providerStateEvidence(history1)?.state,
    'closed',
  );
  assert.equal(
    shouldObserveTerminalFacts(history1),
    true,
  );
  const staleOpen2 = {
    sourceEventId: 'stale-open-2',
    subjectKey: subject,
    kind: 'pr.open_observed',
    payload: {
      headSha: head,
      observedAt: time + 2000,
      providerUpdatedAt: new Date(time + 2000).toISOString(),
    },
    classification: 'informational',
    at: time + 2000,
  };
  await f.community.events.append(staleOpen2);
  await f.projector.apply(staleOpen2);
  const projAfter2 = await f.community.objects.get(subject);
  assert.equal(
    Boolean(projAfter2?.providerOpen),
    false,
  );
});
