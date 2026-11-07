import type { GitHubWaitStorage } from './typed-wait-storage.js';
import { hasWaitWork } from './typed-wait-recovery.js';

/** Business status and observer health are separate facts; inspection never rewrites either. */
export async function typedWaitStatus(store: GitHubWaitStorage) {
  const [prs, issues, recovery] = await Promise.all([
    store.listByKind('pr_tracking'), store.listByKind('issue_tracking'), store.recoveryDiagnostics(),
  ]);
  const byId = new Map(recovery.map(row => [row.taskId, row.recovery]));
  const tracking = [...prs, ...issues].map(task => {
    const facts = byId.get(task.id);
    return { ...task, polling: {
      state: !hasWaitWork(task) ? 'inactive' : facts?.disposition === 'needs_attention' ? 'paused'
        : facts && 'v' in facts && facts.v === 1 ? 'scheduled' : 'unprepared',
      ...(facts && 'failures' in facts ? { failures: facts.failures } : {}),
      ...(facts?.reasonCode ? { reasonCode: facts.reasonCode } : {}),
    } };
  });
  return { tracking, recovery };
}
