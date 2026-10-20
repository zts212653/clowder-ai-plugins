import { hydrateRuleLists, ruleField, ruleList } from './file-rule-fields.mjs';
import { parseRules, ruleDraft, ruleState, savedRules, selectableRule, toggleRule } from './file-rule-selection.mjs';
import { hydrateFiles } from './files.mjs';

export function hydrateFileRules() {
  hydrateRuleLists();
  hydrateFiles();
  const panel = document.querySelector('#baseline-differences');
  if (!panel?.querySelector('[data-selected-rules]')) return;
  const rules = parseRules(ruleField()?.value ?? '');
  const items = JSON.parse(panel.querySelector('[data-file-tree]').dataset.items);
  panel.querySelector('[data-selected-rules]').innerHTML = ruleList(rules);
  const draft = ruleDraft(savedRules(panel), rules);
  panel.querySelector('[data-rule-state]').textContent = draft.dirty ? `内部保留规则 · 尚未保存（新增 ${draft.added.length}，移除 ${draft.removed.length}）` : '内部保留规则 · 已保存';
  const remaining = items.filter((item) => item.blocking && !ruleState(rules, item.path).checked).length;
  const retained = items.filter((item) => ruleState(rules, item.path).checked).length;
  panel.querySelector('[data-rule-count]').textContent =
    `完整清单 ${items.length} 个文件：${draft.dirty ? '修改后将保留' : '已声明保留'}内部 ${retained} 个，跟随外部 ${items.length - retained} 个；已选 ${rules.length} 条保留规则；仍有 ${remaining} 个未处理差异。最终以完整重新核验结果为准。`;
}
export function initializeFileRules({ snapshot, action, saveDraft, errorPanel }) {
  let saving = false;
  document.addEventListener('input', (event) => {
    if (!saving && event.target.closest('form[data-form="configure-repositories"], form[data-form="configure"]'))
      feedback('');
    if (event.target.matches('[name="internalPaths"]')) hydrateFileRules();
  });
  document.addEventListener('click', async (event) => {
    removeChoice(event.target.closest('[data-remove-rule]'));
    const button = event.target.closest('[data-save-file-rules]');
    if (!button || button.disabled || saving) return;
    saving = true;
    try {
      const { input, baseline } = selectionInput(snapshot(), button);
      saveDraft();
      const result = await action(input);
      if (!result) {
        feedback(`规则未保存。${errorPanel.textContent}`);
        return;
      }
      hydrateFileRules();
      feedback('规则已保存，正在核验原 U0 与 I0；尚未登记基线。');
      showVerification(await action(baseline), errorPanel);
      hydrateFileRules();
    } catch (error) {
      feedback(error.message);
    } finally {
      saving = false;
    }
  });
}
function removeChoice(button) {
  const field = ruleField();
  if (!button || button.disabled || !field) return;
  field.value = toggleRule(parseRules(field.value), button.dataset.removeRule, false).join('\n');
  field.dispatchEvent(new Event('input', { bubbles: true }));
}
function selectionInput(current, button) {
  const field = ruleField(),
    panel = button.closest('#baseline-differences');
  if (!field || current.state || (current.connection && !current.connection.editable))
    throw new Error('此绑定的规则已固定，请刷新核对；未保存任何变更。');
  if ((current.config.internalPaths ?? []).some((path) => !selectableRule(path)))
    throw new Error('既有规则包含特殊路径，文件树不能改写。请在本地私有配置核对原路径；原规则和台账保留。');
  const fields = Object.fromEntries(new FormData(field.form));
  const keys = current.connection
    ? ['mode', 'sourceUrl', 'internalUrl', 'sourceBranch', 'targetBranch', 'internalWebUrl']
    : ['mode'];
  if (keys.some((key) => (fields[key] ?? '').trim() !== (current.config[key] ?? '')))
    throw new Error('仓库、分支或同步方式有未保存修改。请先保存仓库配置并重新读取差异，再从文件树选择规则。');
  return {
    baseline: { action: 'inspect-baseline', upstream: panel.dataset.upstream, internal: panel.dataset.internal },
    input: current.connection
      ? {
          action: 'configure-file-rules',
          expectedRevision: current.connection.revision,
          expectedBinding: current.config.bindingId,
          internalPaths: parseRules(field.value),
        }
      : { action: 'configure', mode: current.config.mode, internalPaths: parseRules(field.value), mergePaths: [] },
  };
}
function showVerification(verified, errorPanel) {
  if (!verified || !verified.result?.valid) {
    feedback(`规则已保存，基线未通过。${errorPanel.textContent} 请处理下面的剩余差异后重试；已保存规则会保留。`);
    return;
  }
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  status.textContent = '所选内部保留规则已保存，核心文件核验通过；尚未启用。下一步：继续确认启用。';
  document.querySelector('#baseline-step')?.append(status);
}
function feedback(message) {
  const target = document.querySelector('[data-rule-feedback]');
  if (target) target.textContent = message;
}
