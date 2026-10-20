import { githubAuthForm } from './github-auth.mjs';
import { authenticationForm } from './issue-auth.mjs';
import { esc, sha } from './ui.mjs';

const held = (snapshot) => ['IMPORTED', 'EXPORTED'].includes(snapshot.transfer?.status);
export { held as transferHeld };

export function transferView(snapshot, local) {
  const transfer = snapshot.transfer,
    busy = local.busy;
  const feedback = `<p data-transfer-feedback role="status" aria-live="polite" ${local.error ? 'class="bad"' : ''}>${esc(local.error || local.message || '')}</p>${registrationRecovery(local)}`;
  const open = local.open || held(snapshot) || transfer?.status === 'ACTIVE';
  return `<details class="card transfer-settings" id="transfer-settings" aria-label="配置与同步进度迁移" aria-busy="${Boolean(busy)}" ${open ? 'open' : ''}><summary>导入 / 导出配置与同步进度</summary><div class="transfer-body"><h2>配置与同步进度迁移</h2><p>配置模板用于复用设置；完整迁移包用于接续已有同步。接收人重新提供自己的认证，不覆盖现有项目。</p>${held(snapshot) ? heldView(snapshot, local, feedback) : `${transferTools(snapshot, local)}${feedback}`}</div></details>`;
}

export function transferBanner(snapshot) {
  if (!held(snapshot)) return '';
  return `<section class="card task" id="transfer-hold" role="status"><h2>${snapshot.transfer.status === 'EXPORTED' ? '此项目已冻结，等待移交确认' : '迁移项目尚未启用'}</h2><p>历史和对象映射已保留。先在设置补充认证并检查环境，明确确认后才能继续原同步；当前不会创建 Issue 或 PR。</p><button type="button" class="primary" data-view="configuration">前往迁移检查与认证 →</button></section>`;
}

function transferTools(snapshot, local) {
  const disabled = snapshot.config ? '' : 'disabled data-preserve-disabled';
  const frozen = local.kind === 'migration';
  return `${snapshot.transfer?.status === 'ACTIVE' ? '<p class="good">迁移已启用；没有自动启动下一笔同步。</p><button type="button" data-view="workbench">回到工作台继续原同步 →</button>' : ''}<div class="transfer-columns"><section><h3>导出当前项目</h3><label>导出内容<select data-transfer-kind><option value="template" ${!frozen ? 'selected' : ''}>无凭据配置模板</option><option value="migration" ${frozen ? 'selected' : ''}>完整迁移包（含同步进度）</option></select></label><p class="note-line" data-transfer-export-note>${frozen ? '包含台账、历史、SHA / Issue / PR 映射和 Git 对象。导出将冻结此源项目并暂停推进；请在当前任务结束后操作。' : '只包含仓库、分支、同步模式与规则；不包含已有基线、历史或同步进度。'}</p><p>两种文件都不携带认证。完整包包含仓库地址、历史和代码，请通过私有通道传递。</p><button type="button" data-transfer-export ${disabled}>${frozen ? '冻结项目并导出完整迁移包' : '导出无凭据配置模板'}</button>${!snapshot.config ? '<small>当前项目尚未配置，可直接从右侧导入已有文件。</small>' : ''}</section><section><h3>导入到此工作台</h3><form data-transfer-upload><label>选择配置模板或完整迁移包<input type="file" accept="application/json,.json" data-transfer-file required></label><small>最大 128 MiB；只读取并检查内容，不执行文件中的命令。</small><button type="submit">读取并检查文件</button></form>${local.preview ? previewView(local) : ''}</section></div>`;
}

function previewView(local) {
  const summary = local.preview;
  return `<section class="transfer-preview" aria-label="导入文件预览"><h4>${summary.kind === 'migration' ? '完整迁移包' : '无凭据配置模板'} · 文件已校验</h4>${summaryView(summary)}<p>导入会新增独立项目；同一包重试会返回已导入项目，不会再建一份。</p><form data-transfer-import><label>导入后的项目名称<input name="transferName" required maxlength="80" ${local.pendingImport ? 'readonly' : ''} value="${esc(local.name || summary.name)}"></label><button type="submit" class="primary">${local.pendingImport ? '重试原导入（保持同一包）' : '导入为独立项目'}</button></form></section>`;
}

function registrationRecovery(local) {
  if (!local.pendingImport || !local.recoveryRequired) return '';
  return `<details data-transfer-registration><summary>导入登记被中断？</summary><p>仅恢复项目登记配置锁，不处理同步 writer.lock，不删除暂存包、历史或映射。旧服务仍运行时不能恢复。</p><label><input type="checkbox" data-transfer-recovery-confirm ${local.recoveryConfirmed ? 'checked' : ''}>已确认旧服务及其 Git / 检查子进程全部退出</label><button type="button" data-transfer-recover ${local.recoveryConfirmed ? '' : 'disabled data-preserve-disabled'}>恢复项目登记锁</button></details>`;
}

function heldView(snapshot, local, feedback) {
  const transfer = snapshot.transfer,
    source = transfer.status === 'EXPORTED';
  const checks = transfer.checks ?? [],
    passed = checks.length > 0 && checks.every((check) => check.status === 'PASSED');
  const authActions = `${snapshot.config?.mode === 'continuous' ? '<button type="button" data-transfer-auth="github">GitHub 认证</button>' : ''}${snapshot.config?.platformApi?.mode === 'gitlab' || snapshot.config?.issueAutomation?.mode === 'gitlab' ? '<button type="button" data-transfer-auth="platform">内部平台认证</button>' : ''}`;
  return `<section class="transfer-held"><span class="badge">${source ? '源项目已冻结' : '已导入 · 未启用'}</span><h3>${source ? '源环境已停止推进' : '完成迁移前核验'}</h3><details class="tech"><summary>说明</summary><div class="tech-copy">${source ? '将文件交给新环境后，请保持此项目冻结。仅在取消移交且新环境尚未启用或已经停止时，才确认恢复本环境。' : transfer.kind === 'template' ? '先核验新环境并确认启用，再继续登记已有同步起点。模板只复用设置，不携带原项目历史或进度。' : '补充你自己的认证，检查新路径与运行环境，再明确启用。既有历史、映射和待合入 PR 均保留；不会重新创建对象。'}</div></details><ol class="transfer-steps"><li><b>${authActions ? '补充本环境认证' : '准备本机 Git 认证（当前模式无需 API Token）'}</b>${authActions}<details class="transfer-auth"><summary>${authActions ? '认证详情与 Token 输入' : 'Git 访问准备说明'}</summary>${githubAuthForm(snapshot)}${authenticationForm(snapshot.config ?? {})}<p>Git 的 SSH 密钥或登录由本机 Git 管理，不在迁移包中；请先在本环境恢复对应 Git 访问。</p></details></li><li><b>核验运行环境与仓库绑定</b><button type="button" data-transfer-check>${checks.length ? '重新检查迁移条件' : '检查运行环境、仓库与认证'}</button><div class="transfer-checks" role="region" aria-label="迁移条件检查" tabindex="-1">${checksView(checks)}${feedback}</div></li><li><b>确认唯一执行环境，再明确启用</b><label class="transfer-confirm"><input type="checkbox" data-transfer-confirm ${local.confirmed ? 'checked' : ''}>${source ? '我确认新环境尚未启用或已停止，此接收分支只由本环境继续同步' : '我确认旧环境已停止推进，此接收分支只由本环境继续同步'}</label><button type="button" class="primary" data-transfer-activate ${passed && local.confirmed ? '' : 'disabled data-preserve-disabled'}>${source ? '原环境继续使用' : '确认启用此环境'}</button><p class="note-line">${transfer.kind === 'template' ? '模板启用后，继续核验并登记已有同步起点，才可开始同步。' : '启用只解除迁移暂停；不会自动启动下一笔同步。请回到工作台检查原进度后明确继续。'}</p></li></ol><details class="transfer-metadata"><summary>核对仓库、已接收位置与携带记录</summary>${summaryView(transfer.summary)}</details></section>`;
}

function summaryView(summary = {}) {
  const accepted = summary.accepted;
  return `<dl class="transfer-facts"><div><dt>外部来源</dt><dd>${esc(summary.sourceUrl)}<small>分支 ${esc(summary.sourceBranch)}</small></dd></div><div><dt>内部接收</dt><dd>${esc(summary.internalUrl)}<small>分支 ${esc(summary.targetBranch)}</small></dd></div><div><dt>同步范围</dt><dd>${summary.mode === 'continuous' ? '同步开发过程' : '按版本更新'}<small>内部保留：${esc(summary.internalPaths?.join('、') || '无')}</small></dd></div><div><dt>携带记录</dt><dd>历史 ${Number(summary.historyCount ?? 0)} 笔 · 执行记录 ${Number(summary.taskCount ?? 0)} 条 · Issue 映射 ${Number(summary.issueCount ?? 0)} 个</dd></div>${accepted ? `<div><dt>已接收位置</dt><dd>外部 ${sha(accepted.upstream)}<br>内部 ${sha(accepted.internal)}</dd></div>` : ''}${summary.active ? `<div><dt>当前同步</dt><dd>${esc(summary.active.status)}${summary.active.prUrl ? `<br><a href="${esc(safeWebUrl(summary.active.prUrl))}" target="_blank" rel="noreferrer">查看已有内部 PR ↗</a>` : ''}</dd></div>` : ''}</dl>`;
}

function checksView(checks) {
  if (!checks.length) return '<p>尚未检查；导入内容目前不会用于推进同步。</p>';
  return `<ul class="transfer-check-list">${checks.map((check) => `<li class="${check.status === 'PASSED' ? 'good' : 'bad'}"><b>${check.status === 'PASSED' ? '✓' : '×'} ${esc(check.label)}</b>${check.message ? `<p>${check.code ? `${esc(check.code)}：` : ''}${esc(check.message)}</p>` : ''}${check.status === 'FAILED' ? recovery(check) : ''}</li>`).join('')}</ul>`;
}

function recovery(check) {
  const key = `${check.key} ${check.code ?? ''}`.toLowerCase();
  if (/github|source.auth/.test(key))
    return '<button type="button" data-transfer-auth="github">提供 / 更新 GitHub 认证 →</button>';
  if (/issue|platform|token|auth/.test(key))
    return '<button type="button" data-transfer-auth="platform">提供 / 更新内部平台 Token →</button>';
  return '<p>处理以上原因后，点击“重新检查迁移条件”；原包、历史和映射保留。</p>';
}

function safeWebUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : '#';
  } catch {
    return '#';
  }
}
