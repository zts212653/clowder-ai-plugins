import assert from 'node:assert/strict';
import test from 'node:test';
import { captureDraft, restoreDraft } from '../web/connections.mjs';

function form({
  kind = 'configure-auto-merge',
  baseline = 'original',
  run = 'run',
  checked = false,
  value = 'automatic',
} = {}) {
  const controls = [
    { name: 'runId', value: run, type: 'hidden' },
    kind === 'configure-auto-merge'
      ? { name: 'autoMerge', value: 'on', type: 'checkbox', checked, defaultChecked: false }
      : {
          name: 'continuation',
          value,
          type: 'select-one',
          tagName: 'SELECT',
          options: [{ value: 'automatic', defaultSelected: true }],
        },
    { name: 'issueToken', value: 'PRIVATE_TEST_VALUE', type: 'password' },
  ];
  controls.namedItem = (name) => controls.find((c) => c.name === name);
  const note = { hidden: true };
  return {
    dataset: { form: kind, editBaseline: baseline },
    elements: controls,
    closest: () => null,
    querySelectorAll: () => [],
    querySelector: (selector) => (selector === '[data-edit-note]' ? note : null),
    note,
  };
}
function cycle(before, after) {
  const previous = globalThis.document;
  try {
    let current = before;
    globalThis.document = { querySelectorAll: () => [current] };
    const drafts = captureDraft();
    current = after;
    restoreDraft(drafts);
    return drafts;
  } finally {
    if (previous) globalThis.document = previous;
    else delete globalThis.document;
  }
}
test('an unsaved auto-merge choice survives replacement, stays visibly unsaved and never persists a credential', () => {
  const next = form();
  const drafts = cycle(form({ checked: true }), next);
  assert.equal(next.elements.namedItem('autoMerge').checked, true);
  assert.equal(next.note.hidden, false);
  assert.doesNotMatch(JSON.stringify(drafts), /PRIVATE_TEST_VALUE|issueToken/);
});
test('a newer server merge choice or a different round rejects an older draft', () => {
  for (const override of [{ baseline: 'new server choice' }, { run: 'another run' }]) {
    const next = form({ ...override, checked: true });
    cycle(form({ checked: false }), next);
    assert.equal(next.elements.namedItem('autoMerge').checked, true);
  }
});
test('a continuation edit survives replacement only while its saved baseline is unchanged', () => {
  const next = form({ kind: 'configure-continuation' });
  cycle(form({ kind: 'configure-continuation', value: 'after-each' }), next);
  assert.equal(next.elements.namedItem('continuation').value, 'after-each');
  assert.equal(next.note.hidden, false);
  const changed = form({ kind: 'configure-continuation', baseline: 'new policy' });
  cycle(form({ kind: 'configure-continuation', value: 'after-each' }), changed);
  assert.equal(changed.elements.namedItem('continuation').value, 'automatic');
});
