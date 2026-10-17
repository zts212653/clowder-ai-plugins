import { closureInstructions } from './closure-settings.mjs';
import { commitFields } from './commit-settings.mjs';
import { apiFields } from './issue-settings.mjs';
import { esc, sha } from './ui.mjs';

const activeStatuses = new Set(['RUNNING', 'WAITING_REVIEW', 'PAUSED', 'FAILED']);

export function enabledSettings(snapshot) {
  const { config: c, state, connection } = snapshot;
  const project = snapshot.workspace?.projects?.find((p) => p.id === snapshot.workspace.currentId);
  const runActive = activeStatuses.has(state.automation?.status);
  const roundLocked = Boolean(state.active || state.queue?.length || runActive);
  const policyLocked = Boolean(state.active || runActive);
  const active = state.active;
  const apiFrozen = Boolean(
    roundLocked && (active?.candidate || active?.prUrl || active?.prCreation || state.issueAdapterId || state.queue?.length),
  );
  const identity = active?.commitPolicy;
  const issueMode = c.issueAutomation?.mode ?? (c.mode === 'version' ? 'manual' : 'gitlab');
  const platformAuthRequired = c.prTransport === 'gitlab' || issueMode === 'gitlab';
  const freezeReason = active
    ? '当前交付未完成，已经产生候选或平台对象，本笔必须继续使用原 PR 配置。'
    : state.queue?.length
      ? `本轮还有 ${state.queue.length} 笔待处理，PR 创建方式和平台接口保持不变。`
      : runActive
        ? '当前同步轮次尚未结束，恢复时必须继续使用原 PR 配置。'
        : '';
  return `<section class="settings-page"><div class="settings-heading"><h2>项目设置</h2><p>仓库绑定不可变；认证按本次服务管理；PR 配置按同步轮次冻结。</p><button type="button" data-view="workbench">${active ? '返回当前同步 →' : '进入同步工作台 →'}</button></div><form data-form="configure-project-settings" data-settings-form>
  <input type="hidden" name="expectedRevision" value="${esc(connection?.revision)}"><input type="hidden" name="expectedBinding" value="${esc(c.bindingId)}">
  <section class="settings-section"><h3>项目基本信息</h3>${project ? `<label>项目名称<input name="projectName" required maxlength="80" value="${esc(project.name)}"></label>` : ''}<p>同步模式：<b>${c.mode === 'version' ? '按版本更新' : '同步开发过程'}</b> · 仓库、模式和基线已启用后只读。</p></section>
  <section class="settings-section"><h3>仓库与接收位置</h3><div class="split"><div><b>外部 · ${esc(c.sourceBranch)}</b><code>${esc(c.sourceUrl)}</code></div><div><b>内部 · ${esc(c.targetBranch)}</b><code>${esc(c.internalUrl)}</code></div></div><p>初始对应 ${sha(state.initial.upstream)} → ${sha(state.initial.internal)}<br>当前接收 ${sha(state.accepted.upstream)} → ${sha(state.accepted.internal)}</p><p>内部保留：${esc(c.internalPaths?.join('、') || '无')} · 本绑定规则已冻结</p></section>
  <section class="settings-section"><h3>认证与平台自动化</h3>${freezeReason ? `<p class="settings-lock"><span aria-hidden="true">🔒</span> ${esc(freezeReason)} 完成本轮后可修改下一轮配置。</p>` : '<p>本轮尚未开始或已经完成；现在修改只影响下一轮。</p>'}${apiFrozen ? '<details class="frozen-api" open><summary>查看本轮已冻结的平台接口配置</summary>' : ''}<fieldset ${apiFrozen ? 'disabled' : ''}><label>PR 创建方式<select name="prMode"><option value="gitlab" ${c.prTransport === 'gitlab' ? 'selected' : ''}>平台 API 自动创建 PR</option><option value="manual" ${c.prTransport === 'manual' ? 'selected' : ''}>明确使用手工创建 PR</option>${!['gitlab', 'manual'].includes(c.prTransport) ? `<option value="${esc(c.prTransport)}" selected>旧创建方式：${esc(c.prTransport)}（保留兼容）</option>` : ''}</select></label><label>内部仓库网页地址<input name="internalWebUrl" type="url" ${c.prTransport === 'manual' ? '' : 'required'} value="${esc(c.internalWebUrl ?? '')}"></label>${c.mode === 'continuous' ? issueModeField(issueMode) : ''}${apiFields({ ...c, prTransport: c.prTransport, issueAutomation: { mode: issueMode }, hideToken: true }, esc)}</fieldset>${apiFrozen ? '</details>' : ''}
  <div class="auth-panels"><section id="issue-auth" data-auth-panel="issue" data-platform-auth ${platformAuthRequired ? '' : 'hidden'}><h4>内部平台认证</h4>${authState(snapshot.config.platformApi?.authentication, '内部平台') }<p>接收地址 <code>${esc(c.platformApi?.apiUrl ?? '从仓库链接推导')}</code> · 项目 <code>${esc(c.platformApi?.projectId ?? '待配置')}</code></p><label>内部平台 Token<input type="password" name="issueToken" autocomplete="off" placeholder="只在本次服务内存，不回显"></label><small>服务重启后直接输入的 Token 会清空；环境变量认证可跨重启保留。</small><div class="token-actions"><button type="button" data-auth-provide="issue">保存 Token 到本次服务</button><button type="button" data-issue-check data-auth-verify="issue">只读验证内部接口</button><button type="button" data-clear-secret="issueToken">清空输入框</button></div><p data-auth-feedback role="status"></p></section>
  ${c.mode === 'continuous' ? `<section id="github-source-auth" data-auth-panel="github"><h4>GitHub 读取认证</h4>${authState(snapshot.sourceAuthentication, 'GitHub 读取') }<p>用于读取来源 PR、Issue 和关闭关联；不用于 Git 代码登录。</p><label>GitHub 读取 Token<input name="githubToken" type="password" autocomplete="off" placeholder="只在本次服务内存，不回显"></label><small>服务重启后直接输入的 Token 会清空；也可使用 GH_TOKEN / GITHUB_TOKEN 环境变量。</small><div class="token-actions"><button type="button" data-auth-provide="github">保存 Token 到本次服务</button><button type="button" data-github-check data-auth-verify="github">只读验证 GitHub 连接</button><button type="button" data-clear-secret="githubToken">清空输入框</button></div><p data-github-feedback role="status"></p></section>` : ''}</div>${platformAuthRequired ? '' : '<p class="manual-platform-note" data-manual-platform-note>当前为手工 PR / Issue 登记，不需要内部平台 API Token；代码仍使用本机 Git 凭据，创建和审核 PR 时在内部平台完成。</p>'}</section>
  <section class="settings-section"><h3>提交与接收策略</h3>${identity ? `<details class="tech"><summary>为什么？</summary><div class="tech-copy class="settings-lock"">本笔冻结：${identity.strategy === 'rewrite' ? '统一内部身份' : '保留上游身份'} · ${esc(identity.identity?.name ?? c.receivingIdentity?.name)} &lt;${esc(identity.identity?.email ?? c.receivingIdentity?.email)}&gt;</div></details>` : policyLocked ? '<p class="settings-lock">当前同步已启动；提交处理方式将在本轮完成后可修改。</p>' : state.queue?.length ? '<p>目标已选定，但同步尚未启动；提交处理方式现在仍可调整，点击开始同步后才冻结。</p>' : ''}<fieldset ${policyLocked ? 'disabled' : ''}>${commitFields(c, esc)}</fieldset>${policyLocked ? '<p>当前轮次未结束；身份策略在本轮完成后可修改。</p>' : ''}<details><summary>高级等待策略</summary><label>自动合入等待时限（分钟）<input name="autoMergeWaitMinutes" type="number" min="1" max="1440" value="${Math.round((c.autoMergeWaitMs ?? 1800000) / 60000)}"></label></details>${c.mode === 'continuous' ? `<label><input name="commitClosureVerified" type="checkbox" ${c.commitClosureVerified ? 'checked disabled' : ''}>已确认平台不会按搬入提交消息误关内部同号 Issue</label><small>该项只确认平台关单规则，不授予自动合入权限。</small><details><summary>如何确认？查看一次性的测试步骤</summary>${closureInstructions()}</details>` : ''}</section>
  <section class="settings-result" data-settings-result role="status" tabindex="-1"></section><div class="settings-save"><button type="submit" class="primary">保存设置并验证 →</button><p>只保存非敏感配置；Token 必须在各自输入框下单独保存和验证，不会开始新的同步。</p></div></form><div id="error-slot"></div></section>`;
}

function issueModeField(mode) {
  return `<label data-issue-selection>Issue 创建与关单方式<select name="issueMode"><option value="manual" ${mode === 'manual' ? 'selected' : ''}>人工创建与状态登记</option><option value="gitlab" ${mode === 'gitlab' ? 'selected' : ''}>CodeHub / GitLab v4 兼容接口自动处理</option></select></label>`;
}

function authState(auth, label) {
  const state = auth?.available ? (auth.verified ? 'verified' : 'provided') : 'missing';
  const text = auth?.available
    ? auth.verified
      ? `${label}认证已验证`
      : `${label}认证已提供，尚未验证`
    : `${label}认证未提供；服务重启后需要重新输入`;
  return `<p class="auth-state auth-${state}" data-auth-status="${state}"><span aria-hidden="true">${state === 'verified' ? '✓' : state === 'provided' ? '!' : '×'}</span> <b>${text}</b>${auth?.source === 'environment' ? ' · 环境变量' : ''}</p>`;
}
