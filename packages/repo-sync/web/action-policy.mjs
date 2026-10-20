import { automaticPolicy } from './automation-view.mjs';
import { stageOf } from './ui.mjs';
import { recoveryPolicy } from './candidate-recovery.mjs';

export function nextAction(snapshot, delivery, historical = false) {
  if (historical) return { stage: 0, text: '此记录只读，可展开各阶段查看当时信息。' };
  const policy =
    taskPolicy(snapshot, delivery) ?? recoveryPolicy(delivery) ?? cancellationPolicy(delivery) ?? automaticPolicy(snapshot, delivery) ?? deliveryPolicy(snapshot, delivery);
  const task = snapshot.operation;
  const owns = ownsTask(task, delivery) || task?.deliveryIds?.includes(delivery?.id);
  const failed =
    owns &&
    task?.status === 'FAILED' &&
    task.steps?.findLast(
      (step) => step.status === 'FAILED' && (!step.deliveryId || !delivery || step.deliveryId === delivery.id),
    );
  return failed?.stage && task.persistence?.status !== 'FAILED' ? { ...policy, stage: failed.stage } : policy;
}
function cancellationPolicy(delivery) {
  return delivery?.cancellation?.status === 'REQUESTED' ? { stage: 4, text: '原 PR 撤销结果待回读；当前轮次已暂停，不会继续创建对象。', anchor: 'cancel-delivery-form', label: '回读并完成原 PR 撤销 →' } : null;
}
function taskPolicy(snapshot, delivery) {
  const task = snapshot.operation;
  const owns = ownsTask(task, delivery);
  if (!owns) return null;
  if (task?.persistence?.status === 'FAILED')
    return {
      stage: 5,
      text: `业务状态 ${task.status}；执行记录保存失败。只补存原记录，不能重跑业务。`,
      ...(task.persistence.canRetry ? { special: 'persist-operation', label: '只补存原任务记录' } : {}),
    };
  if (task?.status === 'FAILED' && task.error?.code === 'LEDGER_WRITE_FAILED')
    return {
      stage: task.steps.findLast((step) => step.status === 'FAILED')?.stage ?? 5,
      text: '台账保存未确认。关闭占用程序并核对写权限后，先读取原交付与 Git 结果，不能重发同步。',
      ...(delivery ? { action: 'recover', label: '核对原交付并恢复' } : {}),
    };
  if (['RUNNING', 'CANCELLING', 'STOP_UNCONFIRMED'].includes(task?.status))
    return {
      stage: task.steps?.findLast((step) => step.status === 'RUNNING')?.stage || stageOf(delivery),
      text:
        task.status === 'STOP_UNCONFIRMED'
          ? '停止结果尚未确认。请在原执行器确认进程退出，保持原任务与写锁。'
          : '正在执行当前子步骤，可浏览历史；请等待原任务返回。',
      ...(task.cancellable ? { special: 'cancel-operation', label: '取消当前读取 / 下载' } : {}),
    };
  return null;
}
function deliveryPolicy(snapshot, delivery) {
  const task = snapshot.operation;
  if (!delivery) return { stage: 1, text: '先选择并核对目标，再开始本笔同步。' };
  if (
    ![
      'ISSUES_REQUIRED',
      'CODE_PREPARE_REQUIRED',
      'PUSH_RESULT_UNKNOWN',
      'PR_REQUIRED',
      'WAITING_APPROVAL',
      'CODE_ACCEPTED_PENDING_METADATA',
      'COMPLETE',
      'CANCELLED',
    ].includes(delivery.status)
  )
    return { stage: 0, text: '同步状态不受支持，请保留记录并核对版本，不能重新执行。' };
  if (delivery.status === 'COMPLETE') return { stage: 5, text: '本笔同步已完成，内外对应与接收结果已保存。' };
  if (delivery.status === 'CANCELLED') return { stage: 2, text: '本笔已撤销。保留原记录，请返回当前同步选择新目标。' };
  const reference = referencePolicy(snapshot, delivery) ?? closurePolicy(snapshot, delivery);
  if (reference) return reference;
  const issueAction = issuePolicy(snapshot, delivery);
  if (issueAction) return issueAction;
  if (delivery.status === 'PUSH_RESULT_UNKNOWN')
    return {
      stage: 3,
      text: '先核对同名候选 ref 的实际 SHA，保留原同步标识。',
      action: 'recover',
      label: '核对原交付并恢复',
    };
  if (delivery.status === 'CODE_ACCEPTED_PENDING_METADATA')
    return {
      stage: 5,
      text: '代码已经核验接收。核对 Issue 实际状态并保存；此操作不会关闭平台 Issue。',
      anchor: 'receipt-form',
      label: '确认 Issue 接收记录 →',
    };
  if (['PR_URL_MISMATCH', 'INVALID_PR_URL', 'PR_REFERENCE_CHANGED'].includes(delivery.error?.code))
    return {
      stage: 3,
      text: '请在原 PR 表单修正引用并重新确认候选与目标分支。',
      anchor: 'pr-form',
      label: '修正 PR 引用 →',
    };
  if (delivery.status === 'WAITING_APPROVAL' && !delivery.error)
    return {
      stage: 4,
      text: '在内部平台完成审核合入，再回到这里核验实际 Git 结果。',
      href: delivery.prUrl,
      label: '打开内部 PR ↗',
      secondary: { action: 'recover', label: '已在平台合入，核验 Git 结果' },
    };
  const failure = failurePolicy(task, delivery);
  if (failure) return failure;
  if (delivery.status === 'PR_REQUIRED')
    return { stage: 3, text: '候选已发布，继续处理原 PR。', anchor: 'pr-form', label: '处理内部 PR →' };
  return preparationPolicy(snapshot, delivery);
}

function referencePolicy(snapshot, delivery) {
  if (
    snapshot.connection &&
    !snapshot.platform?.repositoryUrl &&
    ['PR_REQUIRED', 'WAITING_APPROVAL'].includes(delivery.status)
  )
    return {
      stage: 3,
      text: '补填内部仓库网页地址后继续。原候选和基线保留。',
      anchor: 'pr-form',
      label: '配置网页地址，继续 PR →',
    };
  if (delivery.prReference?.withdrawn)
    return {
      stage: 3,
      text: '原 PR 引用已撤销。核对已存在的 PR 后补登记，避免重复创建。',
      anchor: 'pr-form',
      label: '登记核对后的 PR 引用 →',
    };
  if (['GIT_PR_LINK_UNKNOWN', 'GIT_PR_RESPONSE_AMBIGUOUS', 'PR_CREATE_RESULT_UNKNOWN'].includes(delivery.error?.code))
    return {
      stage: 3,
      text: '创建回执不明确。核对原候选与已创建 PR，只补登记原对象。',
      anchor: 'pr-form',
      label: '补登记原 PR 地址 →',
    };
  return null;
}

function preparationPolicy(snapshot, delivery) {
  if (snapshot.config?.issueAutomation?.automatic && delivery.status === 'ISSUES_REQUIRED')
    return {
      stage: 2,
      text: '按顺序创建或复用内部 Issue、获取原始提交、保留声明路径，再检查与发布候选。',
      action: 'prepare',
      label: '自动搬运 Issue、检查并推送候选 →',
    };
  if (delivery.status === 'ISSUES_REQUIRED' && !delivery.issues.every((issue) => snapshot.state.issues[issue.sourceId]))
    return {
      stage: 2,
      text: '先在内部平台创建或复用 Issue，登记来源映射后继续。',
      anchor: 'issue-mappings',
      label: '登记内部 Issue 对应 →',
    };
  return {
    stage: 2,
    text: delivery.error
      ? '请先在本机修正配置的项目检查，再检查同一个候选。'
      : '核对范围后执行代码准备、检查及候选发布。',
    action: 'prepare',
    label: delivery.mode === 'version' ? '保留文件、检查并推送候选 →' : '检查并推送候选分支 →',
  };
}

function failurePolicy(task, delivery) {
  const checkFailure = task?.steps.some((step) => step.key === 'candidate-check' && step.status === 'FAILED');
  if (delivery.error && !checkFailure && !['CHECK_FAILED', 'CHECK_TIMEOUT'].includes(delivery.error.code))
    return {
      stage: ['ISSUES_REQUIRED', 'CODE_PREPARE_REQUIRED'].includes(delivery.status) ? 2 : 5,
      text: '当前错误需要先核对原交付，不能直接重建或重推。详细原因见当前步骤。',
      action: 'recover',
      label: '核对原交付并恢复',
    };
  return null;
}

function ownsTask(task, delivery) {
  return !task?.deliveryId || task.deliveryId === delivery?.id || !delivery;
}

function issuePolicy(snapshot, delivery) {
  if (snapshot.config?.issueAutomation?.automatic && delivery.error?.code?.startsWith('ISSUE_'))
    return {
      stage: delivery.acceptedInternal ? 5 : delivery.prUrl ? 3 : 2,
      text: '原 Issue 操作未确认。核对当前步骤的配置 / 权限后，只查询并恢复原对象。不会重建 Issue 或重推代码。',
      action: 'sync-issues',
      label: '回读并恢复原 Issue 操作',
    };
  if (delivery.status === 'CODE_ACCEPTED_PENDING_METADATA')
    if (snapshot.config?.issueAutomation?.automatic)
      return {
        stage: 5,
        text: '代码已接受；自动核验原 PR 关联与 Issue 接收条件，完成状态更新并回读。',
        action: 'sync-issues',
        label: '核验 / 更新原 Issue 并完成同步',
      };
  return null;
}

function closurePolicy(snapshot, delivery) {
  if (
    snapshot.connection &&
    snapshot.config?.mode === 'continuous' &&
    snapshot.config.commitClosureVerified !== true &&
    delivery.status === 'ISSUES_REQUIRED'
  )
    return {
      stage: 2,
      text: '首次发布前确认提交消息的关单规则，避免外部编号关闭内部同号 Issue。只需对这个接收仓库确认一次。',
      anchor: 'closure-settings',
      label: '确认提交消息关单规则 →',
    };
  return null;
}
