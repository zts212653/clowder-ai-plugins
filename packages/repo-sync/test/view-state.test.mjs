import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { retainView } from '../web/view-state.mjs';

const savedGlobals = { document: globalThis.document, window: globalThis.window };
beforeEach(() => {
  globalThis.document = { activeElement: null };
  globalThis.window = { scrollY: 0, scrollTo() {} };
});
afterEach(() => {
  for (const [key, value] of Object.entries(savedGlobals)) {
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
});

function field({
  kind = 'issue',
  source = '',
  delivery = '',
  reference = '',
  path = '',
  value = '',
  name = 'url',
  type = 'url',
  run = '',
  renderedValue = value,
} = {}) {
  const values = { deliveryId: delivery, previousUrl: reference, path, runId: run };
  const form = {
    dataset: { form: kind, source },
    elements: { namedItem: (key) => (Object.hasOwn(values, key) ? { value: values[key] } : null) },
    closest: () => null,
  };
  return {
    form,
    name,
    type,
    value,
    options: type === 'select-one' ? [{ value: renderedValue, defaultSelected: true }] : undefined,
    selectionStart: 0,
    selectionEnd: value.length,
    closest: (selector) => (selector === 'form' ? form : null),
    focus() {
      document.activeElement = this;
    },
    setSelectionRange() {},
  };
}
function renderCycle(before, selected, after, binding = 'binding', { previousRevision, revision } = {}) {
  let controls = before;
  const messages = [];
  const content = {
    dataset: { binding, revision: previousRevision },
    contains: (target) => controls.includes(target),
    querySelectorAll: () => controls,
    insertAdjacentHTML: (_position, html) => messages.push(html),
  };
  document.activeElement = before[selected];
  const restore = retainView(content, binding, revision);
  controls = after;
  restore();
  return messages;
}

test('focus restoration identifies the source Issue when multiple forms have the same field names', () => {
  const before = [field({ source: 'A', value: 'first' }), field({ source: 'B', value: 'second-draft' })];
  const after = [field({ source: 'A', value: 'first' }), field({ source: 'B' })];
  renderCycle(before, 1, after);
  assert.equal(after[0].value, 'first', 'the second Issue draft must not overwrite the first Issue');
  assert.equal(after[1].value, 'second-draft');
  assert.equal(document.activeElement, after[1]);
});

for (const [changed, original, next] of [
  ['source', { source: 'issue-A' }, { source: 'issue-B' }],
  ['delivery', { kind: 'pr', delivery: 'old-delivery' }, { kind: 'pr', delivery: 'new-delivery' }],
  [
    'reference',
    { kind: 'pr', delivery: 'same', reference: 'https://platform.example/pr/1' },
    { kind: 'pr', delivery: 'same', reference: 'https://platform.example/pr/2' },
  ],
  ['path', { kind: 'resolve', path: 'one.txt' }, { kind: 'resolve', path: 'two.txt' }],
]) {
  test(`focus restoration does not transfer a draft after its ${changed} identity changes`, () => {
    const before = [field({ ...original, value: 'old-object-draft' })];
    const after = [field({ ...next, value: 'new-object-value' })];
    renderCycle(before, 0, after);
    assert.equal(after[0].value, 'new-object-value');
  });
}

test('same-object repaint retains focused edits and transient passwords without persisting drafts', () => {
  const original = { source: 'issue-A', delivery: 'same', reference: 'https://platform.example/issues/1' };
  const before = [
    field({ ...original, value: 'typed-draft' }),
    field({ kind: 'configure-repositories', name: 'issueToken', type: 'password', value: 'nonsecret-fixture' }),
  ];
  const after = [
    field({ ...original }),
    field({ kind: 'configure-repositories', name: 'issueToken', type: 'password' }),
  ];
  renderCycle(before, 0, after);
  assert.equal(after[0].value, 'typed-draft');
  assert.equal(after[1].value, 'nonsecret-fixture');
});

test('same Git binding with a changed configuration revision clears unsubmitted passwords and explains recovery', () => {
  for (const focusedIndex of [0, 1]) {
    const original = { kind: 'configure-repositories' };
    const before = [
      field({ ...original, name: 'sourceBranch', value: 'typed-branch' }),
      field({ ...original, name: 'issueToken', type: 'password', value: 'nonsecret-fixture' }),
    ];
    const after = [
      field({ ...original, name: 'sourceBranch', value: 'saved-branch' }),
      field({ ...original, name: 'issueToken', type: 'password' }),
    ];
    const messages = renderCycle(before, focusedIndex, after, 'same-git-binding', {
      previousRevision: 'api-project-a',
      revision: 'api-project-b',
    });
    assert.equal(after[1].value, '', 'a new API scope must require deliberate credential input');
    assert.ok(
      messages.some((message) => /Token.*清空/.test(message)),
      'explain why authentication needs input again',
    );
    if (focusedIndex === 0) assert.equal(after[0].value, 'typed-branch', 'ordinary focused drafts remain available');
  }
});

test('a changed server continuation policy is not overwritten by the old focused select value', () => {
  const control = { kind: 'configure-continuation', run: 'same-run', name: 'continuation', type: 'select-one' };
  const before = [field({ ...control, value: 'after-each', renderedValue: 'after-each' })];
  const after = [field({ ...control, value: 'automatic', renderedValue: 'automatic' })];
  renderCycle(before, 0, after);
  assert.equal(after[0].value, 'automatic');
});

test('a focused continuation draft cannot cross into a different run', () => {
  const control = { kind: 'configure-continuation', name: 'continuation', type: 'select-one' };
  const before = [field({ ...control, run: 'old-run', value: 'after-each', renderedValue: 'automatic' })];
  const after = [field({ ...control, run: 'new-run', value: 'automatic', renderedValue: 'automatic' })];
  renderCycle(before, 0, after);
  assert.equal(after[0].value, 'automatic');
});

test('a focused unsaved continuation choice survives polling when the run and server baseline are unchanged', () => {
  const control = { kind: 'configure-continuation', run: 'same-run', name: 'continuation', type: 'select-one' };
  const before = [field({ ...control, value: 'after-each', renderedValue: 'automatic' })];
  const after = [field({ ...control, value: 'automatic', renderedValue: 'automatic' })];
  renderCycle(before, 0, after);
  assert.equal(after[0].value, 'after-each');
});
