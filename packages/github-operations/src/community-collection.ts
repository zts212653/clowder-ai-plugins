import { storageEntries } from './storage-pages.js';
import type { PluginStorageHost } from '@clowder-ai/plugin-sdk';
import { collectionPrefix as prefix, collectionId as idFor, collectionKey as keyFor, collectionTarget as parse,
  decodeCollection as decode, collectionIndex, collectionIndexOwner } from './community-collection-record.js';
import { advanceRecoveryNotice, type RecoveryNoticeSender } from './recovery-owner-notice.js';
import { SdkCommunityEventLog } from './business/domains/community/CommunityEventLog.js';
import type { TaskItem } from './business/model/index.js';
import type { CommunityTracking } from './business/domains/community/ports/CommunityTracking.js';
import type { JournalSubject } from './business/domains/community/journal-directory.js';
import type { GitHubSnapshot } from './tracking-runtime.js';
import { consecutiveFailures, type RecoveryAttempt } from './recovery-attempt.js';
import type { DiagnosticError } from './tracking-diagnostics.js';

/** Task-shaped compatibility view for the migrated board, NOT a Host Task.
 * This namespace owns only provider collection and never updates the Host Task wait patch.
 * Cancelling retains the row and its cursors (TTL=0); rerouting reactivates it. */
export class SdkCommunityCollectionStore implements CommunityTracking {
  private readonly indexed: ReturnType<typeof collectionIndexOwner>;
  constructor(private readonly storage: PluginStorageHost, private readonly now = Date.now, private readonly intervalMs = 60_000,
    private readonly diagnose?: (error: unknown) => Promise<DiagnosticError>) {
    this.indexed = collectionIndexOwner(storage);
  }
  async initialize(rebuild = false): Promise<void> {
    await new SdkCommunityEventLog(this.storage).initialize();
    await this.indexed.initialize(rebuild);
  }
  async listByKind(kind: TaskItem['kind']): Promise<readonly TaskItem[]> {
    return (await storageEntries(this.storage, prefix)).flatMap(([key, entry]) => {
      try { return [decode(entry.value, key).task]; } catch { return []; }
    }).filter(task => task.kind === kind);
  }
  async recoveryDiagnostics() {
    return (await storageEntries(this.storage, prefix)).map(([sourceKey, entry]) => {
      const row = entry.value as { task?: TaskItem; recovery?: unknown; notice?: { state: string }; disposition?: string; reasonCode?: string } | null;
      return { sourceKey, sourceRevision: entry.revision, taskId: row?.task?.id, subjectKey: row?.task?.subjectKey,
        recovery: row?.recovery ?? { disposition: row?.disposition ?? 'unknown', reasonCode: row?.reasonCode ?? 'recovery_not_prepared' }, noticeState: row?.notice?.state };
    });
  }
  async getBySubject(subject: string): Promise<TaskItem | null> {
    parse(subject); const entry = await this.read(idFor(subject)); return entry?.task.status === 'doing' ? entry.task : null;
  }
  async read(id: string) {
    const entry = await this.storage.get(keyFor(id));
    if (!entry) return null;
    const record = decode(entry.value, keyFor(id));
    if (record.task.id !== id) throw new Error('Collection key mismatch');
    return { revision: entry.revision, ...record };
  }
  async upsertBySubject(input: Parameters<CommunityTracking['upsertBySubject']>[0]): Promise<TaskItem> {
    const subjectKey = input.subjectKey.toLowerCase(), target = parse(subjectKey);
    if (input.kind !== `${target.kind}_tracking` || !input.threadId || !input.ownerCatId || input.automationState?.await || input.automationState?.waitOutcome) throw new TypeError('Collection is not native wait registration');
    const task = await this.reconcileSubject(subjectKey, input);
    if (!task) throw new Error('Collection requires a committed canonical route');
    return task;
  }
  /** Read the journal, never replay ownership supplied by a delayed request.
   * Sequence is the immutable per-subject event position, not a wall clock. */
  private async reconcileSubject(subject: string, seed?: Parameters<CommunityTracking['upsertBySubject']>[0], assertCurrent: () => void = () => {}): Promise<TaskItem | null> {
    const journal = new SdkCommunityEventLog(this.storage), id = idFor(subject), target = parse(subject);
    for (let attempt = 0; attempt < 64; attempt++) {
      assertCurrent();
      const before = await this.read(id);
      const routing = await journal.routing(subject);
      if (!routing) return before?.task ?? null;
      const { event, sequence, terminal } = routing, p = event.payload;
      if (typeof p.ownerThreadId !== 'string' || !p.ownerThreadId || typeof p.catId !== 'string' || !p.catId) throw new Error('Invalid committed collection route');
      if (before?.route && before.route.sequence >= sequence) {
        if (before.route.sequence === sequence && before.route.sourceEventId !== event.sourceEventId) throw new Error('Collection route sequence mismatch');
        if (terminal && before.task.status !== 'done') {
          assertCurrent();
          if (!(await this.indexed.publish(keyFor(id), before.revision, { schemaVersion: 1, route: before.route, recovery: before.recovery, notice: before.notice, task: { ...before.task, status: 'done', updatedAt: this.now() } })).applied) continue;
          return { ...before.task, status: 'done' };
        }
        return before.task; // Includes cancellation: same generation never revives.
      }
      const now = this.now();
      const task: TaskItem = { id, kind: `${target.kind}_tracking`, subjectKey: subject, threadId: p.ownerThreadId, ownerCatId: p.catId,
        title: `${target.kind === 'pr' ? 'PR' : 'Issue'} tracking: ${subject.replace(/^(pr|issue):/, '')}`,
        why: `Canonical route ${event.sourceEventId}`, createdBy: 'system', createdAt: before?.task.createdAt ?? now, updatedAt: now,
        status: terminal || (before && !before.route && before.task.status === 'done') ? 'done' : 'doing',
        ...(typeof p.userId === 'string' ? { userId: p.userId } : {}),
        automationState: before?.task.automationState ?? (seed?.routeSourceEventId === event.sourceEventId ? seed.automationState : undefined) ?? {} };
      assertCurrent();
      if ((await this.indexed.publish(keyFor(id), before?.revision ?? null, { schemaVersion: 1, task, recovery: before?.recovery, notice: before?.notice, route: { sequence, sourceEventId: event.sourceEventId } })).applied) return task;
    }
    throw new Error('Collection reconciliation changed concurrently');
  }
  async reconcileRoutes(kind: 'pr' | 'issue', assertCurrent: () => void = () => {}, notify?: RecoveryNoticeSender): Promise<void> {
    const journal = new SdkCommunityEventLog(this.storage);
    await this.initialize();
    let failure: unknown;
    for (const selected of await journal.pendingRoutes(kind, this.now())) {
      try {
        await journal.deliverRouteNotice(selected.entry, notify, this.now());
        const selectedFacts = (selected.entry.value as JournalSubject).recovery;
        if (!selectedFacts.pending || selectedFacts.disposition || selectedFacts.nextAt > this.now()) continue;
        await this.reconcileSubject(selected.subject, undefined, assertCurrent);
        assertCurrent(); await journal.finishRoute(selected.entry, false, this.now());
      } catch (error) {
        assertCurrent(); await journal.finishRoute(selected.entry, true, this.now(), await this.diagnose?.(error)); failure ??= error;
      }
    }
    if (failure) throw failure;
  }
  async delete(id: string): Promise<boolean> {
    for (let attempt = 0; attempt < 64; attempt++) {
      const before = await this.read(id); if (!before || before.task.status === 'done') return false;
      if ((await this.indexed.publish(keyFor(id), before.revision, { schemaVersion: 1, recovery: before.recovery, notice: before.notice, ...(before.route ? { route: before.route } : {}), task: { ...before.task, status: 'done', updatedAt: this.now() } })).applied) return true;
    }
    throw new Error('Collection cancellation changed concurrently');
  }
  async checkpoint(before: NonNullable<Awaited<ReturnType<SdkCommunityCollectionStore['read']>>>, snapshot: GitHubSnapshot): Promise<void> {
    const task = before.task;
    const max = (kind: 'inline' | 'conversation', previous = 0) => Math.max(previous, ...snapshot.comments.filter(c => c.commentType === kind).map(c => c.id));
    const automationState = task.kind === 'issue_tracking'
      ? { issue: { ...task.automationState?.issue, lastCommentCursor: max('conversation', task.automationState?.issue?.lastCommentCursor), issueState: snapshot.state === 'open' ? 'open' : 'closed' } }
      : { ci: { ...task.automationState?.ci, headSha: snapshot.headSha, ...(snapshot.state === 'open' ? {} : { prState: snapshot.state }) },
        review: { ...task.automationState?.review, lastInlineCommentCursor: max('inline', task.automationState?.review?.lastInlineCommentCursor), lastConversationCommentCursor: max('conversation', task.automationState?.review?.lastConversationCommentCursor) } };
    await this.indexed.publish(keyFor(task.id), before.revision, { schemaVersion: 1, recovery: before.recovery, notice: before.notice, ...(before.route ? { route: before.route } : {}), task: { ...task, automationState,
      status: snapshot.state === 'open' ? 'doing' : 'done', updatedAt: this.now() } });
  }
  async due(kind: 'pr' | 'issue') {
    await this.initialize();
    return Object.entries(await this.indexed.due(collectionIndex(kind), this.now()))
      .map(([sourceKey, entry]) => ({ revision: entry.revision, ...decode(entry.value, sourceKey) }));
  }
  async deliverNotice(selected: NonNullable<Awaited<ReturnType<SdkCommunityCollectionStore['read']>>>, send?: RecoveryNoticeSender) {
    if (!selected.notice) return;
    const notice = await advanceRecoveryNotice(this.storage, selected.notice, send, this.now());
    const current = await this.read(selected.task.id);
    if (!current || JSON.stringify(current.notice) !== JSON.stringify(selected.notice)) return;
    const { revision, ...row } = current;
    await this.indexed.publish(keyFor(current.task.id), revision, { ...row, notice, recovery: { ...current.recovery!,
      ...(!notice && current.recovery?.scope === selected.notice.scope ? { lastNoticeKey: selected.notice.key } : {}) } });
  }
  async finish(selected: NonNullable<Awaited<ReturnType<SdkCommunityCollectionStore['read']>>>, outcome: RecoveryAttempt, notBefore = 0, error?: DiagnosticError) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const current = await this.read(selected.task.id); if (!current) return;
      if (!current.recovery || current.recovery.scope !== selected.recovery?.scope || current.recovery.revision !== selected.recovery.revision) return;
      const failures = consecutiveFailures(current.recovery.failures, outcome);
      const { revision, ...row } = current;
      if ((await this.indexed.publish(keyFor(current.task.id), revision, { ...row, recovery: { ...current.recovery,
        revision: current.recovery.revision + 1, failures, nextAt: Math.max(notBefore, this.now() + this.intervalMs),
        ...(error ? { lastError: error, lastFailureAt: this.now() } : {}),
        ...(failures >= 5 ? { disposition: 'needs_attention', reasonCode: 'collection_observation_failed' } : {}) } })).applied) return;
    }
    throw new Error('Collection recovery accounting changed concurrently');
  }
}
export { CommunityCollectionRuntime } from './community-collection-runtime.js';
