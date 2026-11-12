import { createHash } from 'node:crypto';
import type { PluginStorageHost } from '@clowder-ai/plugin-sdk';
import type { TaskItem } from './business/model/index.js';
import { OwnerIndexedStorage } from './owner-indexed-storage.js';
import { recoveryOwnerNotice, recoveryNoticeScore, type RecoveryOwnerNotice } from './recovery-owner-notice.js';
import type { RecoveryErrorFacts } from './recovery-attempt.js';
import { resumeLegacyNetworkFailure } from './observation-recovery.js';

export const collectionPrefix = 'community.collection.v1.';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const collectionId = (subject: string) => 'community-collection:' + hash(subject);
export const collectionKey = (id: string) => {
  if (!/^community-collection:[a-f0-9]{64}$/.test(id)) throw new TypeError('Invalid collection id');
  return collectionPrefix + id.slice('community-collection:'.length);
};
export function collectionTarget(subject: string) {
  const match = /^(pr|issue):([a-z0-9_.-]+\/[a-z0-9_.-]+)#([1-9]\d*)$/.exec(subject);
  if (!match || match[0] !== subject || match[2]!.split('/').some(x => x === '.' || x === '..') || !Number.isSafeInteger(Number(match[3]))) throw new TypeError('Invalid collection subject');
  return { kind: match[1] as 'pr' | 'issue', repoFullName: match[2]!, number: Number(match[3]) };
}
export interface CollectionRecord {
  readonly schemaVersion: 1; readonly task: TaskItem;
  readonly route?: { sequence: number; sourceEventId: string };
  readonly recovery?: RecoveryErrorFacts & { v: 1; scope: string; revision: number; failures: number; nextAt: number; disposition?: 'needs_attention'; reasonCode?: string; lastNoticeKey?: string };
  readonly notice?: RecoveryOwnerNotice;
}
export function decodeCollection(value: unknown, key?: string): CollectionRecord {
  const record = value as CollectionRecord;
  if (!record || record.schemaVersion !== 1 || !record.task?.subjectKey || collectionId(record.task.subjectKey) !== record.task.id ||
    `${collectionTarget(record.task.subjectKey).kind}_tracking` !== record.task.kind || record.task.pluginWait || record.task.automationState?.await || record.task.automationState?.waitOutcome) throw new Error('Invalid private collection record');
  if (record.route && (!Number.isSafeInteger(record.route.sequence) || record.route.sequence < 0 || !record.route.sourceEventId)) throw new Error('Invalid collection route version');
  if (key !== undefined && key !== collectionKey(record.task.id)) throw new Error('Collection source key identity mismatch');
  return record;
}
export const collectionIndex = (kind: 'pr' | 'issue') => `github-collection-${kind}`;
export function collectionIndexOwner(storage: PluginStorageHost) {
  return new OwnerIndexedStorage(storage, { prefix: collectionPrefix, census: 'community.collection.census.v2',
    indexes: [collectionIndex('pr'), collectionIndex('issue')],
    validate: (key, value) => { decodeCollection(value, key); },
    materialize(value, key, selectedIndex) {
      if (value && typeof value === 'object' && '_collectionRecoveryCorruption' in value) return value;
      try {
        const record = decodeCollection(value, key);
        const scope = hash(JSON.stringify([record.task.id, record.route?.sourceEventId, record.task.threadId, record.task.ownerCatId]));
        const old = record.recovery;
        if (old && (old.v !== 1 || !Number.isSafeInteger(old.revision) || !Number.isSafeInteger(old.failures) || old.failures < 0 || !Number.isFinite(old.nextAt)
          || old.retryable !== undefined && typeof old.retryable !== 'boolean'))
          throw new Error('Invalid collection recovery facts');
        const recovery = resumeLegacyNetworkFailure(old?.scope === scope ? old : { v: 1 as const, scope, revision: 0, failures: 0, nextAt: 0 });
        const intent = recoveryOwnerNotice('collection', scope, record.task.threadId, record.task.subjectKey!);
        const notice = recovery !== old && old?.disposition && recovery.retryable && record.notice?.state === 'pending'
          ? { ...record.notice, state: 'cancelled' as const }
          : record.notice ?? (recovery.disposition && intent?.key !== recovery.lastNoticeKey ? intent : undefined);
        return { ...record, recovery, notice };
      } catch {
        const original = value as Partial<CollectionRecord> | null;
        return { _collectionRecoveryCorruption: value, disposition: 'needs_attention', reasonCode: 'invalid_collection_source',
          recoveryIndex: selectedIndex ?? collectionIndex(original?.task?.kind === 'issue_tracking' ? 'issue' : 'pr') };
      }
    },
    projection(value) {
      if (value && typeof value === 'object' && '_collectionRecoveryCorruption' in value)
        return { index: (value as { recoveryIndex?: string }).recoveryIndex ?? collectionIndex('pr'), score: null };
      const record = decodeCollection(value);
      const live = record.task.status === 'doing' && !record.recovery!.disposition ? record.recovery!.nextAt : null;
      const notice = recoveryNoticeScore(record.notice);
      return { index: collectionIndex(collectionTarget(record.task.subjectKey!).kind),
        score: live === null ? notice : notice === null ? live : Math.min(live, notice) };
    },
  });
}
