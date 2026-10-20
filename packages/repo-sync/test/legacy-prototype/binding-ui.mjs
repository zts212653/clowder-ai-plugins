import { defaultBinding, initializeBinding, saveBinding, validateBinding } from './binding.mjs';
import { BASE, COMPLETE } from './data.mjs';
import { renderBinding } from './render-binding.mjs';

function initialDraft(binding) {
  const draft = structuredClone(binding);
  if (draft.status !== 'draft') return draft;
  const example = defaultBinding();
  for (const field of ['externalUrl', 'internalUrl']) if (!draft[field]) draft[field] = example[field];
  if (!draft.baseline) draft.mode = 'adopt';
  if (draft.mode === 'adopt' && !draft.internalBaseline) draft.internalBaseline = BASE;
  if (!draft.baseline) draft.baseline = BASE;
  return draft;
}

export function createBindingUI(getState, replaceState, redraw, toast) {
  const ui = { draft: null, checked: null, baselineCheck: null, outcome: 'match', errors: [], step: 1, editing: false };
  function reset() {
    ui.draft = initialDraft(getState().binding);
    ui.checked = null;
    ui.baselineCheck = getState().binding.baselineCheck ?? null;
    ui.outcome = 'match';
    ui.errors = [];
    ui.editing = getState().binding.status !== 'ready';
    ui.step = getState().binding.status === 'saved' ? 3 : 1;
  }
  function changed(event) {
    if (!event.target.closest('#binding-form')) return;
    ui.draft = { ...ui.draft, ...Object.fromEntries(new FormData(document.getElementById('binding-form'))) };
    ui.checked = null;
    ui.baselineCheck = null;
    if (event.target.id === 'demo-baseline-outcome') ui.outcome = event.target.value;
    ui.errors = [];
    const save = document.getElementById('save-binding');
    if (save) save.disabled = true;
    const result = document.getElementById('config-result');
    if (result) result.textContent = '配置已修改，请重新检查。';
    document.getElementById('wizard-error')?.replaceChildren();
    document.getElementById('baseline-check')?.replaceChildren();
    if (event.type === 'change' && event.target.name === 'mode') redraw();
  }
  const actions = {
    'example-binding'() {
      const example = defaultBinding();
      for (const field of ['externalUrl', 'internalUrl', 'sourceBranch', 'targetBranch', 'internalWebUrl'])
        ui.draft[field] = example[field];
      ui.checked = null;
      ui.errors = [];
      toast('已填入示例仓库，可以直接点击下一步');
    },
    'edit-binding'() {
      if (getState().active && getState().active.phase < COMPLETE) throw new Error('当前同步尚未完成，不能修改连接。');
      ui.editing = true;
      if (!ui.draft.internalBaseline) ui.draft.internalBaseline = getState().internalSha;
      ui.step = 1;
    },
    'cancel-binding': reset,
    'previous-binding'() {
      ui.step = Math.max(1, ui.step - 1);
      ui.errors = [];
    },
    'next-binding'() {
      ui.errors = validateBinding(ui.draft, ui.step === 1 ? 'connection' : 'baseline');
      if (!ui.errors.length) ui.step += 1;
    },
    'check-binding'() {
      ui.errors = validateBinding(ui.draft);
      if (!ui.errors.length && ui.draft.mode === 'adopt') {
        ui.baselineCheck = simulateBaselineCheck(ui.draft, ui.outcome);
        try {
          assertBaselineCheck(ui.draft, ui.baselineCheck);
        } catch (error) {
          ui.errors.push(error.message);
        }
      }
      ui.checked = ui.errors.length ? null : JSON.stringify(ui.draft);
    },
    'save-binding'() {
      replaceState(saveBinding(getState(), ui.draft, ui.checked, ui.baselineCheck), 'configuration');
      reset();
      toast('连接已保存，确认基线后即可启用');
    },
    'initialize-binding'() {
      if (JSON.stringify(ui.draft) !== JSON.stringify(getState().binding))
        throw new Error('配置已修改，请重新检查并保存。');
      replaceState(initializeBinding(getState()), 'overview');
      reset();
      toast('基线登记完成，现在可以开始同步');
    },
  };
  function action(id) {
    if (!Object.hasOwn(actions, id)) return false;
    try {
      actions[id]();
      redraw();
    } catch (error) {
      ui.errors = [error.message];
      redraw();
    }
    return true;
  }
  reset();
  return { reset, changed, action, render: () => renderBinding(getState(), ui) };
}

import { assertBaselineCheck, simulateBaselineCheck } from './baseline.mjs';
