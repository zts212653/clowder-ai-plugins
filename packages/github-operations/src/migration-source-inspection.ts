import type { FeatureContext } from '@clowder-ai/plugin-sdk';
import { canonicalBytes, sourceDigest } from './migration-source.js';

/** The ordinary SDK read is useful evidence, but lacks legacy private fields.
 * Never fabricate a complete cut from this reduced projection. */
export async function inspectGitHubSource(context: FeatureContext, check: () => Promise<void>) {
  await check();
  const tasks = [...await context.tasks.list({ kind: 'pr_tracking' }), ...await context.tasks.list({ kind: 'issue_tracking' })];
  await check();
  const metadata = tasks.filter(task => task.status !== 'done').map(task => ({ id: task.id, kind: task.kind, subjectKey: task.subjectKey,
    threadId: task.threadId, ownerCatId: task.ownerCatId, userId: task.userId, status: task.status, updatedAt: task.updatedAt }));
  if (metadata.length > 1000 || Buffer.byteLength(canonicalBytes(metadata)) > 1024 * 1024) throw new Error('Source inspection exceeds bounded task scope');
  return { data: { complete: false, prTasks: metadata.filter(t => t.kind === 'pr_tracking').length,
    issueTasks: metadata.filter(t => t.kind === 'issue_tracking').length, historicalTasksOutsideProjection: tasks.length - metadata.length,
    projectionDigest: sourceDigest(metadata),
    unavailable: [
      { family: 'tracking', fields: ['automationState', 'typedWaitRegistration'],
        existingRead: 'TaskStore.getWaitRegistration(id) in the original owner; generic SDK Task reads omit these fields' },
      { family: 'repositories/progress', fields: ['repo configuration', 'baseline', 'notified set', 'comment cursor'],
        existingRead: 'Original source adapters or a bounded immutable GitHub-only operations export; not new plugin KV' },
      { family: 'pending-receipts', fields: ['outcomeId/messageId', 'append receipt', 'wake receipt', 'unfinished claims'],
        existingRead: 'Original delivery ledger scoped to the selected task IDs and registered repositories' },
    ],
    requiredProducer: 'Bind read-only source adapters to a bounded GitHub-only immutable cut of live tracking plus unfinished receipts (including terminal Tasks with pending delivery). Retain hidden registration bodies at source; export only presence/digest/reference. Compare two cuts with freezeGitHubSource. No chat/secret/full-store export and no Redis6399 access.',
  } };
}
