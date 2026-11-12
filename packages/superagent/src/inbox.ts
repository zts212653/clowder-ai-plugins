import type { PluginDeliveryInput, PluginMessageDelivery } from '@clowder-ai/plugin-contract';
import { z } from 'zod';
import type { SuperagentHost } from './runtime.js';
import {
  editQueue,
  inboxSchema,
  type Preferences,
  type WorkLink,
  queued,
  read,
  records,
  runtimeSchema,
  saveOnce,
  workSchema,
} from './state.js';
import { send } from './work.js';

async function needsCoordination(host: SuperagentHost, input: PluginMessageDelivery, assignedWork: WorkLink | undefined) {
  if (assignedWork && input.envelope.actor.kind !== 'user' &&
    (await host.messaging.get(assignedWork.sourceMessageId))?.catId) return false;
  if (assignedWork || input.envelope.actor.kind === 'user') return true;
  if (input.envelope.actor.kind !== 'cat') return false;
  const response = (await host.threads.readMessages(input.threadId, { limit: 100 })).find(
    (message) => message.id === input.envelope.messageId && message.sender.catId === input.envelope.actor.id,
  )?.response;
  return response !== undefined && response.status !== 'processing' && response.status !== 'completed';
}

export async function observe(
  host: SuperagentHost,
  input: PluginDeliveryInput,
  pref: Preferences,
  mainThreadId: string | undefined,
) {
  // Execution-status IDs are opaque and are not the invocation IDs in response history.
  // The published terminal message supplies the exact response identity instead.
  if (input.kind === 'execution_status') return;
  const works = await records(host, 'work:', workSchema);
  const work = works.find((entry) => entry.threadId === input.threadId);
  if (input.envelope.actor.kind === 'plugin' && input.envelope.actor.id === host.pluginInstanceId) return;
  if (
    input.threadId === mainThreadId &&
    input.envelope.actor.kind === 'cat' &&
    input.envelope.actor.id === pref.coordinatorId
  )
    return;
  if (!pref.threadIds.includes(input.threadId) && input.threadId !== mainThreadId && !work) return;
  if (work && input.envelope.actor.kind === 'cat' && input.envelope.actor.id === work.workerId) {
    const response = (await host.threads.readMessages(input.threadId, { limit: 100 })).find(
      (message) => message.id === input.envelope.messageId && message.sender.catId === work.workerId,
    )?.response;
    if (work.taskId && response && response.status !== 'processing' && response.status !== 'completed') {
      const report = {
        workId: work.taskId,
        reportId: 'host-failure',
        kind: 'error' as const,
        content: `执行成员本轮未完成（${response.status}）。工作与历史保留，请在原工作线程检查后继续。`,
        applied: false,
        invocationId: response.executionId,
      };
      await saveOnce(host, `report:${response.executionId}:host-failure`, report);
      await editQueue(host, 'reports', `${response.executionId}:host-failure`, true);
      return;
    }
    const message = await host.messaging.get(input.envelope.messageId);
    const invocationId = message?.extra?.stream?.invocationId;
    if (invocationId) {
      const terminal = await read(host, `terminal:${invocationId}`, z.object({ workId: z.string() }));
      if (terminal?.workId === work.taskId) return;
    }
  }
  if (!(await needsCoordination(host, input, work))) return;
  const existing = await read(host, `inbox:${input.deliveryId}`, inboxSchema);
  if (!existing)
    await host.storage.compareAndSet(`inbox:${input.deliveryId}`, null, {
      delivery: input,
      phase: 'pending',
      receivedAt: Date.now(),
    });
  if (!existing || existing.phase !== 'done') await editQueue(host, 'inbox', input.deliveryId, true);
}

export async function advanceInbox(host: SuperagentHost, pref: Preferences, mainThreadId: string) {
  const inbox = await queued(host, 'inbox', 'inbox:', inboxSchema);
  const routed = inbox.find((entry) => entry.phase === 'routed');
  if (routed) {
    const response = (await host.threads.readMessages(mainThreadId, { limit: 100 })).find(
      (message) =>
        message.sender.catId === pref.coordinatorId &&
        message.response?.inputMessageIds.includes(routed.wakeMessageId ?? routed.delivery.envelope.messageId),
    );
    if (response?.response && response.response.status !== 'processing') {
      await send(
        host,
        mainThreadId,
        `coordination-failure:${routed.delivery.deliveryId}:${routed.attempt}`,
        '助手本轮已结束，但还没有完成待办判断。原事件与工作已保留；请在插件设置的“恢复处理”中重试本次判断。不会自动重复调用模型。',
      );
      await host.storage.set(`inbox:${routed.delivery.deliveryId}`, {
        ...routed,
        phase: 'failed',
      });
      throw new Error(`协调成员本轮已结束（${response.response.status}），尚未记录判断。可在插件设置中重试本次判断。`);
    }
    return;
  }
  const next = inbox.filter((entry) => entry.phase === 'pending').sort((a, b) => a.receivedAt - b.receivedAt)[0];
  if (!next) return;
  const works = await records(host, 'work:', workSchema);
  if (
    !pref.threadIds.includes(next.delivery.threadId) &&
    next.delivery.threadId !== mainThreadId &&
    !works.some((work) => work.threadId === next.delivery.threadId)
  ) {
    await host.storage.set(`inbox:${next.delivery.deliveryId}`, {
      ...next,
      phase: 'done',
    });
    await editQueue(host, 'inbox', next.delivery.deliveryId, false);
    return;
  }
  if (!(await needsCoordination(host, next.delivery, works.find((work) => work.threadId === next.delivery.threadId)))) {
    await host.storage.set(`inbox:${next.delivery.deliveryId}`, { ...next, phase: 'done' });
    await editQueue(host, 'inbox', next.delivery.deliveryId, false);
    return;
  }
  let wakeMessageId = next.delivery.envelope.messageId;
  if (next.delivery.threadId !== mainThreadId || next.attempt > 0) {
    const sent = await send(
      host,
      mainThreadId,
      `coordinate:${next.delivery.deliveryId}:${next.attempt}`,
      `Superagent 收到待处理事件：${JSON.stringify({
        eventId: next.delivery.deliveryId,
        sourceThreadId: next.delivery.threadId,
        sourceMessageId: next.delivery.envelope.messageId,
      })}\n先用 plugin_list_tools 读取 official.superagent 的工具定义，再通过 plugin_call 调用 superagent_inspect；按返回指引用 superagent_route 登记判断。只汇报成果、阻塞与必要决定，不复述工具过程。`,
      pref.coordinatorId,
    );
    wakeMessageId = sent.messageId;
  }
  await host.storage.set(`inbox:${next.delivery.deliveryId}`, {
    ...next,
    wakeMessageId,
    phase: 'routed',
  });
}

export async function clearRecoveredError(host: SuperagentHost) {
  const runtime = await read(host, 'runtime', runtimeSchema);
  if (
    runtime?.error &&
    !(await queued(host, 'inbox', 'inbox:', inboxSchema)).some((entry) => entry.phase === 'failed')
  ) {
    const { error: _previousError, ...recovered } = runtime;
    await host.storage.set('runtime', recovered);
  }
}
