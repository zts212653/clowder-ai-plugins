import { autoMergeDelivery, configureAutoMerge } from './auto-merge.mjs';
import { fail } from './config.mjs';
import {
  armBoundary,
  boundaryReached,
  configureContinuation,
  continuationModes,
  startNext,
} from './continuation.mjs';
import { execution, phase, safeError } from './execution.mjs';
import { discover } from './github.mjs';

export function validateAutomation(value) {
  if (value === undefined) return;
  if (
    !value ||
    !/^[a-f0-9]{32}$/.test(value.id ?? '') ||
    !['RUNNING', 'WAITING_REVIEW', 'FAILED', 'PAUSED', 'COMPLETE'].includes(value.status) ||
    (value.autoMerge !== undefined && typeof value.autoMerge !== 'boolean') ||
    (value.startingDeliveryCount !== undefined && (!Number.isSafeInteger(value.startingDeliveryCount) || value.startingDeliveryCount < 0)) ||
    !Number.isFinite(Date.parse(value.startedAt)) ||
    !value.selection ||
    !['latest', 'tag', 'commit', 'queue'].includes(value.selection.kind) ||
    (value.continuation !== undefined && !continuationModes.has(value.continuation)) ||
    (value.pauseRequested !== undefined &&
      (!value.pauseRequested ||
        typeof value.pauseRequested !== 'object' ||
        Array.isArray(value.pauseRequested) ||
        Object.keys(value.pauseRequested).some((key) => !['afterDeliveryId', 'requestedAt'].includes(key)) ||
        !Number.isFinite(Date.parse(value.pauseRequested.requestedAt)) ||
        (value.pauseRequested.afterDeliveryId !== null &&
          !/^[a-f0-9]{24}$/.test(value.pauseRequested.afterDeliveryId ?? ''))))
  )
    fail('AUTOMATION_INVALID', '自动同步记录损坏，保留原台账；不能重建另一轮。');
}
export async function synchronize(receiver, input, options = {}) {
  const state = await receiver.read();
  if (state && receiver.active(state)?.cancellation?.status === 'REQUESTED')
    fail('CANCELLATION_PENDING', '原 PR 撤销尚未完成，请继续回读原撤销结果，不恢复普通同步。');
  validateRequest(state, input);
  if (input.autoMerge === true && receiver.config.pullRequests?.mode !== 'gitlab')
    fail('AUTO_MERGE_UNSUPPORTED', '当前平台创建方式没有合入 API，未开始任何新交付。');
  if (input.action === 'configure-auto-merge') return configureAutoMerge(receiver, input);
  if (input.action === 'configure-continuation') return configureContinuation(receiver, input);
  if (input.action === 'pause-sync') return pause(receiver, input.runId);
  if (reuseRun(state, input)) return state;
  requireCapabilities(receiver.config);
  const id = input.action === 'synchronize' ? input.requestId : state.automation.id;
  const registered = await register(receiver, input, id);
  if (registered.automation.status !== 'RUNNING') return registered;
  try {
    await scan(receiver, options);
    await advance(receiver);
    return await finish(receiver);
  } catch (error) {
    await receiver.change((saved) => {
      if (saved.automation?.id !== id) fail('AUTOMATION_CHANGED', '原同步轮次已改变。');
      Object.assign(saved.automation, {
        status: 'FAILED',
        error: safeError(error),
        updatedAt: new Date().toISOString(),
      });
    });
    throw error;
  }
}
function validateRequest(state, input) {
  if (
    (input.observeOnly !== undefined && typeof input.observeOnly !== 'boolean') ||
    (input.autoMerge !== undefined && typeof input.autoMerge !== 'boolean') ||
    (input.continuation !== undefined && !continuationModes.has(input.continuation))
  )
    fail('INVALID_CONTINUATION', '继续方式无效，请重新核对原同步轮次。');
  if (input.targetKind !== undefined && !['latest', 'tag', 'commit'].includes(input.targetKind))
    fail('INVALID_TARGET', '请选择最新分支、tag 或完整 commit。');
  if (
    input.targetValue !== undefined &&
    (typeof input.targetValue !== 'string' ||
      input.targetValue.length > 200 ||
      /[\r\n\0]/.test(input.targetValue))
  )
    fail('INVALID_TARGET', '目标名称无效。');
  if (input.action === 'synchronize' && !/^[a-f0-9]{32}$/.test(input.requestId ?? ''))
    fail('INVALID_TASK_INPUT', '自动同步需要有效请求标识。');
  if (!state) fail('NOT_ADOPTED', '请先在仓库设置完成认证与基线核验。');
  if (input.action !== 'synchronize' && (!state.automation || input.runId !== state.automation.id))
    fail('AUTOMATION_CHANGED', '同步轮次已改变，请刷新原记录；未操作另一轮。');
}
function reuseRun(state, input) {
  const original = state.automation;
  if (original && input.action === 'synchronize' && original.status !== 'COMPLETE') {
    if (original.id === input.requestId || original.status === 'WAITING_REVIEW') return true;
    fail('AUTOMATION_EXISTS', '已有同步轮次，请恢复或暂停原轮次，不重复创建。');
  }
  return input.action === 'resume-sync' && original.status === 'COMPLETE';
}
function requireCapabilities(config) {
  if (!config.pullRequests)
    fail('PR_AUTOMATION_REQUIRED', '请先在仓库设置启用自动创建内部 PR；手工登记不能运行全自动同步。');
  if (config.mode !== 'version' && config.commitClosureVerified !== true)
    fail('PLATFORM_CLOSURE_UNVERIFIED', '请在仓库设置完成提交消息关单规则确认，然后恢复同步。');
}
function pause(receiver, id) {
  return receiver.change((saved) => {
    if (saved.automation?.id !== id) fail('AUTOMATION_CHANGED', '原同步轮次已改变。');
    const run = saved.automation,
      active = receiver.active(saved);
    run.continuation = 'after-each';
    armBoundary(run, active);
    if (!active && run.status !== 'COMPLETE') {
      run.status = 'PAUSED';
      run.pauseRequested ??= {
        afterDeliveryId: null,
        requestedAt: new Date().toISOString(),
      };
    }
    run.updatedAt = new Date().toISOString();
  });
}
function register(receiver, input, id) {
  return receiver.change((saved) => {
    if (input.action !== 'synchronize' && saved.automation?.id !== id)
      fail('AUTOMATION_CHANGED', '原同步轮次已改变。');
    if (input.observeOnly && ['PAUSED', 'FAILED', 'COMPLETE'].includes(saved.automation?.status)) return;
    checkQueuedTarget(saved, input);
    const active = receiver.active(saved);
    if (input.action === 'resume-sync' && !input.observeOnly && active?.autoMerge?.status === 'BLOCKED') {
      delete active.autoMerge.deadlineAt;
      delete active.autoMerge.nextCheckAt;
    }
    const releaseBoundary =
      input.action === 'resume-sync' &&
      !input.observeOnly &&
      saved.automation?.status === 'PAUSED' &&
      !active;
    saved.automation =
      input.action === 'synchronize'
        ? {
            id,
            status: 'RUNNING',
            startedAt: new Date().toISOString(),
            startingDeliveryId: active?.id ?? null,
            startingDeliveryCount: saved.deliveries.length,
            continuation: input.continuation ?? 'automatic',
            autoMerge: input.autoMerge === true,
            selection: input.targetKind
              ? { kind: input.targetKind, value: input.targetValue }
              : { kind: saved.queue.length || active ? 'queue' : 'latest' },
            scanned: Boolean(active || (!input.targetKind && saved.queue.length)),
          }
        : { ...saved.automation, status: 'RUNNING' };
    if (releaseBoundary) delete saved.automation.pauseRequested;
    armBoundary(saved.automation, active);
    delete saved.automation.error;
  });
}
async function scan(receiver, options) {
  const state = await receiver.read();
  if (state.automation.scanned) return;
  const selection = state.automation.selection;
  if (receiver.config.mode === 'version') {
    if (selection.kind !== 'tag' || !selection.value) fail('TAG_REQUIRED', '按版本更新需要选择目标 tag。');
    await receiver.selectTag(selection.value);
  } else await discover(receiver, selection, options.sourceProvider);
}
async function advance(receiver) {
  let state = await receiver.status();
  if (state.active) {
    if (state.active.prUrl || state.active.acceptedInternal || state.active.status === 'PUSH_RESULT_UNKNOWN')
      await phase('delivery-verify', '核验原交付的合入、Issue 与接收结果', () => receiver.recover(), false);
    state = await receiver.status();
    if (state.active?.status === 'CODE_ACCEPTED_PENDING_METADATA' && !state.active.issues.length)
      await phase('delivery-verify', '保存原交付的接收结果', () => receiver.receipts([]), false);
  }
  state = await receiver.status();
  releaseTerminalDelivery(state);
  if (boundaryReached(receiver, state)) return;
  if (state.active?.status === 'WAITING_APPROVAL') {
    await completeAutomaticMerge(receiver);
    releaseTerminalDelivery(await receiver.status());
    return;
  }
  if (!state.active && state.queue.length) {
    const context = execution();
    if (context) {
      context.associate?.(null);
      context.deliveryId = null;
    }
    await phase(
      'delivery-start',
      '登记下一笔交付',
      () => startNext(receiver, state.queue[0].target, state.automation.id),
      false,
    );
  }
  state = await receiver.status();
  if (!state.active || state.active.acceptedInternal) return;
  if (state.active.issues.length && !receiver.config.issues)
    fail('ISSUE_AUTOMATION_REQUIRED', '请在仓库设置配置内部 Issue 自动创建与关单，然后恢复原轮次。');
  await phase('delivery-prepare', '准备当前交付与内部 PR', () => receiver.prepare(), false);
  await completeAutomaticMerge(receiver);
  releaseTerminalDelivery(await receiver.status());
}
function releaseTerminalDelivery(state) {
  const context = execution();
  const boundDelivery = state.deliveries.find(({ id }) => id === context?.deliveryId);
  if (
    boundDelivery &&
    state.activeId === boundDelivery.id &&
    ['COMPLETE', 'CANCELLED'].includes(boundDelivery.status)
  ) {
    context.associate?.(null);
    context.deliveryId = null;
  }
}
async function completeAutomaticMerge(receiver) {
  const state = await receiver.status();
  if (state.automation?.autoMerge !== true || state.active?.status !== 'WAITING_APPROVAL') return;
  const result = await autoMergeDelivery(receiver);
  if (result.kind !== 'merged') return;
  await phase('delivery-verify', '核验平台自动合入的 Git、Issue 与接收结果', () => receiver.recover(), false);
  const current = await receiver.status();
  if (current.active?.status === 'CODE_ACCEPTED_PENDING_METADATA' && !current.active.issues.length)
    await receiver.receipts([]);
}
function finish(receiver) {
  return receiver.change((saved) => {
    const active = receiver.active(saved);
    if (active && active.status !== 'WAITING_APPROVAL')
      fail('PR_READBACK_REQUIRED', '内部 PR 仍未完成回读，请恢复原交付；不会重复创建。');
    Object.assign(saved.automation, {
      status: active
        ? 'WAITING_REVIEW'
        : !saved.queue.length
          ? 'COMPLETE'
          : saved.automation.status === 'PAUSED' || boundaryReached(receiver, saved)
            ? 'PAUSED'
            : 'RUNNING',
      deliveryId: active?.id ?? null,
      updatedAt: new Date().toISOString(),
    });
    saved.automation.target ??= saved.queue.at(-1)?.target ?? saved.accepted.upstream;
  });
}

function checkQueuedTarget(saved, input) {
  if (input.expectedTarget && !input.targetKind && saved.queue[0]?.target !== input.expectedTarget)
    fail('QUEUE_CHANGED', '待同步目标已变化，请刷新核对；未开始另一笔。');
}
