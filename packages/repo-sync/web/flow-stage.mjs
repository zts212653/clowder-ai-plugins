import { stageOf } from './ui.mjs';

export function boundaryDeliveryId(state) {
  return state?.automation?.status === 'PAUSED' ? state.automation.pauseRequested?.afterDeliveryId : null;
}
export function currentRecord(snapshot, records) {
  const id = snapshot.state?.active?.id ?? boundaryDeliveryId(snapshot.state);
  return records.selected !== 'current' || records.detail?.delivery?.id === id ? records.detail : null;
}
export function automaticMergeActive(delivery, run) {
  return (
    run?.autoMerge === true ||
    Boolean(
      delivery?.autoMerge?.requestedAt &&
        !delivery.autoMerge.requestRejected &&
        delivery.autoMerge.status !== 'MERGED',
    )
  );
}
export function stagePresentation(stage, delivery, current, failedStage = 0, run) {
  if (delivery?.status === 'CANCELLED' && stage !== failedStage)
    return {
      state: stage === 4 ? 'cancelled' : 'skipped',
      mark: '—',
      tone: '',
      caption: stage === 4 ? '已撤销 · 未合入' : stage === 5 ? '未登记接收' : '本笔已终止',
    };
  const failed = stage === failedStage;
  const merged = Boolean(delivery?.mergeObservation || delivery?.acceptedInternal);
  const done = delivery?.status === 'COMPLETE' || (stage === 4 && merged) || (stage < current && stage !== 4);
  const waiting = stage === 4 && stage === current && delivery?.prUrl && !failed;
  const state = failed
    ? 'failed'
    : done
      ? 'done'
      : waiting
        ? delivery.autoMerge?.manual || !automaticMergeActive(delivery, run)
          ? 'waiting-human'
          : 'waiting-system'
        : stage === current
          ? 'current'
          : 'pending';
  return {
    state,
    mark: {
      failed: '×',
      done: '✓',
      current: '◌',
      pending: '○',
      'waiting-human': '!',
      'waiting-system': '◷',
    }[state],
    tone: { failed: 'bad', done: 'good' }[state] ?? '',
    caption: {
      failed: '异常待处理',
      done: '已完成',
      current: '正在执行',
      pending: '待执行',
      'waiting-human': '等待人工',
      'waiting-system': '自动等待',
    }[state],
  };
}
export function currentStage(delivery, policy, historical = false) {
  return historical ? stageOf(delivery) : policy.stage || stageOf(delivery);
}

export function preDeliveryPresentation(stage, task, policy) {
  if (
    task?.persistence?.status !== 'FAILED' &&
    (policy?.outcome === 'cancelled' || (task?.action === 'cancel-delivery' && task.status === 'SUCCEEDED'))
  )
    return {
      current: 1,
      state: stage === 1 ? 'current' : 'skipped',
      mark: stage === 1 ? '○' : '—',
      caption: stage === 1 ? '等待明确重试' : stage === 4 ? '原 PR 已撤销 · 未合入' : '未执行',
      tone: '',
    };
  const current =
    task?.persistence?.status === 'FAILED'
      ? 5
      : task?.steps?.findLast((s) => ['RUNNING', 'FAILED'].includes(s.status))?.stage || policy?.stage || 1;
  const failed =
    stage === current &&
    (['FAILED', 'INTERRUPTED', 'STOP_UNCONFIRMED'].includes(task?.status) ||
      task?.persistence?.status === 'FAILED');
  const steps = task?.steps?.filter((s) => s.stage === stage) ?? [];
  const done = stage < 4 && steps.length > 0 && steps.every((s) => s.status === 'DONE');
  const state = failed ? 'failed' : done ? 'done' : stage === current ? 'current' : 'pending';
  return {
    current,
    state,
    mark: failed ? '×' : done ? '✓' : stage === current ? '●' : '○',
    caption: failed ? '异常待处理' : done ? '已完成' : stage === current ? '当前步骤' : '待执行',
    tone: failed ? 'bad' : done ? 'good' : '',
  };
}
