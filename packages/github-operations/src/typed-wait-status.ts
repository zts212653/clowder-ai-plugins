import type { TaskItem } from './business/model/index.js';
import { hasWaitWork } from './typed-wait-recovery.js';

/** Business status and observer health are separate facts; inspection never rewrites either. */
export function typedWaitPolling(task: TaskItem, facts: Record<string, unknown>) {
  return {
    state: !hasWaitWork(task) ? 'inactive' : facts.disposition === 'needs_attention' ? 'paused'
      : facts.retryable === true && typeof facts.failures === 'number' && facts.failures > 0 ? 'backing_off'
      : facts.v === 1 ? 'scheduled' : 'unprepared',
    ...(typeof facts.failures === 'number' ? { failures: facts.failures } : {}),
    ...(typeof facts.reasonCode === 'string' ? { reasonCode: facts.reasonCode } : {}),
    ...(typeof facts.nextPollAt === 'number' ? { nextPollAt: facts.nextPollAt } : {}),
  };
}
