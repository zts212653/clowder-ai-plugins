import { createHash } from 'node:crypto';
import type { PluginStorageHost } from '@clowder-ai/plugin-sdk';
import type { TaskItem, WaitTerminationEventV1 } from './business/model/index.js';
import { reconcileWaitRecovery, waitRecoveryScore, type GitHubWaitRecoveryFacts } from './typed-wait-recovery.js';
export const WAIT_PREFIX = 'github.typed-wait.v1.';
export const waitKey = (id: string) => WAIT_PREFIX + createHash('sha256').update(id).digest('hex');
/** Native registration identity. Imported waits retain their original arbitrary Task IDs. */
export const nativeSubscriptionId = (subject: string, owner: { userId: string; catId: string; threadId: string }) =>
  'github-subscription-' + createHash('sha256').update(JSON.stringify([subject, owner.userId, owner.catId, owner.threadId])).digest('hex');
export interface RegistrationRequest { readonly id: string; readonly fingerprint: string }
export type WaitRecordV1 = {
  readonly schemaVersion: 1; readonly task: TaskItem;
  readonly registrations?: Readonly<Record<string, RegistrationRequest & { readonly result: TaskItem }>>;
  readonly lifecycleEvents?: readonly WaitTerminationEventV1[];
  readonly recovery?: GitHubWaitRecoveryFacts;
  recoveryRetries?: readonly { scope: string; revision: number; at: number; failures: number }[];
};
export function decodeWaitTask(value: unknown): TaskItem {
  const record = value as Partial<WaitRecordV1> | null;
  if (!record || record.schemaVersion !== 1 || !record.task || typeof record.task.id !== 'string' ||
    typeof record.task.updatedAt !== 'number' || !['pr_tracking', 'issue_tracking'].includes(record.task.kind))
    throw new Error('Invalid GitHub typed wait record');
  return record.task;
}
export class IndexedWaitStorageUnavailableError extends Error {
  constructor() { super('Indexed private storage is unavailable; update the Host before registration or collection'); }
}
export function hasWaitStorage(storage: PluginStorageHost): boolean {
  return !!(storage.compareAndSetIndexed && storage.readDue && storage.rebuildIndex && storage.scan);
}
export function assertWaitStorage(storage: PluginStorageHost): asserts storage is PluginStorageHost & Required<Pick<PluginStorageHost,
  'compareAndSetIndexed' | 'readDue' | 'rebuildIndex' | 'scan'>> {
  if (!hasWaitStorage(storage))
    throw new IndexedWaitStorageUnavailableError();
}
/** All native, migration, lifecycle and metadata writers use this one original-owner CAS. */
export async function publishWaitRecord(storage: PluginStorageHost, name: string, revision: number | null,
  record: WaitRecordV1, now: number, intervalMs: number) {
  if (!storage.compareAndSetIndexed) throw new IndexedWaitStorageUnavailableError();
  const recovery = reconcileWaitRecovery(record.task, record.recovery, now, intervalMs);
  return storage.compareAndSetIndexed(name, revision, { ...record, recovery },
    { index: recovery.index, score: waitRecoveryScore(record.task, recovery) });
}
