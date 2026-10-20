import { errorGuide } from './error-guide.mjs';
import { automaticMergeActive } from './flow-stage.mjs';
import { businessStep, plannedSteps, projectStep } from './step-plan.mjs';
import { taskProgress } from './task-progress.mjs';
import { completionProof, esc, stageOf, when } from './ui.mjs';

const marks = {
  DONE: '✓',
  RUNNING: '◌',
  FAILED: '×',
  PENDING: '○',
  WAITING: '!',
  AUTO_WAIT: '◷',
  UNRECORDED: '—',
  SKIPPED: '—',
};
const states = {
  DONE: 'done',
  RUNNING: 'current',
  FAILED: 'failed',
  PENDING: 'pending',
  WAITING: 'current',
  AUTO_WAIT: 'current',
  UNRECORDED: 'unrecorded',
  SKIPPED: 'skipped',
};
const labels = {
  DONE: '已完成',
  RUNNING: '执行中',
  FAILED: '异常待处理',
  PENDING: '计划 · 尚未执行',
  WAITING: '等待人工审核',
  AUTO_WAIT: '自动等待',
  UNRECORDED: '执行证据未记录',
  SKIPPED: '不适用',
};

export function attempts(stage, record, operation, historical, snapshot = {}) {
  const groups = stageGroups(stage, record, operation, historical, snapshot);
  return `<ol class="substeps">${[...groups.values()].map((group) => stepView(group, stage, historical)).join('')}</ol>${operationSlot(stage, operation, record?.delivery ?? snapshot.state?.active, historical)}`;
}

export function stageSummary(stage, record, operation, historical, snapshot = {}, stageState = 'pending') {
  const cancelled =
    (record?.delivery ?? snapshot.state?.active)?.status === 'CANCELLED' ||
    (!(record?.delivery ?? snapshot.state?.active) && snapshot.state?.automation?.restartOf);
  if (cancelled && stage === 4) return '原 PR 已关闭，未合入；撤销回执按需展开';
  if (cancelled && stage === 5) return '未登记接收，接受基线保持不变';
  const groups = [...stageGroups(stage, record, operation, historical, snapshot).values()];
  if (historical) return '历史执行详情按需展开';
  const delivery = record?.delivery ?? snapshot.state?.active;
  if (
    stage === 4 &&
    automaticMergeActive(delivery, snapshot.state?.automation) &&
    delivery?.autoMerge?.reason &&
    !delivery.mergeObservation &&
    !delivery.acceptedInternal
  )
    return delivery.autoMerge.reason;
  if (stageState === 'done') return `本阶段已完成 · ${groups.length} 项业务步骤`;
  if (stage === 5 && stageState === 'pending' && !delivery?.mergeObservation && !delivery?.acceptedInternal)
    return '确认原 PR 合入后，核验 Git、处理 Issue 并登记接收';
  const projected = groups.map((group) => ({ group, ...projectStep(group) }));
  const failed = projected.findLast((item) => item.status === 'FAILED');
  if (failed) {
    const code = failed.latest?.step.error?.code ?? failed.latest?.task.error?.code;
    return `异常${code ? ` · ${code}` : ''} · 展开查看处理建议`;
  }
  const active = projected.findLast((item) => ['RUNNING', 'WAITING'].includes(item.status));
  if (active) return `${active.status === 'WAITING' ? '等待' : '正在'}：${active.group.label}`;
  const done = projected.filter(({ status }) => ['DONE', 'SKIPPED'].includes(status)).length;
  const next = projected.find(({ status }) => status === 'PENDING');
  if (next)
    return done
      ? `已完成 ${done} / ${groups.length} 项 · 下一项：${next.group.label}`
      : `下一项：${next.group.label}`;
  return `共 ${groups.length} 项业务步骤 · 展开查看`;
}

export function stageGroups(stage, record, operation, historical, snapshot) {
  const delivery = record?.delivery ?? snapshot.state?.active;
  const tasks = selectedTasks(record, operation, historical, delivery?.id);
  const cancelled = delivery?.status === 'CANCELLED' || (!delivery && snapshot.state?.automation?.restartOf);
  const version = (delivery?.mode ?? snapshot.config?.mode) === 'version';
  const groups = new Map(
    plannedSteps(stage, version).map(([key, label]) => [
      key,
      {
        key,
        label,
        status: historical || (delivery && stage < stageOf(delivery)) ? 'UNRECORDED' : 'PENDING',
        entries: [],
      },
    ]),
  );
  if (delivery && !delivery.issues?.length)
    for (const group of groups.values()) if (group.key.startsWith('issue-')) group.status = 'SKIPPED';
  for (const task of tasks) {
    const byId = new Map((task.steps ?? []).map((step) => [step.id, step]));
    for (const step of task.steps ?? []) {
      if (step.stage !== stage || (delivery?.id && step.deliveryId && step.deliveryId !== delivery.id))
        continue;
      let parent = byId.get(step.parentId);
      const visited = new Set();
      while (parent && !groups.has(parent.key) && !visited.has(parent.id)) {
        visited.add(parent.id);
        parent = byId.get(parent.parentId);
      }
      const key =
        task.action === 'cancel-delivery'
          ? 'cancellation'
          : businessStep(stage, step.key ?? step.id, groups, parent?.key);
      if (key === 'cancellation' && !groups.has(key))
        groups.set(key, { key, label: '撤销原 PR（不代表合入）', status: 'PENDING', entries: [] });
      groups.get(key)?.entries.push({ task, step });
    }
  }
  if (stage === 4 && delivery) {
    const merged = Boolean(delivery.mergeObservation || delivery.acceptedInternal);
    const automatic = automaticMergeActive(delivery, historical ? undefined : snapshot.state?.automation);
    const waiting = delivery.prUrl && !merged;
    groups.get('merge-readiness').status = merged
      ? 'DONE'
      : waiting
        ? automatic
          ? 'AUTO_WAIT'
          : 'SKIPPED'
        : 'PENDING';
    groups.get('platform-merge').status = merged && automatic ? 'DONE' : automatic ? 'PENDING' : 'SKIPPED';
    groups.get('merge-observe').status = merged ? 'DONE' : waiting ? 'AUTO_WAIT' : 'PENDING';
    if (!merged) {
      groups.get('merge-observe').completionStatus = waiting ? 'AUTO_WAIT' : 'PENDING';
      groups.get('merge-readiness').completionStatus = automatic ? 'AUTO_WAIT' : 'SKIPPED';
    }
    groups.set('platform-review', {
      key: 'platform-review',
      label: delivery.autoMerge?.manual ? delivery.autoMerge.reason : '在内部平台审核并合入',
      status: merged
        ? 'DONE'
        : waiting
          ? automatic && !delivery.autoMerge?.manual
            ? 'SKIPPED'
            : 'WAITING'
          : 'PENDING',
      entries: [],
    });
  }
  // A polling call can succeed without observing a merge. Its technical receipt is
  // retained below, but cannot mark post-merge business work as accepted.
  if (stage === 5 && delivery && !delivery.mergeObservation && !delivery.acceptedInternal)
    for (const group of groups.values())
      if (['merge-verify', 'issue-state', 'acceptance-save'].includes(group.key))
        group.completionStatus = group.status === 'SKIPPED' ? 'SKIPPED' : 'PENDING';
  if (cancelled && [4, 5].includes(stage)) {
    for (const group of groups.values())
      if (!['cancellation', 'execution-record'].includes(group.key)) group.terminalStatus = 'SKIPPED';
    if (stage === 4 && !groups.has('platform-review'))
      groups.set('platform-review', {
        key: 'platform-review',
        label: '内部平台合入',
        status: 'SKIPPED',
        entries: [],
      });
  }
  if (stage === 5)
    for (const group of groups.values()) group.proof = completionProof(group.key, delivery, record);
  addUnscopedFailure(groups, tasks, stage, delivery);
  return groups;
}

function selectedTasks(record, operation, historical, deliveryId) {
  const tasks = [...(record?.tasks ?? [])];
  const owns =
    !deliveryId || operation?.deliveryId === deliveryId || operation?.deliveryIds?.includes(deliveryId);
  if (!historical && operation && owns) {
    const index = tasks.findIndex((task) => task.id === operation.id);
    if (index >= 0) tasks[index] = operation;
    else tasks.push(operation);
  }
  return tasks.sort((a, b) => (Date.parse(a.startedAt) || 0) - (Date.parse(b.startedAt) || 0));
}

function stepView(group, stage, historical) {
  const { actual, latest, status } = projectStep(group);
  const label = group.label;
  const tone = status === 'FAILED' ? 'bad' : status === 'DONE' ? 'good' : '';
  const error =
    status === 'FAILED'
      ? errorGuide(latest?.step.error, {
          stage,
          action: latest?.task.action,
          deliveryId: latest?.step.deliveryId ?? latest?.task.deliveryId,
          historical,
        })
      : '';
  const waiting = group.key === 'platform-review' && status === 'PENDING';
  const platformTiming = waiting ? '<small>平台审批时间未记录；实际合入结果由第五阶段核验。</small>' : '';
  return `<li data-step-key="${esc(group.key)}" data-operation-state="${esc(status)}" data-step-state="${states[status] ?? 'pending'}"><span class="${tone}">${marks[status] ?? '○'}</span> <b>${esc(label)}</b> · ${labels[status] ?? '状态未记录'}${platformTiming}${latest ? taskProgress(latest.step, esc, Date.now(), false) : ''}${error}${!actual.length && group.proof ? `<details class="business-proof"><summary>结果已记录 · 查看依据</summary><p>${group.proof}</p><small>未单独采集此步骤事件；以上是实际保存结果的依据。</small></details>` : ''}${actual.map(evidence).join('')}</li>`;
}

function evidence({ task, step }, index) {
  return `<div class="attempt" data-attempt="${esc(`${task.id}:${step.id}`)}" data-attempt-task="${esc(task.id)}"><p class="attempt-h">执行记录 ${index + 1} · ${labels[step.status] ?? '状态未记录'}</p><small>${esc(step.label)}<br>任务 ${esc(task.id)} · 开始 ${when(step.startedAt)} · 结束 ${when(step.finishedAt)}</small>${taskProgress(step, esc, Date.now(), true)}${step.error ? `<p class="bad">× ${esc(step.error.code)}：${esc(step.error.message)}</p>` : ''}</div>`;
}

function addUnscopedFailure(groups, tasks, stage, delivery) {
  for (const task of tasks) {
    if (task.persistence?.status === 'FAILED' && stage === 5) {
      const group = groups.get('execution-record') ?? {
        key: 'execution-record',
        entries: [],
      };
      group.entries.push({
        task,
        step: {
          id: 'execution-record',
          label: '保存原执行记录',
          status: 'FAILED',
          error: task.persistence.error,
        },
      });
      groups.set('execution-record', group);
    } else if (
      ['FAILED', 'INTERRUPTED', 'STOP_UNCONFIRMED'].includes(task.status) &&
      task.error &&
      !task.steps?.some((step) => step.status === 'FAILED')
    ) {
      const owner = task.steps?.findLast((step) => step.status === 'RUNNING')?.stage ?? stageOf(delivery);
      if (owner === stage)
        groups.get(businessStep(stage, 'task-result', groups))?.entries.push({
          task,
          step: {
            id: 'task-result',
            key: 'task-result',
            label: '核对原任务未完成结果',
            status: 'FAILED',
            error: task.error,
          },
        });
    }
  }
}

function operationSlot(stage, operation, delivery, historical) {
  if (historical || (delivery?.id && operation?.deliveryId && operation.deliveryId !== delivery.id))
    return '';
  const current =
    operation?.persistence?.status === 'FAILED'
      ? 5
      : (operation?.steps?.findLast((step) => ['RUNNING', 'FAILED'].includes(step.status))?.stage ??
        stageOf(delivery));
  return stage === current ? '<div id="operation" aria-live="polite"></div>' : '';
}
