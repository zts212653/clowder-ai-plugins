import { defaultBinding } from './binding.mjs';
import { COMPLETE } from './data.mjs';
import { escapeHtml } from './html.mjs';
import { renderIdentity } from './render-delivery.mjs';

function input(draft, name, label, hint, placeholder = '') {
  return `<label class="config-field" for="config-${name}"><span>${label}</span><input id="config-${name}" name="${name}" value="${escapeHtml(draft[name] ?? '')}" placeholder="${placeholder}" autocomplete="off" spellcheck="false"><small>${hint}</small></label>`;
}
export function bindingSummary(binding) {
  if (binding.status !== 'ready') return '';
  const repo = binding.externalUrl
    .replace(/\.git$/, '')
    .split(/[/:]/)
    .slice(-2)
    .join(' / ');
  const internalRepo = binding.internalUrl
    .replace(/\.git$/, '')
    .split(/[/:]/)
    .slice(-2)
    .join(' / ');
  return `<div class="connection-line"><span>GitHub ${escapeHtml(repo)} · ${escapeHtml(binding.sourceBranch)} <b>→</b> 内部 ${escapeHtml(internalRepo)} · ${escapeHtml(binding.targetBranch)}</span><button type="button" class="text-button" data-view="configuration">仓库设置</button></div>`;
}
function facts(draft) {
  const adopt = draft.mode === 'adopt';
  return `<dl class="connection-facts"><div><dt>外部 GitHub</dt><dd>${escapeHtml(draft.externalUrl)}<br>分支 ${escapeHtml(draft.sourceBranch)}</dd></div><div><dt>内部 Git</dt><dd>${escapeHtml(draft.internalUrl)}<br>合入分支 ${escapeHtml(draft.targetBranch)}</dd></div><div><dt>${adopt ? '已同步的外部基线 A' : '新仓初始化上游版本'}</dt><dd><code>${escapeHtml(draft.baseline)}</code></dd></div><div><dt>${adopt ? '对应的内部现有 commit B' : '内部初始化方式'}</dt><dd>${adopt ? `<code>${escapeHtml(draft.internalBaseline)}</code>` : draft.mode === 'snapshot' ? '创建独立快照' : '保留上游历史'}</dd></div></dl>${adopt ? `<div class="baseline-pair"><strong>外部 A ↔ 内部 B：登记已有同步基线</strong><p>保留内部当前版本，后续只接收 A 之后的交付。本演示预置 20 个提交，分属 4 个已合入 PR；真实数量须由程序读取仓库后发现。</p></div>` : ''}`;
}
function errors(ui) {
  return ui.errors.length
    ? `<div id="wizard-error" class="notice danger" role="alert"><ul>${ui.errors.map((error) => `<li>${escapeHtml(error)}</li>`).join('')}</ul></div>`
    : '';
}
function advanced(draft) {
  return `<details class="wizard-advanced"><summary>更多连接选项（通常无需修改）</summary>${input(draft, 'internalWebUrl', '内部仓库网页地址（可选）', 'PR 的具体 URL 由平台适配器返回。')}
    <label class="config-field" for="config-adapter"><span>Issue / PR 命令适配</span><select id="config-adapter" name="adapter"><option value="codehub-cli" ${draft.adapter === 'codehub-cli' ? 'selected' : ''}>codehub-cli</option><option value="platform-cli" ${draft.adapter === 'platform-cli' ? 'selected' : ''}>其他平台 CLI（待接入）</option></select><small>Git Bash 负责代码；平台 CLI 负责 Issue / PR。</small></label></details>`;
}
function connectionStep(draft) {
  const example = defaultBinding();
  const usingExample = draft.externalUrl === example.externalUrl && draft.internalUrl === example.internalUrl;
  return `<div class="demo-config"><p><strong>${usingExample ? '示例仓库已填入，可直接点击下一步。' : '仓库地址仅用于演示展示。'}</strong><span>无需登录或填写凭据，不会访问任何仓库。</span></p><button type="button" id="example-binding" class="text-button">填入示例仓库</button></div><div class="wizard-grid"><section class="wizard-section"><h3>外部：从这里接收更新</h3>${input(draft, 'externalUrl', 'GitHub 仓库地址', '支持 HTTPS 或 SSH，地址中不要携带凭据。', '请输入 GitHub 仓库地址')}${input(draft, 'sourceBranch', '外部交付分支', '通常使用 main。')}</section><section class="wizard-section"><h3>内部：在这里审核与合入</h3>${input(draft, 'internalUrl', '内部 Git 仓库地址', '演示候选分支推送与内部 PR 创建，不执行实际操作。', '请输入内部 Git 仓库地址')}${input(draft, 'targetBranch', '内部合入分支', '同步 PR 将请求合入这个分支。')}</section></div>${advanced(draft)}`;
}
function baselineStep(draft) {
  const adopt = draft.mode === 'adopt';
  const modes = [
    [
      'adopt',
      '已有内部仓：继续同步',
      '登记上次已同步的版本对应，保留现有内部分支。适合“从 A 同步过一次，之后落后 20 个提交”。',
    ],
    ['snapshot', '新建内部仓：独立快照', '仅适用于空内部仓，从指定上游版本建立新的内部初始提交。'],
    ['history', '新建内部仓：保留上游历史', '仅适用于空内部仓，沿用指定上游版本的提交历史。'],
  ];
  return `<fieldset class="init-modes"><legend>你要接管已有仓库，还是创建新仓库？</legend>${modes.map(([mode, title, hint]) => `<label><input type="radio" name="mode" value="${mode}" ${draft.mode === mode ? 'checked' : ''}><span><strong>${title}</strong><small>${hint}</small></span></label>`).join('')}</fieldset><div class="${adopt ? 'wizard-grid' : ''}">${input(draft, 'baseline', adopt ? '上次已同步的外部 commit A' : '从哪个上游 commit 初始化', adopt ? '填写已经同步完成的外部版本，不填写最新版本。示例 A = a17e9b40。' : '预填演示版本，可替换为 7–40 位 commit ID。')}${adopt ? input(draft, 'internalBaseline', '对应的内部现有 commit B', '填写当前内部合入分支的 commit。保留历史时可与 A 相同；独立快照时 ID 可以不同。') : ''}</div>${adopt ? '<div class="baseline-pair"><strong>需要确认：外部 A ↔ 内部 B</strong><p>程序将核对 B 是内部当前版本，并比较 A、B 的核心文件树。通过后登记基线，再接收 A 之后的更新。</p></div>' : ''}`;
}
function baselineReport(ui, saved) {
  const report = ui.baselineCheck;
  return `${report ? `<div id="baseline-check" class="notice"><strong>两侧基线核验（模拟结果）</strong><ul>${report.checks.map((item) => `<li class="${item.passed ? 'good-text' : 'bad-text'}">${item.passed ? '✓' : '✕'} ${escapeHtml(item.label)}</li>`).join('')}</ul></div>` : ''}${
    saved
      ? ''
      : `<details class="wizard-advanced"><summary>切换演示核验结果</summary><label class="config-field" for="demo-baseline-outcome"><span>仅控制模拟结果，不读取仓库</span><select id="demo-baseline-outcome">${[
          ['match', '基线一致'],
          ['tree-mismatch', '核心文件树不一致'],
          ['head-moved', '内部分支已前进，B 不再是 HEAD'],
        ]
          .map(
            ([value, label]) => `<option value="${value}" ${ui.outcome === value ? 'selected' : ''}>${label}</option>`,
          )
          .join('')}</select></label></details>`
  }`;
}
function finalStep(state, ui) {
  const saved = state.binding.status === 'saved' && JSON.stringify(ui.draft) === JSON.stringify(state.binding);
  const checked = ui.checked === JSON.stringify(ui.draft);
  const adopt = ui.draft.mode === 'adopt';
  const status = saved
    ? '配置已保存，还差启用'
    : checked
      ? adopt
        ? '模拟基线核验通过'
        : '本地格式检查通过'
      : '确认配置，再检查并启用';
  return `${facts(ui.draft)}${adopt ? baselineReport(ui, saved) : ''}<div id="config-result" class="notice ${saved || checked ? 'success' : ''}" role="status"><strong>${status}</strong><p>真实连接、权限和版本核验尚未接入；下面的操作只演示状态变化。</p></div><div class="wizard-actions"><button type="button" id="previous-binding" class="button secondary">← 上一步</button>${saved ? `<button type="button" id="initialize-binding" class="button primary">${adopt ? '登记已有基线并启用（模拟）→' : '模拟初始化并开始使用 →'}</button>` : checked ? '<div><button type="button" id="check-binding" class="text-button">重新检查</button> <button type="button" id="save-binding" class="button primary">保存连接 →</button></div>' : '<button type="button" id="check-binding" class="button primary">检查配置（模拟）→</button>'}</div>`;
}
function readonlyBinding(state, ui) {
  const locked = state.active && state.active.phase < COMPLETE;
  return `<section class="panel config-readonly"><span class="badge good">${state.binding.mode === 'adopt' ? '已有仓接管已启用（演示）' : '演示连接已初始化'}</span><h2>当前仓库连接</h2><p>下面保留首次接管 / 初始化的版本对应。已接受上游：<code>${escapeHtml(state.accepted)}</code>；内部当前 HEAD：<code>${escapeHtml(state.internalSha)}</code>。核验通过后才登记新的成功对应，后续从已接受上游版本继续接收。</p>${facts(state.binding)}${errors(ui)}${locked ? '<div id="binding-lock" class="notice">当前有未完成同步，完成前不能更换仓库、分支或起始版本。</div>' : ''}<div class="wizard-actions">${locked ? '<button type="button" class="button primary" data-view="overview">返回当前同步 →</button><button type="button" id="edit-binding" class="button secondary" disabled>同步完成后可修改</button>' : '<button type="button" class="button secondary" data-view="overview">← 返回工作台</button><button type="button" id="edit-binding" class="button primary">修改仓库连接 →</button>'}</div><details class="wizard-advanced"><summary>查看命令适配与命名规则</summary><p>Issue / PR 命令适配：${escapeHtml(state.binding.adapter)}。演示无需认证，命令不实际执行。</p>${renderIdentity(state.active ?? state.deliveries[0], state.binding, 0)}</details></section>`;
}
export function renderBinding(state, ui) {
  if (!ui.editing) return readonlyBinding(state, ui);
  const labels = ['连接仓库', '确认同步基线', '检查并启用'];
  const descriptions = [
    '保留示例地址或填写自己的地址，下一步确认内外版本对应。',
    '两个仓库已经存在时，登记上次已同步的外部 A 与当前内部 B。',
    '核验两侧基线，保存后登记对应关系并启用同步。',
  ];
  const body = ui.step === 1 ? connectionStep(ui.draft) : ui.step === 2 ? baselineStep(ui.draft) : finalStep(state, ui);
  return `<ol class="setup-steps" aria-label="配置进度">${labels.map((label, index) => `<li class="${index + 1 <= ui.step ? 'done' : ''}"><b>${index + 1}</b>${label}</li>`).join('')}</ol><form id="binding-form" class="panel wizard-panel" novalidate><span class="eyebrow">第 ${ui.step} / 3 步 · 演示配置</span><h2>${labels[ui.step - 1]}</h2><p>${descriptions[ui.step - 1]}</p>${errors(ui)}${body}${ui.step < 3 ? `<div class="wizard-actions">${ui.step > 1 ? '<button type="button" id="previous-binding" class="button secondary">← 上一步</button>' : '<button type="button" class="text-button" data-view="overview">暂时返回工作台</button>'}<button type="button" id="next-binding" class="button primary">${ui.step === 1 ? '下一步：确认同步基线 →' : '下一步：检查配置 →'}</button></div>` : ''}${state.binding.status === 'ready' ? '<button type="button" id="cancel-binding" class="text-button">取消修改，保留当前连接</button>' : ''}</form>`;
}
