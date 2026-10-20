import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultBinding, initializeBinding, saveBinding, validateBinding } from './binding.mjs';
import { createState, reduce } from './state.mjs';

test('repository config accepts GitHub HTTPS and internal SSH, and rejects credentials in URLs', () => {
  const draft = {
    ...defaultBinding(),
    externalUrl: 'https://github.com/example/core.git',
    internalUrl: 'git@codehub.example:team/core.git',
  };
  assert.deepEqual(validateBinding(draft), []);
  assert.deepEqual(validateBinding({ ...draft, internalUrl: 'git@codehub:team/core.git' }), []);
  assert.ok(validateBinding({ ...draft, externalUrl: 'https://token@github.com/example/core.git' }).length);
  assert.ok(validateBinding({ ...draft, internalUrl: 'https://codehub.example/core?token=abc' }).length);
});
test('new bindings require checking the same draft, and initialization before syncing', () => {
  const state = createState('behind');
  const draft = { ...defaultBinding(), externalUrl: 'https://github.com/sentinel/core.git' };
  assert.throws(() => saveBinding(state, draft, null), /检查/);
  const saved = saveBinding(state, draft, JSON.stringify(draft));
  assert.equal(saved.binding.status, 'saved');
  assert.equal(saved.accepted, null);
  const initialized = initializeBinding(saved);
  assert.equal(initialized.binding.status, 'ready');
  assert.equal(initialized.accepted, draft.baseline);
});
test('an active delivery prevents replacing its repository binding', () => {
  const state = createState('waiting');
  const draft = { ...defaultBinding(), internalUrl: 'git@codehub.example:another/core.git' };
  assert.throws(() => saveBinding(state, draft, JSON.stringify(draft)), /未完成交付/);
});
test('snapshot and preserved-history initialization keep distinct semantics', () => {
  for (const mode of ['snapshot', 'history']) {
    const draft = { ...defaultBinding(), baseline: 'aa713c89', mode };
    const saved = saveBinding(createState('behind'), draft, JSON.stringify(draft));
    const state = initializeBinding(saved);
    assert.equal(state.accepted, 'aa713c89');
    if (mode === 'history') assert.equal(state.internalSha, state.accepted);
    else assert.notEqual(state.internalSha, state.accepted);
    assert.ok(state.archives.length);
  }
});
test('sync cannot start before initialization and freezes a binding identity afterwards', () => {
  const blank = createState('unconfigured');
  assert.deepEqual(reduce(blank, { type: 'start' }), blank);
  const saved = saveBinding(createState('behind'), defaultBinding(), JSON.stringify(defaultBinding()));
  assert.deepEqual(reduce(saved, { type: 'start' }), saved);
  const initialized = initializeBinding(saved);
  const started = reduce(initialized, { type: 'start' });
  assert.equal(started.active.bindingId, initialized.binding.id);
});
