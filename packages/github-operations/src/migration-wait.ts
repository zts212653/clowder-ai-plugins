import type { PluginTaskReadItem, PluginWaitUpdate } from '@clowder-ai/plugin-sdk';
import type { TaskItem } from './business/model/index.js';

export function importedWait(task: TaskItem): Omit<PluginWaitUpdate, 'expectedGeneration'> {
  const active = task.automationState?.await, outcome = task.automationState?.waitOutcome;
  const generation = Math.max(active?.generation ?? 0, outcome?.generation ?? 0);
  if (!generation) throw new Error('No original wait generation');
  return { generation, active: active ? { ...(active.expiresAt === undefined ? {} : { expiresAt: active.expiresAt }) } : null,
    ...(outcome ? { outcome: { outcomeId: outcome.outcomeId, generation: outcome.generation,
      ownerFence: { kind: 'containing_task', generation: outcome.generation }, reason: outcome.reason, delivery: outcome.delivery } } : {}) };
}
export function importedProjectionMatches(host: PluginTaskReadItem | null, task: TaskItem, instanceId: string) {
  const wait = importedWait(task), projection = host?.pluginWait;
  return !!projection && projection.pluginInstanceId === instanceId && projection.generation === wait.generation
    && (wait.active ? projection.await?.generation === wait.generation && projection.await.expiresAt === wait.active.expiresAt : !projection.await)
    && (wait.outcome ? projection.waitOutcome?.outcomeId === wait.outcome.outcomeId
      && projection.waitOutcome.generation === wait.outcome.generation && projection.waitOutcome.delivery === wait.outcome.delivery : !projection.waitOutcome);
}
