import { platformSettings } from './platform.mjs';
import { shortSha } from './ui.mjs';

const verification = {
  adapter: '平台适配器已回读核验',
  'git-receipt': 'Git 创建回执与候选 ref 已核验；未调用平台 API',
  operator: '操作者登记；尚未通过平台接口核验',
};
function referenceForm(delivery, esc) {
  const existing = delivery.prUrl;
  return `<form data-form="pr" data-edit-baseline="${esc(JSON.stringify([delivery.candidate, delivery.branch, delivery.status]))}"><input name="deliveryId" type="hidden" value="${esc(delivery.id)}"><input name="previousUrl" type="hidden" value="${esc(existing ?? '')}"><label>内部 PR 具体链接<input name="url" type="url" required value="${esc(existing ?? '')}" placeholder="已创建 PR 的具体页面地址"></label><p>不能填仓库首页或外部来源 PR。无平台查询能力时记录你的确认，不声称验证网页存在性。</p><label><input type="checkbox" required data-pr-confirm data-confirmation-key="pr-reference">我已在内部平台找到该 PR，并核对来源分支、目标分支和候选 commit</label><button type="submit" class="primary">${existing ? '保存纠正后的 PR 链接' : '登记 PR，进入审核'}</button></form>`;
}
function withdrawalForm(delivery, esc) {
  return `<form data-form="clear-pr" data-edit-baseline="${esc(JSON.stringify([delivery.candidate, delivery.branch, delivery.status]))}"><input name="deliveryId" type="hidden" value="${esc(delivery.id)}"><input name="previousUrl" type="hidden" value="${esc(delivery.prUrl)}"><label><input type="checkbox" required data-confirmation-key="clear-pr">我确认只撤销本机引用，平台 PR 与候选分支继续保留</label><button type="submit">撤销错误引用，返回 PR 创建步骤</button></form><p>仅在内部 main 未变化、候选未被改写时允许。已合入后先核验原交付，不能重置。</p>`;
}
function referenceDetails(delivery, esc) {
  const note = verification[delivery.prReference?.verifiedBy] ?? verification.operator;
  return `<p><a href="${esc(delivery.prUrl)}" target="_blank" rel="noopener">查看已登记 PR ↗</a> · ${note}</p><details><summary>链接填错了？纠正或撤销引用</summary>${referenceForm(delivery, esc)}${withdrawalForm(delivery, esc)}</details>`;
}
function header(snapshot, esc) {
  const delivery = snapshot.state.active;
  return `<p>来源分支：<code>${esc(delivery.branch)}</code><br>目标分支：<code>${esc(snapshot.config.targetBranch)}</code><br>候选 commit：${shortSha(delivery.candidate)}</p>`;
}
function automaticPending(snapshot, esc) {
  const delivery = snapshot.state.active;
  if (delivery.prReference?.withdrawn)
    return `<section class="card" id="pr-form"><h3>登记核对后的 PR 引用</h3>${header(snapshot, esc)}<p>原引用已由你撤销，系统不会重新登记旧回执或创建第二个 PR。先核对平台中已经创建的具体 PR、分支与候选，再补登记正确链接。</p>${referenceForm(delivery, esc)}</section>`;
  const git = snapshot.platform.transport === 'git';
  const receiptMissing = [
    'GIT_PR_LINK_UNKNOWN',
    'GIT_PR_RESPONSE_AMBIGUOUS',
    'PR_CREATE_RESULT_UNKNOWN',
  ].includes(delivery.error?.code);
  const remedy = receiptMissing
    ? `<details><summary>平台已创建但回执丢失？补登记原 PR 地址</summary>${referenceForm(delivery, esc)}<p>只补充已创建对象的引用，不重新手工创建 PR。</p></details>`
    : '';
  return `<section class="card" id="pr-form"><h3>自动创建内部 PR</h3>${header(snapshot, esc)}<p>${git ? '推送通过 Git 创建扩展自动取得 PR 地址。错误时先核验原候选与回执，不重复创建。' : '使用已配置的平台适配器查询/创建并回读 PR。'}</p><button type="button" data-action="create-pr">${delivery.gitPr ? '核验原 Git 创建回执' : '继续自动创建 PR'}</button>${remedy}</section>`;
}
function manualInstructions(snapshot, esc) {
  const link = snapshot.platform?.repositoryUrl
    ? `<p><a class="button" href="${esc(snapshot.platform.repositoryUrl)}" target="_blank" rel="noopener">打开内部仓库，创建 PR ↗</a></p>`
    : '';
  return `<p><b>当前明确使用手工创建模式。</b>Git 已推送候选分支，尚未创建平台 PR。先在内部平台创建，再登记链接；可在仓库设置启用 Git 自动创建。</p>${link}`;
}
export function prPanel(snapshot, esc) {
  const delivery = snapshot.state.active;
  if (!['PR_REQUIRED', 'WAITING_APPROVAL'].includes(delivery.status)) return '';
  if (!snapshot.platform?.repositoryUrl && snapshot.connection)
    return `<section class="card bad" id="pr-form"><h3>先配置内部仓库网页地址</h3><details class="tech"><summary>说明</summary><div class="tech-copy">SSH 克隆地址用于传输 Git，网页地址用于核对 PR / MR 链接；两者的域名和端口可以不同。填写 HTTPS 仓库首页后继续，原候选和基线保留。已有手工引用时保持原创建方式，网页地址须包含该引用；错误引用可先撤销。</div></details>${platformSettings(snapshot, esc)}${delivery.prUrl ? withdrawalForm(delivery, esc) : ''}</section>`;
  const automatic = snapshot.platform?.prMode === 'automatic';
  if (automatic && !delivery.prUrl) return automaticPending(snapshot, esc);
  const title = delivery.prUrl ? '内部 PR 与引用纠错' : '在内部平台创建 PR';
  const created =
    snapshot.platform?.transport === 'git'
      ? 'Git 创建回执已取得，候选 ref 已核验'
      : '平台适配器已创建并回读 PR';
  const explanation = automatic
    ? `<p>${created}。现在只需在平台审核合入。</p>`
    : manualInstructions(snapshot, esc);
  const template = snapshot.state.templates;
  return `<section class="card" id="pr-form"><h3>${title}</h3>${header(snapshot, esc)}${explanation}<details><summary>复制 PR 标题与正文</summary><p><b>${esc(template.title)}</b></p><pre class="bounded-text">${esc(template.body)}</pre></details>${delivery.prUrl ? referenceDetails(delivery, esc) : referenceForm(delivery, esc)}</section>`;
}
