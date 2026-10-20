import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultBinding, initializeBinding, saveBinding, validateBinding } from './binding.mjs';
import { createBindingUI } from './binding-ui.mjs';
import { createState } from './state.mjs';

function setup(state) {
  return createBindingUI(
    () => state,
    () => {},
    () => {},
    () => {},
  );
}

test('first-use simulation has real sample values and can advance without typing', () => {
  const state = createState('unconfigured');
  const ui = setup(state);
  assert.ok(ui.render().includes(`value="${defaultBinding().externalUrl}"`));
  assert.ok(ui.render().includes(`value="${defaultBinding().internalUrl}"`));
  ui.action('next-binding');
  assert.match(ui.render(), /第 2 \/ 3 步/);
  assert.equal(state.binding.status, 'draft');
  assert.equal(state.binding.externalUrl, '');
  assert.equal(state.accepted, null);
});

test('simulation neither requests credential profile names nor requires them to initialize', () => {
  assert.doesNotMatch(setup(createState('unconfigured')).render(), /认证配置引用|name="(?:external|internal)Profile"/);
  const draft = { ...defaultBinding(), externalProfile: '', internalProfile: '' };
  assert.deepEqual(validateBinding(draft), []);
  const initialized = initializeBinding(saveBinding(createState('unconfigured'), draft, JSON.stringify(draft)));
  assert.equal(initialized.binding.status, 'ready');
  assert.equal(initialized.accepted, draft.baseline);
  assert.equal(Object.hasOwn(initialized.binding, 'externalProfile'), false);
  assert.equal(Object.hasOwn(initialized.binding, 'internalProfile'), false);
});

test('opening the wizard preserves already entered custom repository addresses', () => {
  const state = createState('unconfigured');
  state.binding.externalUrl = 'https://github.com/sentinel-lab/custom.git';
  state.binding.internalUrl = 'git@codehub.example:sentinel/custom.git';
  const ui = setup(state);
  assert.ok(ui.render().includes(`value="${state.binding.externalUrl}"`));
  assert.ok(ui.render().includes(`value="${state.binding.internalUrl}"`));
});

test('reopening a saved binding keeps the checked configuration for initialization', () => {
  const draft = { ...defaultBinding(), internalWebUrl: '' };
  const saved = saveBinding(createState('unconfigured'), draft, JSON.stringify(draft));
  assert.match(setup(saved).render(), /id="initialize-binding"/);
  assert.equal(saved.accepted, null);
});
