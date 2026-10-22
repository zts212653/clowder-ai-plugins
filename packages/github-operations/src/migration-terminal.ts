import type { FeatureContext, PluginTaskReadItem } from '@clowder-ai/plugin-sdk';
import type { MigrationTask } from './migration-plan.js';
import { historyKey, taskBinding } from './migration-plan.js';
import { canonicalBytes, migrationKey } from './migration-source.js';

interface TerminalImport {
  readonly planDigest: string;
  readonly sourceDigest: string;
  readonly userId: string;
  readonly phase: string;
}

/** Owner recovery may preserve a newly closed, never-bound Task as history.
 * It never changes the frozen plan or writes/reopens the canonical Host Task. */
export async function retireClosedImportedWait(
  context: FeatureContext, journal: TerminalImport, row: MigrationTask,
  target: string, originalRecord: unknown, hasBindingAck: boolean, check: () => Promise<void>,
): Promise<boolean> {
  if (row.mode !== 'typed' || !['committing', 'committed'].includes(journal.phase)) return false;
  const source = row.task;
  const key = `github.migration.terminal.v1.${journal.planDigest}.${migrationKey(source.id)}`;
  const prior = await context.storage.get(key);
  const host = await context.tasks.get({ id: source.id });
  const closed = (current: PluginTaskReadItem | null): current is PluginTaskReadItem => !!current
    && !current.entrustedWork && !current.pluginWait && current.status === 'done'
    && current.updatedAt > source.updatedAt && current.userId === journal.userId
    && ['id', 'kind', 'subjectKey', 'threadId', 'ownerCatId'].every(field =>
      current[field as keyof PluginTaskReadItem] === source[field as keyof typeof source]);
  if (!prior && (!closed(host) || hasBindingAck)) return false;
  if (!closed(host) || hasBindingAck || source.automationState?.waitOutcome?.delivery === 'pending'
    || source.automationState?.issue?.pendingWake) throw new Error('Terminal import has an unresolved binding or receipt');

  const proof = { schemaVersion: 1, planDigest: journal.planDigest, sourceDigest: journal.sourceDigest,
    originalBinding: taskBinding(source), closedHost: taskBinding(host) };
  if (prior && canonicalBytes(prior.value) !== canonicalBytes(proof)) throw new Error('Terminal import Host binding changed');
  const active = await context.storage.get(target);
  if (active && canonicalBytes(active.value) !== canonicalBytes(originalRecord)) throw new Error('Terminal import active target changed');
  const historyName = historyKey(source.id);
  const history = { schemaVersion: 1, task: source, sourceUpdatedAt: source.updatedAt, terminalDuringImport: proof };
  const saved = await context.storage.get(historyName);
  if (saved && canonicalBytes(saved.value) !== canonicalBytes(history)) throw new Error('Terminal import history changed');

  // Intent, immutable history, then CAS removal of only the uncollected private
  // copy. Every prefix is replayable; staged bytes and the source remain intact.
  await check();
  if (!prior && !(await context.storage.compareAndSet(key, null, proof)).applied)
    throw new Error('Terminal import admission raced');
  await check();
  if (!saved && !(await context.storage.compareAndSet(historyName, null, history)).applied)
    throw new Error('Terminal import history raced');
  await check();
  const current = await context.tasks.get({ id: source.id });
  if (!closed(current) || canonicalBytes(taskBinding(current)) !== canonicalBytes(proof.closedHost))
    throw new Error('Terminal import Host binding changed');
  if (active && !(await context.storage.delete(target, active.revision)).deleted)
    throw new Error('Terminal import private copy changed');
  await check();
  return true;
}
