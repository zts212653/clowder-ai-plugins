import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultBinding, initializeBinding, saveBinding, validateBinding } from './binding.mjs';
import { createBindingUI } from './binding-ui.mjs';
import { createState, reduce, summary } from './state.mjs';

const draft = () => ({ ...defaultBinding(), mode: 'adopt', baseline: 'aa713c89', internalBaseline: 'bb824d90' });
async function savedBinding(config, outcome = 'match') {
  assert.deepEqual(validateBinding(config), []);
  const { simulateBaselineCheck } = await import('./baseline.mjs');
  return saveBinding(
    createState('unconfigured'),
    config,
    JSON.stringify(config),
    simulateBaselineCheck(config, outcome),
  );
}

test('adopting an existing repository registers the exact supplied A and B without creating a new internal commit', async () => {
  const config = draft();
  const saved = await savedBinding(config);
  assert.equal(saved.accepted, null);
  const state = initializeBinding(saved);
  assert.equal(state.accepted, config.baseline);
  assert.equal(state.internalSha, config.internalBaseline);
  assert.equal(state.binding.initialInternalSha, config.internalBaseline);
  assert.equal(summary(state).behindCommits, 20);
  assert.equal(summary(state).behind, 4);
});

test('a shared commit A can be the baseline of both repositories', async () => {
  const config = { ...draft(), internalBaseline: 'aa713c89' };
  const state = initializeBinding(await savedBinding(config));
  assert.equal(state.accepted, state.internalSha);
});

test('adoption requires an internal commit and refuses a wrong tree or moved internal head', async () => {
  assert.match(validateBinding({ ...draft(), internalBaseline: '' }).join(' '), /内部.*commit/);
  for (const outcome of ['tree-mismatch', 'head-moved'])
    await assert.rejects(savedBinding(draft(), outcome), /基线|内部分支/);
});

test('changing either baseline after verification prevents activating the saved mapping', async () => {
  const saved = await savedBinding(draft());
  saved.binding.internalBaseline = 'cc935ea1';
  assert.throws(() => initializeBinding(saved), /重新.*检查|核验/);
});

test('the existing-repository wizard presents both sides of the baseline', () => {
  const state = createState('unconfigured');
  const ui = createBindingUI(
    () => state,
    () => {},
    () => {},
    () => {},
  );
  ui.action('next-binding');
  assert.match(ui.render(), /内部.*commit B/);
  assert.match(ui.render(), /name="internalBaseline"/);
  assert.match(ui.render(), /已有内部仓/);
});

test('twenty pending commits are received in four PRs, advancing only after review and verification', async () => {
  let state = initializeBinding(await savedBinding(draft()));
  for (let index = 0; index < 4; index++) {
    const accepted = state.accepted;
    const internal = state.internalSha;
    state = reduce(state, { type: 'start' });
    assert.equal(state.internalSha, internal);
    assert.equal(state.active.commits.length, 5);
    for (let step = 0; step < 5; step++) state = reduce(state, { type: 'advance' });
    state = reduce(state, { type: 'approve' });
    assert.equal(state.accepted, accepted);
    state = reduce(state, { type: 'advance' });
    assert.equal(summary(state).behindCommits, 15 - index * 5);
    state = reduce(state, { type: 'advance' });
  }
  assert.equal(summary(state).fullyComplete, true);
  assert.equal(state.accepted, state.latest);
});
