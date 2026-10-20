import assert from 'node:assert/strict';
import test from 'node:test';
import { createState, reduce, summary } from './state.mjs';

test('latest depends on accepted upstream, not internal main SHA', () => {
  const state = createState('synced');
  assert.notEqual(state.internalSha, state.accepted);
  assert.equal(summary(state).codeLatest, true);
});
test('approval is required before main can move, with user note retained', () => {
  let state = createState('behind');
  const original = state.internalSha;
  state = reduce(state, { type: 'start' });
  for (let i = 0; i < 5; i++) state = reduce(state, { type: 'advance' });
  assert.equal(state.active.phase, 6);
  assert.equal(state.internalSha, original);
  state = reduce(state, { type: 'approve', note: 'sentinel-approval-46' });
  assert.notEqual(state.internalSha, original);
  assert.equal(state.events.at(-1).note, 'sentinel-approval-46');
});
test('external updates do not mutate the frozen target', () => {
  let state = createState('waiting');
  const target = state.active.target;
  state = reduce(state, { type: 'external' });
  assert.equal(state.active.target, target);
  assert.notEqual(state.latest, target);
});
test('uncertain PR creation is reconciled without duplicate IDs', () => {
  let state = createState('timeout');
  const id = state.active.internalPr;
  state = reduce(state, { type: 'recover' });
  assert.equal(state.active.internalPr, id);
  assert.equal(state.active.phase, 5);
  assert.equal(state.active.block, null);
});
test('latest code with metadata pending is not complete; recovery never remerges', () => {
  let state = createState('metadata');
  const sha = state.internalSha;
  assert.equal(summary(state).codeLatest, true);
  assert.equal(summary(state).fullyComplete, false);
  state = reduce(state, { type: 'recover' });
  assert.equal(state.internalSha, sha);
  assert.equal(summary(state).fullyComplete, true);
});
test('drift and failed checks cannot be approved', () => {
  for (const scenario of ['drift', 'plugin']) {
    const state = createState(scenario);
    assert.deepEqual(reduce(state, { type: 'approve', note: 'illegal' }), state);
  }
});

test('an unfinished delivery cannot be replaced, including pending metadata', () => {
  for (const scenario of ['waiting', 'timeout', 'metadata']) {
    const state = createState(scenario);
    assert.deepEqual(reduce(state, { type: 'start' }), state);
  }
});

test('platform merge is observed before verification advances the accepted cursor', () => {
  let state = createState('waiting');
  const accepted = state.accepted;
  state = reduce(state, { type: 'approve', note: 'platform-note-89' });
  assert.equal(state.active.phase, 7);
  assert.equal(state.accepted, accepted);
  state = reduce(state, { type: 'advance' });
  assert.equal(state.active.phase, 8);
  assert.equal(state.accepted, state.active.target);
  assert.equal(summary(state).fullyComplete, false);
  state = reduce(state, { type: 'advance' });
  assert.equal(state.active.phase, 9);
});
