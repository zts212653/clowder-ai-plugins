import { repositoryInput } from './connections.mjs';
import { showFormErrors } from './form-errors.mjs';
import { revealSetupResult } from './setup-navigation.mjs';
export function initializeSubmissions(context) {
  const { snapshot, action, issueAuthentication, githubAuthentication, records, setup, complete, activate } =
    context;
  document.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    if (form.hasAttribute('data-settings-form')) return context.projectSettings.submit(form);
    if (form.hasAttribute('data-github-auth')) return githubAuthentication.submit(form);
    if (form.hasAttribute('data-secret-form')) return issueAuthentication.submit(form);
    // Project forms are owned by project navigation, not the synchronization executor.
    if (!form.dataset.form && !form.hasAttribute('data-record-filter')) return;
    const fields = Object.fromEntries(new FormData(form));
    const tokens = {
      issueToken: fields.issueToken ?? '',
      githubToken: fields.githubToken ?? '',
    };
    delete fields.issueToken;
    delete fields.githubToken;
    if (form.hasAttribute('data-record-filter')) return records.filter(fields);
    if (form.dataset.form === 'configure-repositories' && !ordinaryFields(form, fields)) return;
    const binding = snapshot().config?.bindingId;
    const revision = snapshot().connection?.revision;
    let input =
      form.dataset.form === 'configure-repositories'
        ? repositoryInput(fields)
        : { action: form.dataset.form, ...fields };
    if (input.action === 'synchronize' && fields.tag) {
      input.targetKind = 'tag';
      input.targetValue = fields.tag;
      delete input.tag;
    }
    if (input.action === 'configure')
      for (const key of ['internalPaths', 'mergePaths'])
        input[key] = (fields[key] ?? '')
          .split(/\r?\n/)
          .map((v) => v.trim())
          .filter(Boolean);
    if (input.action === 'configure-identity') {
      input.receivingIdentity = {
        name: fields.commitName.trim(),
        email: fields.commitEmail.trim(),
      };
      delete input.commitName;
      delete input.commitEmail;
    }
    if (input.action === 'issue') input.sourceId = form.dataset.source;
    if (input.action === 'configure-closure') input.confirmed = fields.confirmed === 'on';
    if (input.action === 'cancel-delivery') input.confirmed = fields.confirmed === 'on';
    if (['synchronize', 'configure-auto-merge'].includes(input.action))
      input.autoMerge = fields.autoMerge === 'on';
    const resumeAutomaticMerge =
      input.action === 'configure-auto-merge' &&
      input.autoMerge &&
      snapshot().state?.automation?.status === 'WAITING_REVIEW' &&
      snapshot().state?.active?.status === 'WAITING_APPROVAL';
    if (input.action === 'receipts')
      input = {
        action: 'receipts',
        deliveryId: snapshot().state.active.id,
        observations: snapshot().state.active.issues.map((issue) => ({
          sourceId: issue.sourceId,
          internalId: snapshot().state.issues[issue.sourceId].internalId,
          state: fields[issue.sourceId],
        })),
      };
    if (input.action === 'configure-repositories') setup.beginSave();
    // Only the local submission closure keeps these during the request. A render must not copy them into a replacement form.
    for (const name of Object.keys(tokens)) {
      const field = form.elements.namedItem(name);
      if (field) field.value = '';
    }
    // Consume explicit consent before an async redraw; failed operations require a fresh confirmation.
    for (const field of form.querySelectorAll('input[name="confirmed"], input[data-confirmation-key]'))
      field.checked = false;
    const result = await action(input, form);
    if (!result) {
      if (snapshot().config?.bindingId === binding && snapshot().connection?.revision === revision)
        restoreSecrets(form.dataset.form, tokens);
      return;
    }
    for (const name of Object.keys(tokens)) {
      const field = form.elements.namedItem(name);
      if (field) field.value = '';
    }
    const config = result.config ?? snapshot().config;
    const issue = await issueAuthentication.complete(
      result,
      config?.prTransport === 'gitlab' || config?.issueAutomation?.mode === 'gitlab' ? tokens.issueToken : '',
    );
    const source = await githubAuthentication.complete(
      result,
      config?.mode === 'continuous' ? tokens.githubToken : '',
    );
    if (input.action === 'configure-repositories') {
      if (issue && source) await setup.checkConnections();
      else setup.partial();
      return;
    }
    if (input.action === 'inspect-baseline') return setup.acceptReport(result);
    if (input.action === 'adopt' && snapshot().state) return activate();
    complete(input.action, result);
    if (resumeAutomaticMerge) {
      await action({
        action: 'resume-sync',
        runId: input.runId,
        deliveryId: input.deliveryId,
      });
      return;
    }
  });
  document.addEventListener(
    'invalid',
    (event) => {
      for (let e = event.target.parentElement; e; e = e.parentElement)
        if (e.tagName === 'DETAILS') e.open = true;
    },
    true,
  );
  document.addEventListener('click', (event) => {
    const copy = event.target.closest('[data-copy-sha]');
    if (copy && /^[a-f0-9]{40,64}$/i.test(copy.dataset.copySha)) {
      const feedback = copy.parentElement.querySelector('[data-copy-feedback]');
      navigator.clipboard.writeText(copy.dataset.copySha).then(
        () => {
          feedback.textContent = '已复制';
        },
        () => {
          feedback.textContent = `复制失败：${copy.dataset.copySha}`;
        },
      );
      return;
    }
    const next = event.target.closest('[data-next-auth]');
    if (!next) return;
    const form = next.closest('form');
    const fields = [...form.querySelectorAll('[data-repository] input[required], input[name="mode"]')];
    const invalid = fields.find((e) => !e.checkValidity());
    if (invalid) {
      invalid.reportValidity();
      return;
    }
    const panel = form.querySelector('[data-connection-auth]');
    if (!panel.open) panel.querySelector(':scope > summary').click();
    panel.scrollIntoView({ block: 'start' });
    panel.querySelector('input:not([type="hidden"]), select')?.focus({ preventScroll: true });
  });
  document.addEventListener('input', (event) => {
    if (event.target.name !== 'url') return;
    const consent = event.target.form?.querySelector('[data-pr-confirm]');
    if (consent) consent.checked = false;
  });
  document.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-preview-sync]');
    if (!button) return;
    const fields = Object.fromEntries(new FormData(button.closest('form')));
    const result = await action({
      action: 'preview-sync',
      tag: fields.tag,
      targetKind: fields.targetKind,
      targetValue: fields.targetValue,
    });
    if (result) complete('preview-sync', result);
  });
}
function restoreSecrets(kind, tokens) {
  const form = [...document.querySelectorAll('form[data-form]')].find((form) => form.dataset.form === kind);
  if (!form) return;
  for (const [name, value] of Object.entries(tokens)) {
    const field = form.elements.namedItem(name);
    if (field && value) field.value = value;
  }
}
function ordinaryFields(form, fields) {
  const errors = [];
  if (
    !/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)[\w.-]+\/[\w.-]+(?:\.git)?\/?$/.test(
      fields.sourceUrl?.trim() ?? '',
    )
  )
    errors.push({
      field: 'sourceUrl',
      message: '填写 GitHub 仓库 HTTPS 或 SSH 地址，不含凭据、查询参数或文件路径。',
    });
  if (!['version', 'continuous'].includes(fields.mode))
    errors.push({ field: 'mode', message: '请选择你要同步的内容。' });
  if (errors.length) {
    showFormErrors(form.dataset.form, errors);
    return false;
  }
  return true;
}
export function configurationConfirmation(content, action, result, snapshot) {
  if (
    !result ||
    ![
      'configure',
      'configure-repositories',
      'configure-pr',
      'configure-issues',
      'configure-closure',
    ].includes(action)
  )
    return;
  const confirmation = document.createElement('p');
  confirmation.setAttribute('role', 'status');
  confirmation.textContent = {
    configure: '同步方式与文件规则已保存，请登记已有基线。',
    'configure-pr': 'PR 创建设置已保存，原基线与台账保留。回到工作台继续同步。',
    'configure-issues': 'Issue 自动化设置已保存。回到本笔同步继续创建或回读原对象。',
    'configure-repositories': '仓库配置已保存在本机。下一步：读取两侧版本并登记已有基线。',
    'configure-closure': '关单规则确认已保存。原基线与 Issue 映射保留，可继续本笔同步。',
  }[action];
  const setup = ['configure', 'configure-repositories'].includes(action);
  const form = content.querySelector(`form[data-form="${action}"]`);
  if (!setup && form) {
    form.after(confirmation);
    confirmation.scrollIntoView({ block: 'nearest' });
  } else (content.querySelector('[data-setup-current]') ?? content).prepend(confirmation);
  revealSetupResult(action, snapshot);
}
