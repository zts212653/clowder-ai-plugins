import { seedAudit } from './audit.mjs';
import { existingRepositoryDeliveries, simulateBaselineCheck } from './baseline.mjs';
import { defaultBinding, emptyBinding } from './binding.mjs';
import { resumeContinuity, seedContinuity } from './continuity.mjs';
import { COMPLETE, deliveries, phases } from './data.mjs';
import { deliveryNames } from './delivery.mjs';
import { issueAuditMessage, platformIssueStatus, reconcileIssue } from './issues.mjs';

const snapshot = (index, phase, block = null) => ({
  ...structuredClone(deliveries[index]),
  phase,
  block,
  internalPr: phase >= 4 ? deliveries[index].internalPr : null,
  internalIssue: phase >= 3 ? deliveries[index].internalIssue : null,
});
function applyMergedScenario(state, scenario) {
  const previews = {
    verify: { index: 0, phase: 7, accepted: false, issueStatus: 'closed' },
    reconcile: { index: 0, phase: 8, accepted: true, issueStatus: 'closed' },
    'manual-close': { index: 0, phase: 8, accepted: true, issueStatus: 'open' },
    'related-issue': { index: 0, phase: 8, accepted: true, issueStatus: 'open', relation: 'related' },
    metadata: { index: 1, phase: 8, accepted: true, issueStatus: 'open', block: 'metadata' },
    synced: { index: 1, phase: COMPLETE, accepted: true, issueStatus: 'closed' },
  };
  const preview = previews[scenario];
  if (!preview) return;
  state.internalSha = `1${preview.index + 1}c79a50`;
  state.active = { ...snapshot(preview.index, preview.phase, preview.block), issueStatus: preview.issueStatus };
  if (preview.accepted) state.accepted = state.deliveries[preview.index].target;
  if (preview.relation) state.active.issueRelation = preview.relation;
}
export function createState(scenario = 'waiting', binding = defaultBinding()) {
  const state = {
    schema: 2,
    scenario,
    latest: deliveries[1].target,
    binding: structuredClone(binding),
    archives: [],
    accepted: binding.baseline,
    internalSha: binding.initialInternalSha,
    active: null,
    deliveries: structuredClone(deliveries),
    events: [
      {
        label: '以指定上游版本初始化内部核心仓（模拟）',
        note: `基线 ${binding.baseline} → 内部初始化 ${binding.initialInternalSha}`,
      },
    ],
  };
  if (scenario === 'adopt-behind') {
    state.binding = {
      ...state.binding,
      mode: 'adopt',
      internalBaseline: binding.baseline,
      initialInternalSha: binding.baseline,
    };
    state.binding.baselineCheck = simulateBaselineCheck(state.binding);
    state.internalSha = binding.baseline;
    state.deliveries = existingRepositoryDeliveries();
    state.latest = state.deliveries.at(-1).target;
    state.events = [
      {
        label: '演示预置：已有仓库接管',
        note: `外部 A ${binding.baseline} ↔ 内部 B ${binding.baseline}；之后 20 个提交分属 4 个 PR。`,
      },
    ];
  }
  if (scenario === 'waiting') state.active = snapshot(0, 6);
  if (scenario === 'timeout') state.active = snapshot(0, 4, 'timeout');
  if (scenario === 'plugin') state.active = snapshot(0, 5, 'plugin');
  if (scenario === 'drift') state.active = snapshot(0, 1, 'drift');
  applyMergedScenario(state, scenario);
  seedContinuity(state, scenario);
  if (scenario === 'unconfigured' || binding.status !== 'ready') {
    state.binding = scenario === 'unconfigured' ? emptyBinding() : structuredClone(binding);
    state.accepted = null;
    state.internalSha = null;
    state.active = null;
    state.scenario = 'unconfigured';
    state.events = [{ label: '等待仓库连接配置', note: '连接、检查、保存并初始化后，才能开始接收交付。' }];
  }
  if (state.active) state.active.bindingId = state.binding.id;
  seedAudit(state);
  return state;
}
function log(state, label, note = '', deliveryId = state.active?.id, actor = '同步程序') {
  state.events.push({
    label,
    note,
    deliveryId,
    actor,
    phase: deliveryId === state.active?.id ? state.active.phase : 0,
    time: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }),
  });
}
const handlers = {
  external(state) {
    const number = state.deliveries.length + 41;
    const delivery = {
      ...deliveries[1],
      id: `delivery-0${number}`,
      target: `f${number}ac9021`,
      sourcePr: number + 46,
      internalPr: number + 52,
      issue: number + 35,
      internalIssue: number + 278,
      title: `新增通用能力交付 ${number}`,
      commits: [`f${number}ac9021`],
      time: '刚刚',
    };
    state.deliveries.push(delivery);
    state.latest = delivery.target;
    log(
      state,
      '外部新交付加入队列',
      `来源 PR #${delivery.sourcePr} · ${delivery.target}；当前交付目标保持冻结`,
      delivery.id,
    );
  },
  start(state) {
    if (state.binding?.status !== 'ready') return;
    if (state.active && state.active.phase !== COMPLETE) return;
    const index = state.deliveries.findIndex((item) => item.target === state.accepted) + 1;
    const next = state.deliveries[index];
    if (next) {
      state.active = {
        ...structuredClone(next),
        bindingId: state.binding.id,
        phase: 1,
        block: null,
        internalPr: null,
        internalIssue: null,
      };
      const names = deliveryNames(next, state.binding);
      log(
        state,
        '已冻结同步目标',
        `${next.id} · ${next.target}；基线 ${state.accepted}；${names.candidateBranch} → ${names.targetBranch}`,
      );
    }
  },
  advance(state) {
    const active = state.active;
    if (!active || active.block || active.phase >= COMPLETE || active.phase === 6) return;
    if (active.phase === 8 && !reconcileIssue(state)) {
      log(state, '关单暂停：映射或核验记录不完整', active.error.message);
      return;
    }
    active.phase += 1;
    const original = state.deliveries.find((item) => item.id === active.id);
    if (active.phase === 3) {
      active.internalIssue = original.internalIssue;
      active.issueStatus = original.issueStatus ?? 'open';
    }
    if (active.phase === 4) active.internalPr = original.internalPr;
    if (active.phase === 8) state.accepted = active.target;
    const names = deliveryNames(active, state.binding);
    let note = `当前阶段：${phases[active.phase]}；冻结目标 ${active.target}`;
    if (active.phase === 3)
      note = `${names.candidateBranch}；接收提交 ${active.commits.join(' / ')}；Issue #${active.issue} → #${active.internalIssue}`;
    if (active.phase === 4)
      note = `内部 PR #${active.internalPr}；${names.prTitle}；${names.candidateBranch} → ${names.targetBranch}`;
    if (active.phase === 8)
      note = `内部 ${state.internalSha} 已核验；登记已接受上游 ${active.target}；继续核对 Issue #${active.internalIssue}`;
    if (active.phase === COMPLETE) note = issueAuditMessage(active);
    log(state, active.phase === COMPLETE ? '关单结果确认完成，交付完成' : `进入${phases[active.phase]}`, note);
  },
  approve(state, action) {
    const active = state.active;
    if (active?.phase !== 6 || active.block) return;
    state.internalSha = `1${state.deliveries.findIndex((item) => item.id === active.id) + 1}c79a50`;
    active.phase = 7;
    active.issueStatus = platformIssueStatus(active);
    log(state, '模拟内部平台 PR 合入，等待程序核验', action.note || '平台审批通过', active.id, '内部平台');
  },
  recover(state) {
    const active = state.active;
    if (!active?.block || active.block === 'drift') return;
    if (resumeContinuity(state, log)) return;
    const block = active.block;
    active.block = null;
    if (block === 'metadata' && !reconcileIssue(state)) {
      log(state, '关单重试仍被阻止', active.error.message);
      return;
    }
    delete active.error;
    active.phase = block === 'metadata' ? COMPLETE : block === 'plugin' ? 6 : 5;
    log(
      state,
      block === 'timeout'
        ? '已查回既有 PR，继续同一交付'
        : block === 'plugin'
          ? '插件检查重跑通过，等待审批'
          : '关单结果已补齐，未重复合入',
      block === 'metadata' ? issueAuditMessage(active) : '',
    );
  },
};
export function reduce(current, action) {
  const state = structuredClone(current);
  handlers[action.type]?.(state, action);
  return state;
}
export function summary(state) {
  const acceptedIndex = state.deliveries.findIndex((item) => item.target === state.accepted);
  const behind = state.deliveries.length - acceptedIndex - 1;
  const behindCommits = state.deliveries
    .slice(acceptedIndex + 1)
    .reduce((total, item) => total + item.commits.length, 0);
  const codeLatest = state.accepted === state.latest;
  const pending = state.active && state.active.phase < COMPLETE;
  return {
    codeLatest,
    fullyComplete: codeLatest && !pending,
    behind,
    behindCommits,
    pendingPr: state.active?.internalPr && state.active.phase < 7 ? 1 : 0,
  };
}
