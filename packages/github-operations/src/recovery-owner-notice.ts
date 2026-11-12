import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { FeatureContext, PluginStorageHost } from '@clowder-ai/plugin-sdk';

export interface RecoveryOwnerNotice {
  key: string; scope: string; threadId: string; subject: string;
  state: 'pending' | 'delivered' | 'needs_attention' | 'cancelled'; failures: number; nextAt: number;
  messageId?: string; archiveAttempts?: number;
}
export type RecoveryNoticeSender = (notice: RecoveryOwnerNotice) => Promise<{ messageId: string }>;
export function recoveryOwnerNotice(owner: string, scope: string, threadId: string | undefined, subject: string, revision?: number): RecoveryOwnerNotice | undefined {
  if (!threadId) return undefined;
  return { key: `github-recovery:${owner}:${scope}${revision === undefined ? '' : `:${revision}`}`, scope, threadId, subject,
    state: 'pending', failures: 0, nextAt: 0 };
}
export function recoveryNoticeScore(notice: RecoveryOwnerNotice | undefined): number | null {
  return notice && (notice.archiveAttempts ?? 0) < 5 ? notice.nextAt : null;
}
export function sendRecoveryOwnerNotice(context: FeatureContext): RecoveryNoticeSender {
  return notice => context.messaging.send(notice.threadId, { identity: 'github-notification', idempotencyKey: notice.key,
    payload: { provenance: { epistemicStatus: 'observation' }, elements: [{ kind: 'text', elementId: notice.key,
      payload: { text: `GitHub automatic recovery paused after repeated failures: ${notice.subject}. Original history and responsibility are retained for inspection.` } }] } });
}

/** Delivery mechanics only. The caller commits this result through its original record's exact CAS. */
export async function advanceRecoveryNotice(storage: PluginStorageHost, notice: RecoveryOwnerNotice,
  send: RecoveryNoticeSender | undefined, now: number): Promise<RecoveryOwnerNotice | undefined> {
  if (notice.nextAt > now || (notice.archiveAttempts ?? 0) >= 5) return notice;
  if (notice.state === 'pending') {
    try {
      if (!send) throw new Error('Owner notification service unavailable');
      const receipt = await send(notice);
      if (!receipt.messageId) throw new Error('Owner notification receipt unavailable');
      return { ...notice, state: 'delivered', messageId: receipt.messageId, nextAt: 0 };
    } catch {
      const failures = notice.failures + 1;
      return { ...notice, failures, nextAt: failures >= 5 ? 0 : now + 60_000,
        state: failures >= 5 ? 'needs_attention' : 'pending' };
    }
  }
  const key = 'github.recovery-notice.archive.' + createHash('sha256').update(notice.key).digest('hex');
  const archived = { key: notice.key, scope: notice.scope, threadId: notice.threadId, subject: notice.subject,
    state: notice.state, failures: notice.failures, ...(notice.messageId ? { messageId: notice.messageId } : {}) };
  try {
    const existing = await storage.get(key);
    if (!existing) {
      if (!(await storage.compareAndSet(key, null, archived)).applied) {
        if (!isDeepStrictEqual((await storage.get(key))?.value, archived)) throw new Error('Notice archive identity changed');
      }
    } else if (!isDeepStrictEqual(existing.value, archived)) throw new Error('Notice archive identity conflict');
    return undefined;
  } catch {
    return { ...notice, archiveAttempts: (notice.archiveAttempts ?? 0) + 1, nextAt: now + 60_000 };
  }
}
