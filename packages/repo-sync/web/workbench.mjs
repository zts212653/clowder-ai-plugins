import { nextAction } from './action-policy.mjs';
import { preDeliveryFlow } from './automation-view.mjs';
import { firstUse } from './connections.mjs';
import { boundaryDeliveryId } from './flow-stage.mjs';
import { issueReferenceNotes } from './issue-reference-notes.mjs';
import { sourceTargetForm } from './source-target.mjs';
import { button, esc, sha, title, when } from './ui.mjs';
import { tagSelector } from './version.mjs';
import { workflow } from './workflow.mjs';

export function workbench(snapshot, records, tags, _mobileDetail) {
  const { config, state } = snapshot;
  if (!config) return firstUse();
  if (!state)
    return `<section class="card task"><h2>先确认两侧已有基线</h2><p>连接已从私有配置载入，登记外部已同步版本与内部当前版本即可开始。</p><button type="button" data-view="configuration" class="primary">配置同步基线 →</button></section>`;
  const historical = records.selected !== 'current' && records.selected !== state.active?.id;
  const expectedId = state.active?.id ?? boundaryDeliveryId(state);
  const detailRecord = historical || records.detail?.delivery.id === expectedId ? records.detail : null;
  const delivery = detailRecord?.delivery ?? (historical ? null : state.active);
  const detail = records.error
    ? `<p class="record-gap bad" role="alert">× ${esc(records.error)}<br>记录读取失败，原选择保留，不用其他记录替代。</p><button type="button" data-reload-record>重新读取记录</button>`
    : delivery
      ? workflow(
          snapshot,
          detailRecord ?? {
            delivery,
            tasks: [],
            configurations: [],
            issues: [],
            events: [],
            missingTasks: [],
            taskPage: {},
          },
          historical,
        )
      : historical
        ? '<p role="status">正在读取所选记录…</p>'
        : target(snapshot, tags);
  return `${historical ? '<p>正在查看历史；当前轮次继续由后台处理，返回当前同步后才能操作。</p>' : ''}<p id="current-activity" role="status"></p><div class="journey-layout"><section class="record-detail" aria-label="本笔同步详情">${detail}</section></div>`;
}
function target(snapshot, tags) {
  const { state, config } = snapshot;
  const task = snapshot.operation;
  const pending =
    task &&
    (['RUNNING', 'CANCELLING', 'STOP_UNCONFIRMED'].includes(task.status) ||
      task.persistence?.status === 'FAILED');
  if (state.active)
    return workflow(snapshot, {
      delivery: state.active,
      tasks: [],
      configurations: [],
      issues: [],
      missingTasks: [],
      taskPage: {},
      events: [],
    }, false);
  if (snapshot.state.automation && snapshot.state.automation.status !== 'COMPLETE')
    return preDeliveryFlow(snapshot, nextAction(snapshot, null));
  if (pending)
    return preDeliveryFlow(snapshot, nextAction(snapshot, state.active ?? null));
  const accepted =
    state.deliveryCount > 0
      ? `<h3>当前已接收版本</h3><p class="note-line">${esc(state.accepted.tag ?? '已接收提交')} · 外部 ${sha(state.accepted.upstream)} → 内部 ${sha(state.accepted.internal)}</p>`
      : '';
  if (config.mode === 'version' && !state.queue.length)
    return `${accepted}${sourceBlock(config, state, tagSelector(tags, esc, sha, config.prTransport !== 'manual', state.accepted.upstream))}<div id="operation"></div><div id="error-slot"></div>`;
  const next = state.queue[0];
  const heading = targetHeading(state, config, next);
  const source =
    config.mode === 'continuous'
      ? `${githubAuthSummary(snapshot)}${sourceTargetForm(state, tags, esc, sha, config.prTransport !== 'manual')}`
      : '';
  return `${!state.queue.length ? targetHero(state, config) : ''}${accepted}${sourceBlock(config, state, source)}<section class="card task"><span class="badge">1 · 确认同步范围</span><h2>${heading}</h2><p class="note-line">${next ? '按已核对的范围发起本次同步，内部 main 等待正常平台合入。' : '先读取 GitHub PR、Issue 与实际 main 提交关系，按接受顺序逐笔处理。'}</p>${next ? `<p>外部 ${sha(state.accepted.upstream)} → ${sha(next.target)}<br>内部基线 ${sha(state.accepted.internal)}</p>${issueReferenceNotes(next.source)}${startButton(config, next)}` : ''}<div id="operation" tabindex="-1"></div><div id="error-slot"></div></section>`;
}

function sourceBlock(config, state, inner) {
  const open = !state.queue.length;
  const brief = `${config.mode === 'version' ? '按版本更新' : '同步开发过程'} · 外部 ${config.sourceBranch} → 内部 ${config.targetBranch} · ${state.queue.length} 笔待处理`;
  return `<details class="block-fold"${open ? ' open' : ''}><summary><b>同步来源与目标</b><span class="block-brief">${esc(brief)}</span></summary><div class="block-body">${repositorySummary(config, state)}${inner}</div></details>`;
}

function githubAuthSummary(snapshot) {
  const auth = snapshot.sourceAuthentication ?? {};
  const state = auth.available ? (auth.verified ? 'verified' : 'provided') : 'missing';
  const text = auth.available
    ? auth.verified
      ? 'GitHub 读取认证已验证'
      : 'GitHub Token 已提供，尚未验证'
    : 'GitHub Token 未提供；服务重启后需要重新输入';
  return `<section class="card auth-summary auth-${state}" aria-label="GitHub 读取认证状态"><p><span aria-hidden="true">${state === 'verified' ? '✓' : state === 'provided' ? '!' : '×'}</span> <b>${text}</b>${auth.source === 'environment' ? ' · 环境变量' : ''}</p>${state === 'verified' ? '<small>来源 PR、Issue 和关闭关联可以继续读取。</small>' : '<button type="button" data-view="configuration" data-auth-focus="github" class="primary">去仓库设置提供 / 验证 GitHub Token →</button>'}</section>`;
}

function repositorySummary(config, state) {
  const status = !state.scannedAt
    ? '尚未检查更新'
    : config.mode === 'version'
      ? state.accepted.upstream === state.latest
        ? '所选版本已接收'
        : '所选版本尚待接收'
      : state.syncTarget &&
          state.accepted.upstream === state.syncTarget.commit &&
          state.latest !== state.syncTarget.commit
        ? '已到达本轮目标；扫描时还有后续更新'
        : state.accepted.upstream === state.latest
          ? '与最近一次来源分支扫描一致'
          : '有未接收的扫描目标';
  return `<section class="repository-summary"><div><b>${esc(config.mode === 'version' ? '按版本更新' : '同步开发过程')}</b><p>已接受：${esc(state.accepted.tag ?? '已登记基线')}<br>外部 ${sha(state.accepted.upstream)} → 内部 ${sha(state.accepted.internal)}</p><small>外部来源 · ${esc(config.sourceBranch)}</small><code>${esc(config.sourceUrl)}</code><small>内部接收 · ${esc(config.targetBranch)}</small><code>${esc(config.internalUrl)}</code></div><div><b>${status}</b><p>最近读取 ${when(state.scannedAt)}<br>本轮/扫描目标 ${sha(state.syncTarget?.commit ?? state.latest)} · ${state.queue.length} 笔待处理</p><small>版本选择不代表整个来源分支已是最新。</small></div></section>`;
}

function targetHeading(state, config, next) {
  if (next)
    return config.mode === 'version'
      ? `已选择 ${esc(next.source.tag)}`
      : `下一笔${next.source.kind === 'commit' ? '' : '上游 '}${esc(title(next))}`;
  return state.deliveryCount ? '本轮交付已完成' : '读取上游交付清单';
}

function startButton(config, next) {
  const label =
    config.mode === 'version'
      ? `开始更新至 ${next.source.tag} →`
      : next.source.kind === 'commit'
        ? `同步${title(next)} →`
        : `同步上游 PR #${next.source.number} →`;
  return button(config.prTransport === 'manual' ? 'start' : 'synchronize', label);
}

function targetHero(state, config) {
  const mode = config.mode === 'version' ? '按版本更新' : '同步开发过程';
  return `<section class="v3-hero" aria-label="本轮目标"><div><p class="v3-eyebrow">同步工作台 · ${esc(mode)}</p><h2>选择本轮终点</h2><p>可以按最新、tag 或完整 40 位 commit 指定终点。对比是只读的；开始后会重新核验目标与内部 HEAD。</p></div><div class="v3-hero-stats"><div><b>${state.queue.length}</b><span>待处理</span></div><div><b>${sha(state.latest)}</b><span>扫描最新</span></div><div><b>${esc(state.accepted.tag ?? '已登记')}</b><span>已接收</span></div></div></section>`;
}