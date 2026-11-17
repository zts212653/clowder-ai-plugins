import { createHash } from 'node:crypto';
import type { TaskItem } from './business/model/index.js';
import { automationGeneration } from './business/domains/github-signals/wait-ports.js';
import type { DiagnosticError } from './tracking-diagnostics.js';
import { resumeLegacyNetworkFailure } from './observation-recovery.js';
export interface GitHubRecoveryNotice {
  key: string; scope: string; userId: string; threadId: string; taskId: string;
  failures: number; nextAt: number; state: 'pending' | 'delivered' | 'owner_unavailable' | 'needs_attention' | 'cancelled';
}
export interface GitHubWaitRecoveryFacts {
  v: 1; scope: string; index: string; revision: number; nextPollAt: number; failures: number;
  disposition?: 'needs_attention'; reasonCode?: string;
  notices: Record<string, GitHubRecoveryNotice>; lastNoticeKey?: string;
  lastError?: DiagnosticError; lastFailureAt?: number;
  retryable?: boolean;
}
export const waitIndex = (kind: TaskItem['kind']) => kind === 'pr_tracking' ? 'github-pr-waits' : 'github-issue-waits';
export const hasWaitWork = (task: TaskItem) => Boolean(task.automationState?.waitOutcome?.delivery === 'pending' ||
  (task.status !== 'done' && task.automationState?.await));
export function waitRecoveryScope(task: TaskItem): string {
  return createHash('sha256').update(JSON.stringify([task.id, task.kind, task.subjectKey, task.userId,
    task.ownerCatId, task.threadId, automationGeneration(task.automationState)])).digest('hex');
}
export function reconcileWaitRecovery(task: TaskItem, previous: GitHubWaitRecoveryFacts | undefined,
  now: number, intervalMs: number): GitHubWaitRecoveryFacts {
  if (previous !== undefined) assertWaitRecovery(previous);
  const scope = waitRecoveryScope(task);
  if (previous?.v === 1 && previous.scope === scope) {
    const resumed = resumeLegacyNetworkFailure(previous), facts = structuredClone(resumed);
    if (resumed !== previous) for (const notice of Object.values(facts.notices))
      if (notice.scope === scope && notice.state === 'pending') notice.state = 'cancelled';
    return facts;
  }
  return { v: 1, scope, index: waitIndex(task.kind), revision: (previous?.revision ?? 0) + 1,
    nextPollAt: previous ? now + intervalMs : now, failures: 0, notices: structuredClone(previous?.notices ?? {}) };
}
export function waitRecoveryScore(task: TaskItem, facts: GitHubWaitRecoveryFacts): number | null {
  const due = Object.values(facts.notices).filter(notice => notice.state === 'pending').map(notice => notice.nextAt);
  if (hasWaitWork(task) && !facts.disposition) {
    due.push(facts.nextPollAt);
    if (task.automationState?.await?.expiresAt !== undefined) due.push(task.automationState.await.expiresAt);
  }
  return due.length ? Math.min(...due) : null;
}

export function assertWaitRecovery(value: unknown): asserts value is GitHubWaitRecoveryFacts {
  const facts = value as Partial<GitHubWaitRecoveryFacts> | null;
  const natural = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  if (!facts || facts.v !== 1 || typeof facts.scope !== 'string' || !facts.scope ||
    !['github-pr-waits', 'github-issue-waits'].includes(facts.index!) || !natural(facts.revision) ||
    !natural(facts.nextPollAt) || !natural(facts.failures) ||
    (facts.retryable !== undefined && typeof facts.retryable !== 'boolean') ||
    (facts.disposition !== undefined && facts.disposition !== 'needs_attention') ||
    !facts.notices || typeof facts.notices !== 'object' || Array.isArray(facts.notices))
    throw new Error('Invalid GitHub wait recovery facts; original record retained');
  for (const [key, notice] of Object.entries(facts.notices)) {
    if (!notice || key !== notice.key || typeof notice.scope !== 'string' || !notice.scope ||
      ![notice.userId, notice.threadId, notice.taskId].every(id => typeof id === 'string' && id.length > 0) ||
      !natural(notice.failures) || !natural(notice.nextAt) ||
      !['pending', 'delivered', 'owner_unavailable', 'needs_attention', 'cancelled'].includes(notice.state))
      throw new Error('Invalid GitHub wait recovery notice; original record retained');
  }
}
