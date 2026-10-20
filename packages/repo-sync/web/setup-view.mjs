import { closureInstructions, closureSettings } from './closure-settings.mjs';
import { commitFields, identitySettings } from './commit-settings.mjs';
import { fileRuleFields } from './file-rule-fields.mjs';
import { fileTree } from './files.mjs';
import { githubAuthForm } from './github-auth.mjs';
import { authenticationForm } from './issue-auth.mjs';
import { issueFields } from './issue-settings.mjs';
import { prCreationFields } from './platform.mjs';
import { repositoryFields, sourceAuthenticationFields } from './repository-fields.mjs';
import { enabledSettings } from './settings-view.mjs';
import { when } from './ui.mjs';
import { modeSettings } from './version.mjs';

export function setupConfiguration(snapshot, esc, sha, button, flow = {}) {
  const { config, state, connection } = snapshot;
  const step = state ? 3 : flow.editing || !config ? 1 : flow.confirmed && flow.report?.valid ? 3 : 2;
  const steps = ['连接与认证', '核验已有同步起点', '确认启用'];
  const nav = `<ol class="flow setup">${steps.map((name, i) => `<li ${step === i + 1 ? 'aria-current="step"' : ''}><b>${i + 1 < step || state ? '✓' : i + 1 === step ? '●' : '○'} ${i + 1} · ${name}</b></li>`).join('')}</ol>`;
  const activity =
    '<div id="operation" role="region" aria-label="当前步骤执行情况" tabindex="-1"></div><div id="error-slot"></div>';
  const summary = config ? repositorySummary(config, esc) : '';
  if (state && connection) return enabledSettings(snapshot);
  if (state)
    return `${nav}<details class="card" data-setup-repositories><summary>仓库与接收配置 · 已启用</summary>${summary}<p>绑定已启用；另一组仓库或模式请新增项目，原台账保留。</p></details><section class="card setup-current" id="baseline-step"><h2>配置已完成</h2><p>初始对应 ${sha(state.initial.upstream)} → ${sha(state.initial.internal)}</p><p>当前接收 ${sha(state.accepted.upstream)} → ${sha(state.accepted.internal)}</p><button type="button" class="primary" data-view="workbench">进入同步工作台 →</button>${activity}</section>${closureSettings(snapshot, esc)}${identitySettings(snapshot, esc)}${githubAuthForm(snapshot)}${storageDetails(snapshot, esc)}`;
  const previous = config
    ? `<details class="card" data-setup-repositories ${step === 1 ? 'open' : ''}><summary>✓ 1 · 仓库信息已保存</summary>${summary}${connection?.editable ? `<button type="button" data-edit-connection>修改连接信息</button><div ${step === 1 ? '' : 'hidden'} data-connection-editor>${connectionForm(config, connection, esc)}</div>` : !connection ? modeSettings(config, null, esc) : '<p>此配置由本机私有文件管理。</p>'}</details>`
    : '';
  const checks = checkList(flow.checks ?? [], esc);
  if (step === 1)
    return `${nav}${checks}${config ? previous : `<section class="card setup-current" data-setup-current><h2>1 · 连接与认证</h2>${connectionForm(config, connection, esc)}</section>`}<section class="setup-current" data-setup-current>${config ? `<button type="button" data-check-connections>检查连接并继续 →</button>${githubAuthForm(snapshot)}${authenticationForm(config)}` : ''}${activity}</section>${storageDetails(snapshot, esc)}`;
  if (step === 3)
    return `${nav}${previous}<section class="card setup-current" data-setup-current id="baseline-step"><h2>3 · 确认启用</h2>${summary}<p>外部历史起点 ${sha(flow.report.upstream)} ↔ 内部当前接收位置 ${sha(flow.report.internal)}</p><p>核心文件核验通过 · ${when(flow.report.checkedAt)}。认证只证明已完成的读取，写能力在实际执行时核验。</p><p class="note-line">内部身份：${config.commitStrategy === 'rewrite' ? '统一内部身份，记录 SHA 映射' : '保留上游身份'}；检查范围：${esc(config.checkProfile === 'git-integrity' ? 'Git 基础完整性（不代表项目测试通过）' : '私有配置中的项目检查')}。</p><form data-form="adopt"><input type="hidden" name="upstream" value="${esc(flow.report.upstream)}"><input type="hidden" name="internal" value="${esc(flow.report.internal)}"><button class="primary">启用并进入同步工作台 →</button></form><button type="button" data-edit-baseline>返回核验同步起点</button><p>启用会重新核验并登记对应，不推送代码或创建 Issue / PR。</p>${activity}</section>`;
  return `${nav}${previous}<section class="card setup-current" data-setup-current id="baseline-step"><h2>2 · 核验已有同步起点</h2><p><b>外部填上次已接收版本；内部读取当前接收分支 HEAD。</b>外部即使已新增 20 个提交，也不应把最新版本填作历史起点。</p><button type="button" data-action="heads">读取两侧当前版本</button><div id="observed-heads" role="status"></div><form data-form="inspect-baseline"><label for="upstream">上次已经接收的外部版本 <small>U0 · 历史 tag 或完整 commit SHA，不是本次目标</small><input id="upstream" name="upstream" required value="${esc(flow.inputs?.upstream ?? '')}" placeholder="v1.0.0 或上次已接收的完整 SHA"></label><label for="internal">内部当前接收位置 <small>I0 · 当前合入分支 HEAD</small><input id="internal" name="internal" required value="${esc(flow.inputs?.internal ?? flow.heads?.internal ?? '')}"></label><p>内部第一次同步后有专项改动：U0 仍填第一次接收的外部 A，I0 填内部现在的 main。两侧 SHA 可以不同，核心文件必须一致。</p><button ${flow.report?.valid ? '' : 'class="primary"'}>核验起点并查看文件 →</button></form>${reportPanel(flow.report, snapshot, esc)}${activity}</section>${storageDetails(snapshot, esc)}`;
}
function connectionForm(config, connection, esc) {
  const defaultIssueMode = config?.issueAutomation?.mode ?? (config?.mode === 'continuous' ? 'gitlab' : 'manual');
  return `<form data-form="configure-repositories"><input type="hidden" name="expectedRevision" value="${esc(connection?.revision ?? '')}"><fieldset data-mode-cards><legend>你希望同步什么？（必选）</legend><div class="mode-cards">${[
    ['version', '按版本更新', '选择 tag，保留内部文件，创建一个同步 PR；不搬运 Issue。'],
    ['continuous', '同步开发过程', '逐笔搬运 PR / 主干提交、Issue 和提交映射；人工合入后自动继续。'],
  ]
    .map(
      ([value, label, help]) =>
        `<label class="mode-card"><input type="radio" name="mode" required value="${value}" data-mode-card="${value}" ${config?.mode === value ? 'checked' : ''}><span><b>${label}</b><small>${help}</small></span></label>`,
    )
    .join(
      '',
    )}</div></fieldset><h3>A · 仓库地址与分支</h3>${repositoryFields(config, esc)}<button type="button" data-next-auth>下一步：配置认证与自动化 →</button><details class="connection-auth" data-connection-auth data-persist-details="connection-auth" ${config ? 'open' : ''}><summary>B · 认证与自动化（保存前填写）</summary><p>本次填写尚未重新验证；填写必要认证后，点击“保存并检查连接”读取两侧仓库。</p><dl class="auth-channels"><div><dt>本机 Git 登录</dt><dd>读取与推送代码 · HTTPS 凭据管理器或 SSH</dd></div><div><dt>GitHub Token</dt><dd>读取来源 PR / Issue · 开发过程模式需要</dd></div><div><dt>内部平台 Token</dt><dd>创建 PR、搬运 Issue 与关单 · 接口自动化需要</dd></div></dl>${sourceAuthenticationFields()}<section class="internal-automation"><h3>内部对象自动化</h3>${prCreationFields(config)}${issueFields({ ...config, mode: config?.mode ?? 'version', issueAutomation: { mode: defaultIssueMode } }, esc)}</section><section data-closure ${config?.mode === 'continuous' ? '' : 'hidden'}><details><summary>首次接收条件：提交消息关单规则</summary>${closureInstructions()}<label><input type="checkbox" name="commitClosureVerified" ${config?.commitClosureVerified ? 'checked' : ''}>已在独立测试仓验证，或管理员已验证禁用提交消息关单</label><p>未确认可继续配置；首次发布会暂停在此条件。</p></details></section><details class="identity-advanced"><summary>提交身份（可选 · 默认保留上游身份）</summary>${commitFields(config, esc)}</details><details data-policy><summary>内部保留范围（下一步可从文件树选择）</summary>${fileRuleFields(config?.internalPaths)}</details><p>代码通过本机 Git 凭据访问；API Token 不替代 Git 登录。仅检查连接，不创建 Issue / PR，不推送 main。</p><button class="primary" type="submit">保存并检查连接 →</button></details></form>`;
}
export function repositorySummary(config, esc) {
  return `<div class="split"><div><small>外部来源 · ${esc(config.sourceBranch)}</small><code>${esc(config.sourceUrl)}</code></div><div><small>内部接收 · ${esc(config.targetBranch)}</small><code>${esc(config.internalUrl)}</code></div></div><p class="note-line">${config.mode === 'version' ? '按版本更新 · 一个同步 PR' : '同步开发过程 · 逐笔接收'} · 保留内部：${esc((config.internalPaths ?? []).join('、') || '无')}</p>`;
}
function checkList(checks, esc) {
  if (!checks.length) return '';
  const mark = { RUNNING: '●', DONE: '✓', FAILED: '×' };
  return `<section class="card" data-connection-checks><h3>仓库已保存 · 只读连接检查</h3><ol>${checks.map((item) => `<li class="${item.status === 'FAILED' ? 'bad' : ''}">${mark[item.status]} ${esc(item.label)}<p>${esc(item.message)}</p></li>`).join('')}</ol><p>读取通过不证明推送或平台写权限已通过。</p></section>`;
}
function reportPanel(report, snapshot, esc) {
  if (!report) return '';
  return `<section id="baseline-differences" data-upstream="${esc(report.upstream)}" data-internal="${esc(report.internal)}" data-saved-rules="${esc(JSON.stringify(snapshot.config?.internalPaths ?? []))}"><h3>${report.valid ? '✓ 核心文件一致' : '× 文件差异待处理'}</h3><p>完整清单 ${report.files.length} 个文件。选择“保留内部”会跳过该路径的全部外部更新；目录也覆盖未来新增文件。</p><div class="baseline-review-layout"><div class="baseline-selection">${fileTree(report.files, '两侧文件与保留范围', { rules: snapshot.connection?.editable ?? !snapshot.state })}<section class="rule-review"><h4 data-rule-state>内部保留规则 · 已保存</h4><div data-selected-rules></div><p data-rule-count></p><button type="button" data-save-file-rules>应用选择并重新核验</button><p data-rule-feedback role="status"></p></section></div><details class="baseline-viewer"><summary>查看具体文件的两侧内容</summary><label>文件路径<select data-baseline-path>${report.files.map((item) => `<option value="${esc(item.path)}">${esc(item.path)}</option>`).join('')}</select></label><button type="button" data-baseline-read data-upstream="${esc(report.upstream)}" data-internal="${esc(report.internal)}">查看两侧文件内容</button><div id="baseline-file-content"></div></details></div>${report.valid ? '<button type="button" data-confirm-baseline class="primary">继续确认启用 →</button>' : '<p class="bad">请明确保留内部文件，或通过内部修复 PR 对齐核心内容，再重新核验。</p>'}</section>`;
}
function storageDetails({ connection }, esc) {
  if (!connection) return '';
  return `<details class="card setup-storage"><summary>本机保存位置与认证说明</summary><p>配置文件：<code>${esc(connection.configurationFile)}</code><br>台账：<code>${esc(connection.stateDir ?? '保存仓库后生成')}</code></p><p>直接输入 Token 仅在服务进程内存；刷新和关闭浏览器不清除，服务重启需重新提供。不写浏览器草稿、配置或历史。重启沿用同一私有配置。</p></details>`;
}
