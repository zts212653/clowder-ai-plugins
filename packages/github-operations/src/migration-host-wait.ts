import type { FeatureContext } from '@clowder-ai/plugin-sdk';
import type { TaskItem } from './business/model/index.js';
import { importedProjectionMatches, importedWait } from './migration-wait.js';

interface MigrationJournalView {
  v: number;
  phase: string;
  tasks: readonly { id: string; mode: string }[];
}

/** Only retained Host waits use Host Tasks. New private subscriptions
 * remain independent of Host Tasks, including while imported waits coexist. */
export async function assertMigratedWaitCurrent(context: FeatureContext, task: TaskItem) {
  const entry = await context.storage.get('github.migration.control.v1');
  if (!entry) return;
  const journal = entry.value as MigrationJournalView | null;
  if (journal?.v !== 1 || !Array.isArray(journal.tasks)) throw new Error('Invalid migration journal; retain the wait');
  if (!journal.tasks.some(row => row.id === task.id && row.mode === 'typed')) return;
  if (journal.phase !== 'released') throw new Error('Imported Host wait remains on hold');
  const host = await context.tasks.get({ id: task.id });
  const generations = [task.automationState?.await?.generation, task.automationState?.waitOutcome?.generation];
  if (!host || host.entrustedWork || host.kind !== task.kind || host.subjectKey !== task.subjectKey
    || host.userId !== task.userId || host.ownerCatId !== task.ownerCatId || host.threadId !== task.threadId
    || host.pluginWait?.pluginInstanceId !== context.pluginInstanceId || !generations.includes(host.pluginWait.generation)
    || host.status === 'done' && task.automationState?.await && !task.automationState.waitOutcome) {
    throw new Error('Imported Host owner or wait binding changed; retain the private state');
  }
  return host;
}

/** A background delivery may update an existing imported projection, but can
 * never manufacture its original authenticated first binding. */
export async function projectMigratedWait(context: FeatureContext, task: TaskItem, check: () => Promise<void>) {
  await check();
  const host = await assertMigratedWaitCurrent(context, task);
  if (!host) return;
  if (task.automationState?.waitOutcome?.delivery !== 'pending'
    && importedProjectionMatches(host, task, context.pluginInstanceId)) return;
  const wait = importedWait(task);
  await check();
  const updated = await context.tasks.update(task.id, {
    wait: { expectedGeneration: host.pluginWait!.generation, ...wait },
  }, { expectedThreadId: task.threadId });
  if (!updated) throw new Error('Imported Host projection changed; recover the existing generation');
  await check();
}
