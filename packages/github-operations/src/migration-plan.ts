import type { FeatureContext, PluginTaskReadItem } from '@clowder-ai/plugin-sdk';
import type { TaskItem } from './business/model/index.js';
import { GitHubWaitStorage } from './typed-wait-storage.js';
import { copyLegacyRepositoryProgress, legacyRepositorySnapshotBytes, restoreLegacyRepositoryProgress } from './legacy-repository-progress.js';
import { migrationKey, canonicalBytes, sourceDigest, sourceFamilies, assertSourceEnvelope, type MigrationSource } from './migration-source.js';
import { PlanningStorage } from './migration-storage.js';
export type MigrationTask = { task: TaskItem; mode: 'typed' | 'legacy-issue' | 'history' };
export interface MigrationPlan {
  readonly sourceDigest: string;
  readonly tasks: readonly MigrationTask[];
  readonly records: Readonly<Record<string, unknown>>;
  readonly digest: string;
}
export const legacyIssueKey = (id: string) => `github.migrated-issue.v1.${migrationKey(id)}`;
export const historyKey = (id: string) => `github.migration.history.${migrationKey(id)}`;

export function taskBinding(task: TaskItem | PluginTaskReadItem) {
  return Object.fromEntries(['id','kind','subjectKey','threadId','ownerCatId','userId','status','updatedAt']
    .map(key => [key, task[key as keyof typeof task]]));
}
export function isExpired(task: TaskItem, now: number) {
  const expires = task.automationState?.await?.expiresAt;
  return expires !== undefined && expires <= now;
}
export async function assertBinding(context: FeatureContext, task: TaskItem, userId: string, expectedVersion = task.updatedAt, expectedStatus = task.status) {
  const host = await context.tasks.get({ id: task.id });
  if (!host || host.entrustedWork || host.userId !== userId || host.kind !== task.kind || host.subjectKey !== task.subjectKey
    || host.threadId !== task.threadId || host.ownerCatId !== task.ownerCatId || host.status !== expectedStatus
    || host.updatedAt !== expectedVersion) throw new Error('Source task binding/version changed');
  return host;
}
async function destination(context: FeatureContext, threadId: string, catId: string) {
  if (!await context.threads.get(threadId)) throw new Error('Destination thread is unavailable');
  const cats = await context.threads.getCats(threadId);
  if (![...cats.routableNow, ...cats.routableNotJoined].some(cat => cat.catId === catId)) throw new Error('Current destination is not routable');
}
function reconcileReceipt(task: TaskItem, source: MigrationSource): TaskItem {
  const state = structuredClone(task.automationState ?? {});
  const pending = state.waitOutcome?.delivery === 'pending' ? state.waitOutcome : state.issue?.pendingWake;
  if (!pending) return task;
  const receipts = source.receipts.filter(r => r.taskId === task.id);
  if (receipts.length !== 1) throw new Error('Pending delivery requires one authoritative receipt');
  const r = receipts[0]!;
  if (!r.sourceRef || r.disposition === 'ambiguous') throw new Error('Ambiguous old receipt must remain at source');
  if (state.waitOutcome?.delivery === 'pending') {
    if (r.outcomeId !== state.waitOutcome.outcomeId) throw new Error('Outcome receipt mismatch');
    if (r.disposition === 'delivered' && r.messageAppended && r.wakeAccepted)
      return { ...task, automationState: { ...state, waitOutcome: { ...state.waitOutcome, delivery: 'delivered' } } };
    if (r.disposition === 'not-delivered' && !r.messageAppended && !r.wakeAccepted) return task;
  } else if (state.issue?.pendingWake && r.disposition === 'delivered' && r.messageAppended && r.wakeAccepted) {
    const issue = state.issue, wake = state.issue.pendingWake;
    if (r.messageId !== wake.messageId || wake.threadId !== task.threadId || wake.catId !== task.ownerCatId)
      throw new Error('Pending wake message receipt mismatch');
    if (wake.closeTaskAfterWake) throw new Error('Settle the old terminal obligation at source before importing');
    if (wake.deliveredCursor > (issue.lastCommentCursor ?? 0)) throw new Error('Receipt cursor exceeds collected frontier');
    return { ...task, automationState: { ...state, issue: { ...issue, lastDeliveredCursor: wake.deliveredCursor, pendingWake: null } } };
  }
  throw new Error('Old append/wake namespace is unresolved; do not resend');
}
function validateWait(task: TaskItem) {
  const wait = task.automationState?.await;
  const outcome = task.automationState?.waitOutcome;
  if (outcome && (outcome.v !== 1 || outcome.subjectRef !== task.subjectKey || !Number.isSafeInteger(outcome.generation) || outcome.generation < 1
    || outcome.ownerFence?.kind !== 'containing_task' || outcome.ownerFence.generation !== outcome.generation)) throw new Error('Invalid original outcome fence');
  if (!wait && outcome?.delivery === 'pending') return;
  if (!wait || wait.v !== 1 || wait.subjectRef !== task.subjectKey || !Number.isSafeInteger(wait.generation) || wait.generation < 1
    || wait.ownerFence?.kind !== 'containing_task' || wait.ownerFence.generation !== wait.generation
    || !wait.baseline || !Number.isFinite(wait.baseline.capturedAt) || !wait.continuation?.when?.length
    || typeof wait.continuation.then !== 'string') throw new Error('Original complete fenced wait is required');
}

export async function planMigration(value: unknown, expectedDigest: string, context: FeatureContext, userId: string, now: number): Promise<MigrationPlan> {
  if (!value || typeof value !== 'object' || Buffer.byteLength(canonicalBytes(value)) > 2 * 1024 * 1024
    || sourceDigest(value) !== expectedDigest) throw new Error('Source digest/size mismatch');
  const s = value as MigrationSource;
  assertSourceEnvelope(s);
  if (s.v !== 1 || s.userId !== userId || !s.id || !s.sourceRef || !Number.isFinite(s.capturedAt) || s.oldWriter !== 'absent'
    || !s.coverage || sourceFamilies.some(f => s.coverage[f] !== 'complete') || !Array.isArray(s.tasks) || s.tasks.length > 1000
    || !Array.isArray(s.repositories) || s.repositories.length > 50 || !Array.isArray(s.receipts)
    || !s.retainedAuthorityRefs?.length || s.unresolvedRepositoryDeliveries !== 0) throw new Error('Incomplete or unauthorized frozen source');
  const storage = new PlanningStorage(), waits = new GitHubWaitStorage(storage), rows: MigrationTask[] = [];
  const subjects = new Set<string>(), ids = new Set<string>();
  for (const raw of s.tasks) {
    if (raw.userId !== undefined && raw.userId !== userId || raw.subjectKey?.startsWith(raw.kind === 'pr_tracking' ? 'pr:' : 'issue:') !== true
      || ids.has(raw.id)) throw new Error('Duplicate or invalid tracking identity');
    ids.add(raw.id);
    const state = raw.automationState ?? {};
    if (Object.keys(state).some(key => !['ci','conflict','review','issue','closedAt','await','waitOutcome'].includes(key))) throw new Error('Unsupported Host obligation');
    const pending = state.waitOutcome?.delivery === 'pending' || !!state.issue?.pendingWake;
    const task = pending ? reconcileReceipt(raw, s) : structuredClone(raw);
    const remainsPending = task.automationState?.waitOutcome?.delivery === 'pending' || !!task.automationState?.issue?.pendingWake;
    if (isExpired(task, now) && remainsPending) throw new Error('Expired source has an unresolved receipt; settle at the original namespace');
    const history = !remainsPending && (task.status === 'done' || state.closedAt !== undefined || isExpired(task, now) || (!state.await && !!state.waitOutcome));
    if (history) {
      // An owner-readable legacy Task may honestly have no persisted userId.
      // Preserve it inertly; it never grants Task writes, routing or a new wait.
      const host = await context.tasks.get({ id: raw.id });
      if (!host || host.entrustedWork || host.userId !== null && host.userId !== userId
        || host.threadId !== raw.threadId || host.ownerCatId !== raw.ownerCatId || host.subjectKey !== raw.subjectKey
        || host.kind !== raw.kind || host.updatedAt !== raw.updatedAt) throw new Error('Historical source binding changed');
    } else {
      if (raw.userId !== userId) throw new Error('Active source requires a verified persisted user binding');
      await assertBinding(context, raw, userId);
      if (subjects.has(raw.subjectKey!)) throw new Error('Duplicate live tracking subject');
      subjects.add(raw.subjectKey!);
    }
    const mode = history ? 'history' : task.automationState?.await || task.automationState?.waitOutcome ? 'typed' : 'legacy-issue';
    if (mode !== 'history') {
      await destination(context, task.threadId, task.ownerCatId!);
      if (mode === 'typed') validateWait(task);
      else {
        const issue = task.automationState?.issue;
        if (task.kind !== 'issue_tracking' || !issue || issue.issueState === 'closed' || issue.pendingWake
          || !Number.isSafeInteger(issue.lastCommentCursor) || issue.lastCommentCursor! < 0
          || !Number.isSafeInteger(issue.lastDeliveredCursor ?? issue.lastCommentCursor)
          || (issue.lastDeliveredCursor ?? issue.lastCommentCursor!) !== issue.lastCommentCursor)
          throw new Error('Legacy issue frontier/receipt must be reconciled without a new baseline');
      }
    }
    rows.push({ task, mode });
    if (mode === 'typed') await waits.create(task);
    else await storage.set(mode === 'history' ? historyKey(task.id) : legacyIssueKey(task.id), { schemaVersion: 1, task, sourceUpdatedAt: task.updatedAt });
  }
  const repos: Record<string, Record<string, string>> = Object.create(null);
  for (const { config, progress, notificationRoute } of s.repositories) {
    if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(config.repo) || repos[config.repo]
      || !config.guardThreadId || !config.guardCatId) throw new Error('Invalid repository destination');
    await destination(context, config.guardThreadId, config.guardCatId); repos[config.repo] = progress;
    if (notificationRoute) await destination(context, notificationRoute.threadId, config.guardCatId);
  }
  await copyLegacyRepositoryProgress({ protocolVersion: 1, sourceDigest: migrationKey(legacyRepositorySnapshotBytes(repos)), snapshot: { repositories: repos } }, storage, new AbortController().signal);
  for (const { config, commentOverlapEventIds, notificationRoute } of s.repositories) {
    if (!Array.isArray(commentOverlapEventIds) || commentOverlapEventIds.length > 1000) throw new Error('Exact cursor-overlap dedup evidence required');
    for (const id of commentOverlapEventIds) {
      if (typeof id !== 'string' || !/^comment:[a-z0-9_.-]+\/[a-z0-9_.-]+#[1-9]\d*:[1-9]\d*$/.test(id)
        || !id.startsWith(`comment:${config.repo}#`)) throw new Error('Unrelated imported event fence');
      await storage.set(`community.imported-comment.${migrationKey(id)}`, { sourceEventId: id, sourceRef: s.sourceRef });
    }
    await restoreLegacyRepositoryProgress(config.repo, storage, new AbortController().signal);
    await storage.set(`community.repo.${migrationKey(config.repo)}`, {
      ...config, ...(notificationRoute ? { notificationThreadId: notificationRoute.threadId } : {}),
    });
  }
  const records = Object.fromEntries(Object.entries(await storage.list()).filter(([k]) => !k.startsWith('community.legacy-repo.')).map(([k,v]) => [k,v.value]));
  return { sourceDigest: expectedDigest, tasks: rows, records, digest: sourceDigest({ sourceDigest: expectedDigest, records, tasks: rows }) };
}
