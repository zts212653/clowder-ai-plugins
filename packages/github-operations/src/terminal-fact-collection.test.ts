import assert from 'node:assert/strict';
import test from 'node:test';
import { terminalFixture, terminalSnapshot, subject, target, time } from '../test/terminal-fixture.js';
import { TerminalFactCollection } from './terminal-fact-collection.js';

test('unchanged complete reads fence delayed CI across rebuild without journal growth; real return to pass records again', async t => {
  const f = await terminalFixture(); t.after(() => f.community.stop());
  const snapshot = terminalSnapshot(), facts = snapshot.terminalFacts!;
  const observed = (offset: number, status: 'pass' | 'fail' = 'pass') => ({ ...snapshot, terminalFacts: { ...facts,
    observedAt: time + offset, ci: { ...facts.ci!, status, observedAt: time + offset,
      checks: [{ name: 'gate', bucket: status }] } } });
  await f.community.collectTracking(target, observed(1000));
  const initial = await f.community.events.read(subject);
  await f.community.collectTracking(target, observed(3000));
  const dismissed = { sourceEventId: 'later-dismissal', subjectKey: subject, kind: 'pr.review_submitted' as const,
    classification: 'informational' as const, at: time + 3500, payload: { reviewId: 10,
      author: 'reviewer', reviewState: 'DISMISSED', commitId: facts.headSha, submittedAt: facts.reviews[0]!.submittedAt } };
  await f.community.events.append(dismissed); await f.projector.apply(dismissed);
  await f.projector.rebuild(subject);
  await f.community.collectTracking(target, observed(2000, 'fail'));
  assert.deepEqual(await f.community.events.read(subject), [...initial, dismissed]);
  assert.equal((await f.community.objects.get(subject))?.terminalFacts?.ci?.status, 'pass');
  await f.community.collectTracking(target, observed(4000, 'fail'));
  await f.community.collectTracking(target, observed(5000));
  await f.community.collectTracking(target, observed(6000));
  assert.equal((await f.community.objects.get(subject))?.terminalFacts?.ci?.status, 'pass');
  assert.equal((await f.community.events.read(subject)).filter(event => event.kind === 'pr.terminal_observed').length, 3);
});

test('serialized identical observations produce one fact; same-clock pass/fail/pass transitions retain unique identities', async t => {
  const f = await terminalFixture(); t.after(() => f.community.stop());
  const collector = new TerminalFactCollection(f.storage, f.community.events, f.projector, f.community.projectionOperations);
  const facts = terminalSnapshot().terminalFacts!;
  const results = await Promise.all([0, 1].map(i => collector.collect(subject, [], { ...facts,
    observedAt: facts.observedAt + i, ci: { ...facts.ci!, observedAt: facts.ci!.observedAt + i } })));
  assert.deepEqual(results.map(result => result.recorded), [true, false]);
  const now = facts.observedAt + 10;
  const failing = { ...facts, observedAt: now, ci: { ...facts.ci!, status: 'fail' as const, observedAt: now,
    checks: [{ name: 'gate', bucket: 'fail' as const }] } };
  await collector.collect(subject, [], failing);
  await collector.collect(subject, [], { ...facts, observedAt: now, ci: { ...facts.ci!, observedAt: now } });
  const events = (await f.community.events.read(subject)).filter(event => event.kind === 'pr.terminal_observed');
  assert.equal(events.length, 3); assert.equal(new Set(events.map(event => event.sourceEventId)).size, 3);
  assert.equal((await f.community.objects.get(subject))?.terminalFacts?.ci?.status, 'pass');
});
