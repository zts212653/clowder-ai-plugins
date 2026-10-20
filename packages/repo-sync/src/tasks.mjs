import { join } from 'node:path';
import { fail } from './config.mjs';
import { runExecution, safeError } from './execution.mjs';
import { configSnapshot, phaseLocation } from './recording.mjs';
import { Store } from './store.mjs';
import { publicTask, readTask, saveTask, taskInput, taskPlan } from './task-store.mjs';
import { assertTransferWritable } from './transfer-state.mjs';

const running = new Set(['RUNNING', 'CANCELLING', 'STOP_UNCONFIRMED']);
export class Tasks {
  constructor(resolveReceiver, perform, projectId) {
    this.projectId = projectId;
    this.resolveReceiver = resolveReceiver;
    this.perform = perform;
    this.writes = Promise.resolve();
  }
  busy() {
    return this.executing || this.persistencePending || running.has(this.value?.status);
  }
  async latest(id) {
    const receiver = await this.resolveReceiver();
    let value =
      this.value && this.value.bindingId === receiver?.config.bindingId && (!id || this.value.id === id)
        ? this.value
        : await readTask(receiver?.config, id);
    if (value && running.has(value.status) && value !== this.value) {
      value = { ...value, cancellable: false };
      try {
        process.kill(value.ownerPid, 0);
      } catch {
        value.status = 'INTERRUPTED';
        value.error = {
          code: 'EXECUTOR_INTERRUPTED',
          message: '执行器已退出，原任务中断；请先确认 Git / 检查子进程和旧执行锁，再恢复',
        };
      }
    }
    if (value?.projectId && this.projectId && value.projectId !== this.projectId)
      fail('TASK_PROJECT_CHANGED', '任务属于另一项目，未执行或覆盖原任务');
    const owned = value === this.value;
    if (owned && this.executing && !running.has(value.status))
      value = {
        ...value,
        status: 'RUNNING',
        cancellable: false,
        steps: [
          ...value.steps,
          {
            id: 'execution-record',
            key: 'execution-record',
            stage: 5,
            group: 'result',
            label: '保存执行记录',
            status: 'RUNNING',
          },
        ],
      };
    return publicTask(value, owned, !this.executing && !this.repairing);
  }
  async start(input) {
    const hash = taskInput(input);
    if (this.admitting) fail('OPERATION_RUNNING', '正在登记任务，请稍后读取任务状态');
    this.admitting = true;
    try {
      const receiver = await this.resolveReceiver();
      if (!receiver?.config.stateDir) return await this.admit(input, hash);
      const admission = new Store(join(receiver.config.stateDir, 'operations'));
      return await admission.locked(async () => {
        if ((await this.resolveReceiver())?.config.stateDir !== receiver.config.stateDir)
          fail('CONFIGURATION_CHANGED', '登记期间台账目录已变化，请刷新核对；业务未开始');
        return this.admit(input, hash);
      });
    } catch (error) {
      if (error.code === 'WRITER_LOCKED') fail('OPERATION_RUNNING', '另一执行器正在登记原任务，请查询状态，不重复发起');
      throw error;
    } finally {
      this.admitting = false;
    }
  }
  async admit(input, hash) {
    const receiver = await this.resolveReceiver();
    if (!receiver) fail('CONFIGURATION_REQUIRED', '先保存真实仓库配置');
    if (receiver.config.bindingId && input.expectedBinding !== receiver.config.bindingId)
      fail('CONFIGURATION_CHANGED', '仓库绑定已变化，请刷新核对后执行');
    const old =
      this.value?.id === input.requestId && this.value.bindingId === receiver.config.bindingId
        ? this.value
        : await readTask(receiver.config, input.requestId);
    if (old) {
      if (old.inputHash !== hash) fail('REQUEST_CHANGED', '相同请求标识不能更改任务参数');
      return this.latest(old.id);
    }
    await assertTransferWritable(receiver.config);
    if (this.busy() || running.has((await this.latest())?.status))
      fail('OPERATION_RUNNING', '已有任务正在执行，请读取原任务；不能重复发起');
    this.config = receiver.config;
    this.writes = Promise.resolve();
    this.controller = new AbortController();
    const allowCancel = ['heads', 'adopt', 'tags', 'prepare', 'inspect-baseline', 'preview-sync'].includes(
      input.action,
    );
    this.context = {
      signal: this.controller.signal,
      taskId: input.requestId,
      action: input.action,
      deliveryId: input.deliveryId,
      associate: (id) => {
        this.associateAdmission(id);
        this.value.deliveryId = id;
        this.value.deliveryIds ??= [];
        if (id && !this.value.deliveryIds.includes(id)) this.value.deliveryIds.push(id);
        this.persist();
      },
      allowCancel,
      cancellable: allowCancel,
      report: (event) => this.report(event),
    };
    this.value = {
      schema: 2,
      ...(this.projectId ? { projectId: this.projectId } : {}),
      id: input.requestId,
      inputHash: hash,
      ownerPid: process.pid,
      bindingId: receiver.config.bindingId,
      deliveryId: input.deliveryId || null,
      configSnapshot: configSnapshot(receiver.config),
      action: input.action,
      status: 'RUNNING',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      cancellable: allowCancel,
      steps: taskPlan(input.action).map((step) => ({
        ...step,
        ...phaseLocation(input.action, step.key),
      })),
    };
    try {
      await saveTask(this.config, this.value, true);
    } catch {
      this.value.status = 'FAILED';
      this.value.error = {
        code: 'TASK_STORE_FAILED',
        message: '任务登记失败，业务未执行；请修复私有目录后只补存记录',
      };
      this.value.finishedAt = new Date().toISOString();
      this.terminal = structuredClone(this.value);
      await saveTask(this.config, this.terminal).catch(() => {});
      this.recordFailed();
      fail('TASK_STORE_FAILED', '任务无法安全登记，尚未开始执行；请核对私有目录');
    }
    this.executing = true;
    this.job = this.execute(input);
    return publicTask(this.value, true);
  }
  persist() {
    const snapshot = structuredClone(this.value);
    this.writes = this.writes.catch(() => {}).then(() => saveTask(this.config, snapshot));
    this.writes.catch(() => {});
  }
  associateAdmission(id) {
    if (!id) return;
    const byId = new Map(this.value.steps.map((step) => [step.id, step]));
    let root = this.step;
    while (root && root.key !== 'delivery-start') root = byId.get(root.parentId);
    if (!root || root.status !== 'RUNNING' || root.deliveryId) return;
    // Admission downloads can finish before the delivery identity exists. Scope only
    // this live subtree; genuine round scans and previously accepted work stay intact.
    const children = new Map();
    for (const step of this.value.steps) {
      if (!children.has(step.parentId)) children.set(step.parentId, []);
      children.get(step.parentId).push(step);
    }
    const pending = [root];
    while (pending.length) {
      const step = pending.pop();
      if (step.deliveryId && step.deliveryId !== id) continue;
      step.deliveryId = id;
      pending.push(...(children.get(step.id) ?? []));
    }
  }
  report(event) {
    if (!['RUNNING', 'CANCELLING'].includes(this.value?.status)) return;
    if (event.kind === 'start') {
      this.startPhase(event);
    } else if (event.kind === 'progress' && this.step) {
      const { phase, percent, completed, total } = event;
      this.step.progress = { phase, percent, completed, total, observedAt: new Date().toISOString() };
      if (!this.progressDue()) return;
    } else if (['done', 'failed'].includes(event.kind)) {
      const step = this.value.steps.findLast((item) => item.key === event.id && item.status === 'RUNNING');
      if (!step) return;
      step.status = event.kind === 'done' ? 'DONE' : 'FAILED';
      step.finishedAt = new Date().toISOString();
      if (event.error) step.error = event.error;
      this.step = this.value.steps.findLast((item) => item.status === 'RUNNING');
    }
    this.value.updatedAt = new Date().toISOString();
    this.persist();
  }
  startPhase(event) {
    const parent = this.step;
    let step = this.value.steps.find((step) => step.key === event.id && step.status === 'PENDING');
    if (!step) {
      step = {
        id: `${event.id}-${this.value.steps.length}`,
        key: event.id,
        label: event.label,
      };
      this.value.steps.push(step);
    }
    step.status = 'RUNNING';
    if (this.value.deliveryId) step.deliveryId = this.value.deliveryId;
    Object.assign(step, phaseLocation(this.value.action, event.id, parent));
    if (parent) step.parentId = parent.id;
    step.startedAt = new Date().toISOString();
    this.step = step;
    this.value.cancellable = event.cancellable;
  }
  progressDue() {
    if (Date.now() - (this.lastProgressSave ?? 0) < 500) return false;
    this.lastProgressSave = Date.now();
    return true;
  }
  async execute(input) {
    try {
      const result = await runExecution(this.context, () => this.perform(input));
      this.value.result = ['heads', 'tags', 'inspect-baseline', 'preview-sync'].includes(input.action) ? result : null;
      this.value.status = 'SUCCEEDED';
    } catch (error) {
      const failure = this.context.stopUnconfirmed
        ? {
            code: 'STOP_UNCONFIRMED',
            message: '无法确认进程树停止；保留执行锁，请在本机核对后恢复',
            safeToDisplay: true,
          }
        : error;
      this.value.status =
        failure.code === 'OPERATION_CANCELLED'
          ? 'CANCELLED'
          : failure.code === 'STOP_UNCONFIRMED'
            ? 'STOP_UNCONFIRMED'
            : 'FAILED';
      this.value.error = safeError(failure);
      let step = this.step ?? this.value.steps.findLast((step) => step.status === 'FAILED');
      if (!step) {
        step = {
          id: 'execution-failed',
          key: 'execution-failed',
          ...phaseLocation(this.value.action, 'execution-failed'),
          label: '启动 / 执行任务',
          status: 'FAILED',
        };
        this.value.steps.push(step);
      }
      step.status = 'FAILED';
      step.error = this.value.error;
    }
    this.value.finishedAt = new Date().toISOString();
    this.value.updatedAt = this.value.finishedAt;
    this.value.cancellable = false;
    this.terminal = structuredClone(this.value);
    this.persist();
    try {
      await this.writes;
    } catch {
      this.recordFailed();
    }
    this.executing = false;
  }
  recordFailed() {
    this.persistencePending = true;
    this.value.persistence = {
      status: 'FAILED',
      error: {
        code: 'TASK_STORE_FAILED',
        message:
          '执行记录未完整保存。修复文件占用或写权限后，只补存原任务记录，不重跑 Git 或创建 PR；当前业务状态与台账仍需核对。',
      },
    };
  }
  async retryPersistence(id) {
    if (this.value?.id !== id || !this.persistencePending || !this.terminal)
      fail('NO_PENDING_RECORD', '当前执行器没有该任务的待保存记录；不能猜测或重跑旧任务');
    if (this.executing || this.repairing) fail('OPERATION_RUNNING', '任务或补存正在执行，请查询原记录');
    if ((await this.resolveReceiver())?.config.bindingId !== this.config.bindingId)
      fail('CONFIGURATION_CHANGED', '绑定已变化，先恢复原绑定，不能补存到另一套仓库');
    this.repairing = true;
    try {
      await this.writes.catch(() => {});
      await saveTask(this.config, this.terminal, true);
      this.value = structuredClone(this.terminal);
      this.persistencePending = false;
      return this.latest(id);
    } catch {
      this.recordFailed();
      fail('TASK_STORE_FAILED', '原任务记录仍无法保存，请修复文件占用和目录写权限；业务没有重跑');
    } finally {
      this.repairing = false;
    }
  }
  async cancel(id) {
    if (this.value?.id !== id || !this.job) fail('OPERATION_NOT_OWNED', '当前执行器不拥有这笔任务，不能在此取消');
    if (!this.busy()) return publicTask(this.value, true);
    if (!this.context.cancellable || this.value.status === 'STOP_UNCONFIRMED')
      fail('CANCEL_NOT_ALLOWED', '当前正在提交结果或执行同步恢复；请等待并回读真实结果');
    this.value.status = 'CANCELLING';
    this.value.cancellable = false;
    this.persist();
    this.controller.abort();
    return publicTask(this.value, true);
  }
  async close() {
    if (this.busy() && this.context?.cancellable) {
      try {
        await this.cancel(this.value.id);
      } catch (error) {
        if (error.code !== 'CANCEL_NOT_ALLOWED') throw error;
      }
    }
    await this.job;
    if (this.persistencePending) await this.retryPersistence(this.value.id);
  }
}
