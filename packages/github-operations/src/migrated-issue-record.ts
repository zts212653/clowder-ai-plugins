import { createHash } from 'node:crypto';
import type { PluginStorageHost, PluginStorageProjection } from '@clowder-ai/plugin-sdk';
import type { TaskItem } from './business/model/index.js';
import { OwnerIndexedStorage } from './owner-indexed-storage.js';
import { recoveryOwnerNotice, recoveryNoticeScore, type RecoveryOwnerNotice } from './recovery-owner-notice.js';

export const MIGRATED_ISSUES = 'github.migrated-issue.v1.';
export const MIGRATED_ISSUE_INDEX = 'github-migrated-issues';
export const migratedIssueKey = (id: string) => MIGRATED_ISSUES + createHash('sha256').update(id).digest('hex');
export interface MigratedIssueRecord {
  schemaVersion: 1; task: TaskItem; sourceUpdatedAt: number;
  outbox?: { key: string; content: string; cursor: number; terminal: boolean };
  recovery?: { v: 1; scope: string; revision: number; failures: number; nextAt: number; disposition?: 'needs_attention'; reasonCode?: string; lastNoticeKey?: string };
  notice?: RecoveryOwnerNotice;
}
export function decodeMigratedIssue(value: unknown, key?: string): MigratedIssueRecord {
  const row = value as MigratedIssueRecord;
  if (!row || row.schemaVersion !== 1 || row.task?.kind !== 'issue_tracking' || row.task.automationState?.await
    || !row.task.id || !row.task.userId || !row.task.ownerCatId || !Number.isFinite(row.sourceUpdatedAt))
    throw new Error('Invalid migrated issue record');
  if (key !== undefined && key !== migratedIssueKey(row.task.id)) throw new Error('Migrated issue source key identity mismatch');
  return row;
}
export function materializeMigratedIssue(value: unknown, key?: string): unknown {
  if (value && typeof value === 'object' && '_migratedIssueRecoveryCorruption' in value) return value;
  try {
    const row = decodeMigratedIssue(value, key);
    const scope = createHash('sha256').update(JSON.stringify([row.task.id, row.task.threadId, row.task.ownerCatId,
      row.task.userId, row.sourceUpdatedAt])).digest('hex');
    const previous = row.recovery;
    if (previous && (previous.v !== 1 || !Number.isSafeInteger(previous.revision) || !Number.isSafeInteger(previous.failures)
      || previous.failures < 0 || !Number.isFinite(previous.nextAt) || previous.scope !== scope)) throw new Error('Invalid migrated issue recovery facts');
    const recovery = previous ?? { v: 1 as const, scope, revision: 0, failures: 0, nextAt: 0 };
    const intent = recoveryOwnerNotice('migrated-issue', scope, row.task.threadId, row.task.subjectKey ?? row.task.id);
    const notice = row.notice ?? (recovery.disposition && intent?.key !== recovery.lastNoticeKey ? intent : undefined);
    return { ...row, recovery, notice };
  } catch { return { _migratedIssueRecoveryCorruption: value, disposition: 'needs_attention', reasonCode: 'invalid_migrated_issue_source' }; }
}
export function migratedIssueProjection(value: unknown): PluginStorageProjection {
  if (value && typeof value === 'object' && '_migratedIssueRecoveryCorruption' in value)
    return { index: MIGRATED_ISSUE_INDEX, score: null };
  const row = decodeMigratedIssue(value);
  const live = (row.task.status !== 'done' || !!row.outbox) && !row.recovery!.disposition ? row.recovery!.nextAt : null;
  const notice = recoveryNoticeScore(row.notice);
  return { index: MIGRATED_ISSUE_INDEX, score: live === null ? notice : notice === null ? live : Math.min(live, notice) };
}
export function migratedIssueIndexOwner(storage: PluginStorageHost) {
  return new OwnerIndexedStorage(storage, { prefix: MIGRATED_ISSUES, census: 'github.migrated-issue.census.v1',
    indexes: [MIGRATED_ISSUE_INDEX], materialize: materializeMigratedIssue,
    validate: (key, value) => { decodeMigratedIssue(value, key); }, projection: migratedIssueProjection });
}
/** Import publishes canonical facts and their own projection in the same Host operation. Pure planning uses the same value rule. */
export async function publishMigratedIssue(storage: PluginStorageHost, key: string, revision: number | null, value: unknown) {
  if (!storage.compareAndSetIndexed) throw new Error('Indexed private storage is unavailable before migrated collection');
  const row = materializeMigratedIssue(value, key);
  return storage.compareAndSetIndexed(key, revision, row, migratedIssueProjection(row));
}
