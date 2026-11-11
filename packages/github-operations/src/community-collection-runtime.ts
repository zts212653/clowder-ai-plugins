import type { SdkCommunityCollectionStore } from './community-collection.js';
import type { TaskItem } from './business/model/index.js';
import type { GitHubSnapshot, GitHubTarget, GitHubTrackingProvider } from './tracking-runtime.js';
import { collectionTarget as parse } from './community-collection-record.js';
import type { RecoveryNoticeSender } from './recovery-owner-notice.js';
import { GitHubRateLimitError, GitHubRequestDeferredError } from './business/infrastructure/github/request-budget.js';
import type { DiagnosticError } from './tracking-diagnostics.js';
import { gitHubPollBudget, gitHubAdmissionCanContinue, gitHubObjectAdmission } from './business/infrastructure/github/admission-budget.js';

interface CollectionOptions {
  readonly notify?: RecoveryNoticeSender;
  readonly now?: () => number;
  readonly store: SdkCommunityCollectionStore;
  readonly provider: Pick<GitHubTrackingProvider, 'read'>;
  readonly allowed: (repo: string) => Promise<boolean>;
  readonly collect: (target: GitHubTarget, snapshot: GitHubSnapshot) => Promise<void>;
  readonly observe: (target: GitHubTarget, snapshot: GitHubSnapshot) => Promise<void>;
  readonly diagnose?: (error: unknown) => Promise<DiagnosticError>;
}
export class CommunityCollectionRuntime {
  private readonly lifetime = new AbortController();
  private readonly running = new Map<string, Promise<void>>();
  constructor(private readonly options: CollectionOptions) {}
  prepare(): Promise<void> { return this.options.store.initialize(); }
  recoveryDiagnostics() { return this.options.store.recoveryDiagnostics(); }
  poll(kind: 'pr' | 'issue'): Promise<void> {
    this.lifetime.signal.throwIfAborted();
    const existing = this.running.get(kind); if (existing) return existing;
    const run = this.collect(kind).finally(() => { this.running.delete(kind); }); this.running.set(kind, run); return run;
  }
  private async collect(kind: 'pr' | 'issue'): Promise<void> {
    const budget = gitHubPollBudget(this.lifetime.signal, { now: this.options.now, pollBudgetMs: 50_000, objectTimeoutMs: 40_000 });
    let failure: unknown;
    try { await this.options.store.reconcileRoutes(kind, () => this.lifetime.signal.throwIfAborted(), this.options.notify); }
    catch (error) { this.lifetime.signal.throwIfAborted(); failure = error; }
    this.lifetime.signal.throwIfAborted();
    for (const selected of await this.options.store.due(kind)) {
      if (!gitHubAdmissionCanContinue(budget)) break;
      const admission = gitHubObjectAdmission(budget), signal = admission.signal!;
      try {
        await this.options.store.deliverNotice(selected, this.options.notify);
        if (selected.recovery?.disposition || selected.task.status !== 'doing' || selected.recovery!.nextAt > (this.options.now ?? Date.now)()) continue;
        const observed = await this.one(selected.task, signal);
        signal.throwIfAborted();
        await this.options.store.finish(selected, observed ? 'succeeded' : 'deferred');
      } catch (error) {
        this.lifetime.signal.throwIfAborted();
        if (signal.aborted && admission.limitedByPoll) break;
        const limited = error instanceof GitHubRateLimitError, deferred = limited || error instanceof GitHubRequestDeferredError;
        await this.options.store.finish(selected, deferred ? 'deferred' : 'failed', limited ? error.retryAt : 0,
          deferred ? undefined : await this.options.diagnose?.(error));
        if (!deferred) failure ??= error;
        if (deferred) break;
      }
    }
    if (failure) throw failure;
  }
  private async one(task: TaskItem, signal: AbortSignal): Promise<boolean> {
      signal.throwIfAborted();
      const before = await this.options.store.read(task.id); if (!before || before.task.status !== 'doing') return false;
      const target = { ...parse(before.task.subjectKey!), threadId: before.task.threadId, catId: before.task.ownerCatId! };
      if (!await this.options.allowed(target.repoFullName)) return false;
      signal.throwIfAborted();
      const state = before.task.automationState;
      const snapshot = await this.options.provider.read(target, signal, { inline: state?.review?.lastInlineCommentCursor ?? 0,
        conversation: target.kind === 'issue' ? state?.issue?.lastCommentCursor ?? 0 : state?.review?.lastConversationCommentCursor ?? 0 });
      signal.throwIfAborted();
      if (!await this.options.allowed(target.repoFullName) || (await this.options.store.read(task.id))?.revision !== before.revision) return false;
      signal.throwIfAborted();
      if (snapshot.commentsComplete !== true) throw new Error('Collection snapshot incomplete');
      await this.options.collect(target, snapshot);
      signal.throwIfAborted();
      await this.options.observe(target, snapshot);
      signal.throwIfAborted();
      await this.options.store.checkpoint(before, snapshot);
      return true;
  }
  async stop(): Promise<void> { this.lifetime.abort(); await Promise.allSettled(this.running.values()); }
}
