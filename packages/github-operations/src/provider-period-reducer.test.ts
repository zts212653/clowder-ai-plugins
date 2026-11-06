import assert from 'node:assert/strict';
import test from 'node:test';
import type { CommunityEvent } from './business/model/index.js';
import { terminalSnapshot, subject, head, time } from '../test/terminal-fixture.js';
import { currentProviderFacts, normalizeProviderLifecycle, reduceProviderEvent, reduceProviderHistory } from './business/domains/community/provider-period.js';
import { terminalObservationEvent } from './business/domains/community/terminal-provider-facts.js';

type State = 'open' | 'closed' | 'merged';
function observation(state: State, delta: number, summary = false): CommunityEvent {
  if (state === 'open') return { sourceEventId: `open-${delta}`, subjectKey: subject, kind: 'pr.open_observed',
    classification: 'informational', at: time + delta, payload: { headSha: head, observedAt: time + delta + 100,
      providerUpdatedAt: new Date(time + delta).toISOString() } };
  const at = new Date(time + delta).toISOString();
  if (summary) return { sourceEventId: `summary-${state}-${delta}`, subjectKey: subject,
    kind: state === 'merged' ? 'pr.merged' : 'pr.closed', classification: 'state-changing', at: time + delta,
    payload: { closedAt: at, mergedAt: state === 'merged' ? at : null, headSha: head, providerObservedAt: time + delta + 100 } };
  const facts = terminalSnapshot(state).terminalFacts!;
  return terminalObservationEvent({ ...facts, observedAt: time + delta + 100,
    closedAt: at, mergedAt: state === 'merged' ? at : null,
    ci: { ...facts.ci!, observedAt: time + delta + 100 } });
}

const cases: ReadonlyArray<readonly [State, State, number, boolean]> = [
  ['open', 'closed', 1000, false], ['open', 'merged', 1000, false],
  ['open', 'closed', 9000, true], ['open', 'merged', 9000, true],
  ['closed', 'open', 1000, false], ['closed', 'open', 9000, true],
  ['closed', 'closed', 1000, false], ['closed', 'closed', 9000, true],
  ['closed', 'merged', 1000, false], ['closed', 'merged', 9000, true],
  ['merged', 'open', 9000, false], ['merged', 'closed', 9000, false],
  ['merged', 'merged', 9000, false], ['merged', 'merged', 1000, false],
];
for (const [from, to, delta, accepted] of cases) test(`provider ${from} → ${to} at ${delta} has one decision for full and summary observations`, () => {
  const original = reduceProviderHistory([observation(from, 5000)]);
  for (const summary of [false, true]) {
    const result = reduceProviderEvent(original, observation(to, delta, summary));
    assert.equal(result.accepted, accepted, summary ? 'summary' : 'complete');
    assert.equal(result.value.state?.state, accepted ? to : from);
    if (!accepted) assert.deepEqual(result.value, original);
  }
});

test('same-period sparse webhook retains the API clock without using delivery time as a provider read', () => {
  const api = observation('closed', 5000), initial = reduceProviderHistory([api]);
  const facts = { ...terminalSnapshot('closed').terminalFacts!, closedAt: new Date(time + 5000).toISOString(),
    observedAt: time + 30000, source: 'github-webhook' as const, reviews: [], ci: null };
  const after = reduceProviderEvent(initial, terminalObservationEvent(facts));
  assert.equal(after.accepted, true); assert.equal(after.value.state?.observedAt, time + 5100);
  assert.equal(after.value.state?.updatedAt, initial.state?.updatedAt);
  assert.equal(currentProviderFacts(after.value)?.ci?.status, 'pass');
});

test('a mergedAt-only summary is clocked and does not expose previous-period CI as current', () => {
  const original = reduceProviderHistory([observation('closed', 0), observation('open', 5000)]);
  const merged: CommunityEvent = { sourceEventId: 'mergedAt-only', subjectKey: subject, kind: 'pr.merged',
    classification: 'state-changing', payload: { mergedAt: new Date(time + 9000).toISOString() }, at: time + 9000 };
  const after = reduceProviderEvent(original, merged);
  assert.equal(after.accepted, true); assert.equal(after.value.state?.updatedAt, merged.payload.mergedAt);
  assert.equal(after.value.state?.state, 'merged'); assert.equal(currentProviderFacts(after.value), undefined);
  assert.equal(after.value.facts?.ci?.status, 'pass', 'the source-bound old evidence remains historical');
});

test('a complete result cannot contradict the same-period summary final HEAD', () => {
  const initial = reduceProviderHistory([observation('merged', 5000, true)]);
  const next = observation('merged', 5000);
  const facts = terminalSnapshot().terminalFacts!;
  next.payload.terminalFacts = { ...facts, closedAt: new Date(time + 5000).toISOString(), mergedAt: new Date(time + 5000).toISOString(),
    headSha: 'e'.repeat(40), ci: { ...facts.ci!, headSha: 'e'.repeat(40) } };
  const result = reduceProviderEvent(initial, next);
  assert.equal(result.accepted, false); assert.equal(result.reason, 'invalid');
  assert.equal(result.value.state?.headSha, head);
});

test('later sparse facts retain a same-period summary HEAD and known merge timestamp', () => {
  const original = reduceProviderHistory([observation('merged', 5000, true)]);
  const partial = observation('merged', 5000);
  const facts = terminalSnapshot().terminalFacts!;
  partial.payload.terminalFacts = { ...facts, headSha: null, closedAt: null, mergedAt: null, ci: null };
  const result = reduceProviderEvent(original, partial);
  assert.equal(result.accepted, true); assert.equal(result.value.state?.headSha, head);
  assert.equal(currentProviderFacts(result.value)?.headSha, head);
  assert.equal(currentProviderFacts(result.value)?.mergedAt, new Date(time + 5000).toISOString());
});

test('successive newly proven summary close periods cannot reuse an earlier lifecycle source ID', () => {
  let period = reduceProviderHistory([observation('closed', 5000, true)]);
  const ids = new Set([period.state!.lifecycleSourceEventId]);
  for (const delta of [9000, 13000]) {
    const raw = { ...observation('closed', delta, true), sourceEventId: `lifecycle:${subject}:closed` };
    const normalized = normalizeProviderLifecycle(raw, period);
    assert.equal(ids.has(normalized.sourceEventId), false);
    const next = reduceProviderEvent(period, normalized);
    assert.equal(next.accepted, true);
    assert.equal(next.value.state?.periodId, reduceProviderEvent(period, raw).value.state?.periodId);
    ids.add(normalized.sourceEventId); period = next.value;
  }
});

test('equivalent UTC timestamp spellings cannot create a new period or conflict with merge identity', () => {
  const original = reduceProviderHistory([observation('merged', 5000)]);
  const next = observation('merged', 5000);
  const facts = next.payload.terminalFacts as ReturnType<typeof terminalSnapshot>['terminalFacts'];
  next.payload.terminalFacts = { ...facts!, closedAt: facts!.closedAt!.replace('.000Z', 'Z'),
    mergedAt: facts!.mergedAt!.replace('.000Z', 'Z') };
  const result = reduceProviderEvent(original, next);
  assert.equal(result.accepted, true); assert.equal(result.value.state?.periodId, original.state?.periodId);
  assert.equal(currentProviderFacts(result.value)?.ci?.status, 'pass');
});

test('a later open HEAD belongs to the same provider period and preserves its prior state floors', () => {
  const original = reduceProviderHistory([observation('closed', 0), observation('open', 5000)]);
  const incoming = observation('open', 9000);
  incoming.payload.headSha = 'e'.repeat(40);
  const decision = reduceProviderEvent(original, incoming);
  assert.equal(decision.accepted, true);
  assert.equal(decision.value.state?.periodId, original.state?.periodId);
  assert.equal(decision.value.state?.headSha, 'e'.repeat(40));
  assert.equal(decision.value.state?.floorObservedAt, original.state?.floorObservedAt);
  assert.equal(decision.value.state?.floorUpdatedAt, original.state?.floorUpdatedAt);
});
