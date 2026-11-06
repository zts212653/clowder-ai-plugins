import assert from 'node:assert/strict';
import test from 'node:test';
import { terminalFixture, terminalSnapshot, subject, head, target, oldHead, time } from '../test/terminal-fixture.js';
import { CommunityProjector } from './business/domains/community/community-projector.js';
import { terminalObservationEvent } from './business/domains/community/terminal-provider-facts.js';
import { providerObservation } from './community-read-model.js';
import type { CommunityEvent } from './business/model/index.js';
import type { GitHubSnapshot } from './tracking-runtime.js';

test('independent producers apply committed native verdict before later terminal facts despite reversed apply order', async t => {
  const f = await terminalFixture(); t.after(() => f.community.stop());
  const other = new CommunityProjector(f.community.events, f.community.objects, f.community.projectionOperations);
  for (const [i, [kind, payload]] of ([
    ['case.ci_observed', { headSha: oldHead, status: 'pass' }],
    ['case.review_ready', { headSha: oldHead }],
  ] as const).entries()) {
    const event: CommunityEvent = { sourceEventId: `r1-ready-${i}`, subjectKey: subject, kind, payload, classification: 'informational', at: time };
    await f.community.events.append(event); await f.projector.apply(event);
  }
  const verdict: CommunityEvent = { sourceEventId: 'r1-committed-native-verdict', subjectKey: subject,
    kind: 'case.review_verdict_recorded', classification: 'informational', at: time,
    payload: { headSha: oldHead, headGeneration: 1, principal: { catId: 'original-cat', threadId: 'original-thread' },
      delivery: { kind: 'delivered', headSha: oldHead, githubUrl: 'https://github.com/example/project/pull/12#pullrequestreview-1', deliveredAt: time } } };
  const terminal = terminalObservationEvent(terminalSnapshot().terminalFacts!);
  await f.community.events.append(verdict); await f.community.events.append(terminal);
  await other.apply(terminal);
  const live = await f.community.objects.get(subject);
  assert.equal(live?.externalReview?.lastDeliveredHeadSha, oldHead);
  assert.equal(live?.externalReview?.currentHeadSha, head);
  assert.equal(live?.externalReview?.lifecycle, 'terminal');
  assert.equal(await f.projector.applyChecked(verdict), true, 'a committed accepted verdict remains accepted when its delayed caller resumes');
  await other.rebuild(subject);
  assert.deepEqual(await f.community.objects.get(subject), live);
});

for (const crash of ['before-save', 'after-save'] as const) test(`journal cursor and native history recover a ${crash} interruption before closure`, async t => {
  const f = await terminalFixture(); t.after(() => f.community.stop());
  for (const [i, [kind, payload]] of ([
    ['case.ci_observed', { headSha: oldHead, status: 'pass' }],
    ['case.review_ready', { headSha: oldHead }],
  ] as const).entries()) {
    const event: CommunityEvent = { sourceEventId: `crash-ready-${i}`, subjectKey: subject, kind, payload, classification: 'informational', at: time };
    await f.community.events.append(event); await f.projector.apply(event);
  }
  const verdict: CommunityEvent = { sourceEventId: 'committed-before-interruption', subjectKey: subject, kind: 'case.review_verdict_recorded',
    classification: 'informational', at: time, payload: { headSha: oldHead, headGeneration: 1,
      delivery: { kind: 'delivered', headSha: oldHead, githubUrl: 'https://github.com/example/project/pull/12#pullrequestreview-1', deliveredAt: time } } };
  let failed = false;
  const interrupted = new CommunityProjector(f.community.events, {
    get: key => f.community.objects.get(key), delete: key => f.community.objects.delete(key), listSubjectKeys: () => f.community.objects.listSubjectKeys(),
    save: async projection => {
      const stop = !failed && projection.externalReview?.lifecycle === 'delivered';
      if (stop) failed = true;
      if (stop && crash === 'before-save') throw new Error('simulated interrupted projection');
      await f.community.objects.save(projection);
      if (stop) throw new Error('simulated interrupted projection');
    },
  }, f.community.projectionOperations);
  await f.community.events.append(verdict);
  await assert.rejects(interrupted.apply(verdict), /interrupted projection/);
  const terminal = terminalObservationEvent(terminalSnapshot().terminalFacts!);
  await f.community.events.append(terminal); await f.projector.apply(terminal);
  const live = await f.community.objects.get(subject);
  assert.equal(live?.externalReview?.lastDeliveredHeadSha, oldHead);
  assert.equal(live?.externalReview?.lifecycle, 'terminal');
  assert.equal(live?.journalCursor, (await f.community.events.read(subject)).length);
  await f.projector.rebuild(subject); assert.deepEqual(await f.community.objects.get(subject), live);
});

test('ordinary projection updates read only the new subject journal tail', async t => {
  const f = await terminalFixture(); t.after(() => f.community.stop());
  const cursors: number[] = [];
  const projector = new CommunityProjector({
    append: event => f.community.events.append(event), listSubjects: () => f.community.events.listSubjects(),
    read: (key, from = 0) => { cursors.push(from); return f.community.events.read(key, from); },
  }, f.community.objects, f.community.projectionOperations);
  for (let i = 0; i < 2; i++) {
    const event: CommunityEvent = { sourceEventId: `new-tail-${i}`, subjectKey: subject, kind: 'pr.review_submitted',
      classification: 'informational', payload: { commentId: i }, at: time + i };
    await f.community.events.append(event); await projector.apply(event);
  }
  assert.deepEqual(cursors, [3, 4]);
});

test('journal cursor adoption preserves cross-subject issue links and the merge cascade', async t => {
  for (const legacy of [false, true]) {
    const f = await terminalFixture(); t.after(() => f.community.stop());
    const issue = 'issue:example/project#99', pr = 'pr:example/project#13';
    const bootstrap: CommunityEvent = { sourceEventId: 'cross-link-bootstrap', subjectKey: issue,
      kind: 'case.bootstrap', classification: 'state-changing', at: 1,
      payload: { mappedState: 'in_progress', originalRecord: { linkedPrNumbers: [13] } } };
    await f.community.events.append(bootstrap); await f.projector.apply(bootstrap);
    const linked = (await f.community.objects.get(pr))!;
    assert.deepEqual(linked.linkedIssues, [99]);
    if (legacy) {
      const { journalCursor, ...oldProjection } = linked;
      await f.community.objects.save(oldProjection);
    }
    const merged: CommunityEvent = { sourceEventId: 'cross-link-merge', subjectKey: pr,
      kind: 'pr.merged', classification: 'state-changing', payload: {}, at: 2 };
    await f.community.events.append(merged); await f.projector.apply(merged);
    const live = await f.community.objects.get(pr);
    assert.deepEqual(live?.linkedIssues, [99]);
    assert.equal((await f.community.objects.get(issue))?.state, 'fixed');
    await f.projector.rebuild(pr); assert.deepEqual(await f.community.objects.get(pr), live);
  }
});

async function scheduledFixture() {
  const f = await terminalFixture(); let snapshot = terminalSnapshot(); const flags: boolean[] = [];
  const provider = { selfLogin: () => 'self', listOpen: async () => [], repoComments: async () => [],
    state: async (_repo: string, _kind: 'pr' | 'issue', _number: number, _signal: AbortSignal, includeFacts = false) => {
      flags.push(includeFacts);
      return { state: 'closed' as const, closedAt: snapshot.terminalFacts!.closedAt, mergedAt: snapshot.terminalFacts!.mergedAt,
        ...(includeFacts ? { terminalFacts: snapshot.terminalFacts } : {}) };
    } };
  // Supply the real runtime's provider seam while retaining all journal/projector/schedule behavior.
  Object.assign(f.community, { provider });
  await f.community.configs.upsert({ repo: target.repoFullName, guardThreadId: 'guard', guardCatId: 'guard' });
  return { ...f, flags, set: (value: GitHubSnapshot) => { snapshot = value; } };
}

test('loading the reconciler never enrolls already-terminal history missing final facts', async t => {
  const f = await scheduledFixture(); t.after(() => f.community.stop());
  await f.community.collectTracking(target, { state: 'merged', comments: [], reviews: [] });
  const before = (await f.community.objects.get(subject))!.externalReview;
  await f.community.run('community-reconciler'); await f.community.run('community-reconciler');
  assert.deepEqual(f.flags, [false, false]);
  assert.equal((await f.community.objects.get(subject))?.terminalFacts, undefined);
  assert.deepEqual((await f.community.objects.get(subject))?.externalReview, before);
  assert.equal((await f.community.events.read(subject)).filter(event => event.kind === 'pr.terminal_observed').length, 0);
});

test('an active case can capture its first terminal facts through the existing reconciler', async t => {
  const f = await scheduledFixture(); t.after(() => f.community.stop());
  await f.community.run('community-reconciler'); await f.community.run('community-reconciler');
  assert.deepEqual(f.flags, [true, true]);
  assert.equal((await f.community.objects.get(subject))?.terminalFacts?.headSha, head);
  assert.equal((await f.community.objects.get(subject))?.externalReview?.lifecycle, 'terminal');
});

test('enrolled terminal CI follows real scheduled pass to fail to explicit unknown; sparse webhook cannot erase it', async t => {
  const f = await scheduledFixture(); t.after(() => f.community.stop());
  const snapshot = terminalSnapshot(), original = snapshot.terminalFacts!;
  await f.community.collectTracking(target, snapshot);
  await f.community.run('community-reconciler');
  f.set({ ...snapshot, terminalFacts: { ...original, observedAt: time + 2000,
    ci: { ...original.ci!, observedAt: time + 2000, status: 'fail', checks: [{ name: 'gate', bucket: 'fail' }] } } });
  await f.community.run('community-reconciler');
  assert.equal((await f.community.objects.get(subject))?.terminalFacts?.ci?.status, 'fail');
  f.set({ ...snapshot, terminalFacts: { ...original, observedAt: time + 3000,
    ci: { ...original.ci!, observedAt: time + 3000, status: 'unknown', checkRollup: 'empty', checks: [] } } });
  await f.community.run('community-reconciler');
  assert.deepEqual(f.flags, [true, true, true]);
  let read = providerObservation(subject, await f.community.events.read(subject), await f.community.objects.get(subject));
  assert.equal(read.ci, 'unknown'); assert.equal((await f.community.objects.get(subject))?.externalReview?.ci, null);
  await f.community.collectTracking(target, { ...snapshot, terminalFacts: { ...original,
    observedAt: time + 4000, source: 'github-webhook', ci: null, reviews: [] } });
  await f.projector.rebuild(subject);
  read = providerObservation(subject, await f.community.events.read(subject), await f.community.objects.get(subject));
  assert.equal(read.ci, 'unknown');
});
