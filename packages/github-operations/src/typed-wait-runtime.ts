import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { FeatureContext, PluginActionContext, PluginStorageHost } from '@clowder-ai/plugin-sdk';
import type { TaskItem } from './business/model/index.js';
import { GitHubWaitLifecycleService } from './business/domains/github-signals/GitHubWaitLifecycleService.js';
import { GitHubWaitStorage } from './typed-wait-storage.js';
import { preparePrWait, prepareIssueWait, installPreparedWait, registerPrWait, registerIssueWait,
  TrackingRegistrationError } from './typed-wait-registration.js';
import { registerPrTrackingInputSchema, registerIssueTrackingInputSchema, unregisterTrackingInputSchema } from './tracking-mcp-schemas.js';
import { issueBaseline, prBaseline } from './typed-wait-provider.js';
import type { GitHubSnapshot, GitHubTarget, GitHubTrackingProvider } from './tracking-runtime.js';
import { copyLegacyIssueProgress } from './legacy-issue-progress.js';
import { legacyIssueOperationInput } from './legacy-issue-observations.js';
import { readRegistrationDiagnostics, writeRegistrationDiagnostic, registrationFailureCode, diagnosticError, type DiagnosticError, type RegistrationDiagnostic } from './tracking-diagnostics.js';
import { assertMigratedWaitCurrent, projectMigratedWait } from './migration-host-wait.js';
import { assertWaitStorage } from './typed-wait-record.js';
import { pollGitHubDueWaits } from './typed-wait-poller.js';
import type { GitHubWaitRecoveryCandidate } from './typed-wait-recovery-storage.js';
import { withInteractiveGitHubRequests } from './business/infrastructure/github/request-budget.js';

export interface TypedWaitRuntimeOptions {
  readonly context: FeatureContext;
  readonly provider: GitHubTrackingProvider;
  readonly coverage: (repo: string, number: number, commentId: number) => Promise<{ covered: boolean; reason?: string }>;
  readonly collect?: (target: GitHubTarget, snapshot: GitHubSnapshot) => Promise<void>;
  readonly observe?: (target: GitHubTarget, snapshot: GitHubSnapshot) => Promise<void>;
  readonly now?: () => number;
  /** Bound each PR independently inside the bounded poll; tests may shorten it. */
  readonly objectTimeoutMs?: number;
  readonly pollBudgetMs?: number;
  readonly pollIntervalMs?: number;
}

/** Package-private subscriptions, predicates, receipts and durable notification outboxes.
 * Host supplies authenticated identity, ordinary thread access, schedules and messaging. */
export class TypedWaitRuntime {
  readonly store: GitHubWaitStorage;
  private readonly stopController = new AbortController();
  private readonly lanes = new Map<string, Promise<unknown>>();
  private readonly work = new Set<Promise<unknown>>();
  private readonly polling = new Map<string, Promise<void>>();
  private readonly now: () => number;
  constructor(private readonly options: TypedWaitRuntimeOptions) {
    this.now = options.now ?? Date.now;
    this.store = this.guardedStore(async () => this.assertRunning());
  }

  private assertRunning() { if (this.stopController.signal.aborted) throw new Error('GitHub tracking stopped'); }
  private guardedStore(check: () => Promise<void>) {
    const storage = this.options.context.storage;
    const scan = storage.scan?.bind(storage);
    const indexed = storage.compareAndSetIndexed?.bind(storage), readDue = storage.readDue?.bind(storage), rebuild = storage.rebuildIndex?.bind(storage);
    return new GitHubWaitStorage({
      ...(indexed ? { compareAndSetIndexed: async (...args: Parameters<typeof indexed>) => { await check(); return storage.compareAndSetIndexed!(...args); } } : {}),
      ...(readDue ? { readDue: async (input: Parameters<typeof readDue>[0]) => { await check(); const result = await readDue(input); await check(); return result; } } : {}),
      ...(rebuild ? { rebuildIndex: async (index: string) => { await check(); const result = await rebuild(index); await check(); return result; } } : {}),
      get: key => storage.get(key), list: () => storage.list(),
      ...(scan ? { scan: async (input: Parameters<typeof scan>[0]) => {
        await check(); const page = await scan(input); await check(); return page;
      } } : {}),
      compareAndSet: async (...args) => { await check(); return storage.compareAndSet(...args); },
      set: async (...args) => { await check(); return storage.set(...args); },
      delete: async (...args) => { await check(); return storage.delete(...args); },
    } satisfies PluginStorageHost, this.now, this.options.pollIntervalMs ?? 60_000);
  }

  private run<T>(subject: string, action: (signal: AbortSignal) => Promise<T>, timeoutMs = 30_000): Promise<T> {
    const previous = this.lanes.get(subject) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(() => {
      this.assertRunning();
      return action(AbortSignal.any([this.stopController.signal, AbortSignal.timeout(timeoutMs)]));
    });
    this.lanes.set(subject, operation); this.work.add(operation);
    void operation.finally(() => {
      this.work.delete(operation); if (this.lanes.get(subject) === operation) this.lanes.delete(subject);
    }).catch(() => undefined);
    return operation;
  }

  private assertOwner(task: TaskItem, caller: Pick<PluginActionContext, 'catId' | 'threadId' | 'userId'>) {
    if (task.userId !== caller.userId || task.ownerCatId !== caller.catId || task.threadId !== caller.threadId) {
      throw new TrackingRegistrationError(409, 'Tracking belongs to a different user, owner or thread');
    }
  }

  private async currentSubscription(task: TaskItem): Promise<TaskItem> {
    const current = await this.store.get(task.id);
    if (!current || current.subjectKey !== task.subjectKey || current.kind !== task.kind) {
      throw new Error('Tracking subscription is unavailable');
    }
    this.assertOwner(current, { userId: task.userId!, catId: task.ownerCatId!, threadId: task.threadId });
    await assertMigratedWaitCurrent(this.options.context, current);
    return current;
  }

  private async projectImportedWait(taskId: string, check: () => Promise<void>) {
    const task = await this.store.get(taskId);
    if (!task) throw new Error('Private tracking subscription is unavailable');
    await projectMigratedWait(this.options.context, task, check);
  }

  async registerPr(input: unknown, caller?: PluginActionContext): Promise<TaskItem> {
    return this.register('pr', z.object(registerPrTrackingInputSchema).strict().parse(input), caller);
  }
  async registerIssue(input: unknown, caller?: PluginActionContext): Promise<TaskItem> {
    return this.register('issue', z.object(registerIssueTrackingInputSchema).strict().parse(input), caller);
  }

  private async register(kind: 'pr' | 'issue', input: unknown, caller?: PluginActionContext): Promise<TaskItem> {
    if (!caller) throw new TrackingRegistrationError(503, 'Authenticated MCP invocation required');
    assertWaitStorage(this.options.context.storage);
    const value = input as { repoFullName: string; prNumber?: number; issueNumber?: number;
      when?: { kind: string; reviewThreadIds?: readonly string[] }[] };
    const number = (kind === 'pr' ? value.prNumber : value.issueNumber)!;
    const subject = `${kind}:${value.repoFullName.toLowerCase()}#${number}`;
    const registrationId = (input as { registrationId: string }).registrationId;
    return withInteractiveGitHubRequests(() => this.run(subject, async signal => {
      let phase: RegistrationDiagnostic['phase'] = 'load_subscription';
      const diagnostic = async (status: RegistrationDiagnostic['status'], code: RegistrationDiagnostic['code'], statusCode?: number, error?: DiagnosticError) => {
        try { await writeRegistrationDiagnostic(this.options.context.storage, caller, registrationId, subject,
          { phase, status, code, at: this.now(), ...(statusCode !== undefined ? { statusCode } : {}), ...(error ? { error } : {}) }); }
        catch { this.options.context.log('warn', 'GitHub registration diagnostic could not be persisted'); }
      };
      try {
        const check = async () => {
          try { this.assertRunning(); signal.throwIfAborted(); await caller.assertCurrent(); }
          catch (error) { phase = 'verify_authority'; throw error; }
        };
        await check();
        await diagnostic('started', 'started');
        let task: TaskItem | null = await this.store.getBySubject(subject, caller);
        if (task) this.assertOwner(task, caller);
        await check();
        const target: GitHubTarget = { kind, number, repoFullName: value.repoFullName, threadId: caller.threadId, catId: caller.catId,
          reviewThreadIds: value.when?.flatMap(predicate => predicate.reviewThreadIds ?? []) ?? [] };
        let observation: Promise<GitHubSnapshot> | undefined;
        const read = () => { phase = 'read_github'; return observation ??= this.options.provider.read(target, signal); };
        const deps = {
          identity: async () => (await read()).trackingIdentity ?? {},
          baseline: async (repo: string, number: number, when: Parameters<typeof prBaseline>[3]) =>
            prBaseline(await read(), repo, number, when, this.now),
          coverage: this.options.coverage, now: this.now,
        };
        const issueDeps = { ...deps, baseline: async (repo: string, number: number) => issueBaseline(await read(), repo, number, this.now) };
        const existingTask = task;
        const store = this.guardedStore(async () => { phase = 'save_subscription'; await check(); if (existingTask) await this.currentSubscription(existingTask); });
        let installed: TaskItem;
        if (task) {
          const owned = { ...task, userId: caller.userId };
          installed = kind === 'pr' ? await registerPrWait(store, owned, input, deps) : await registerIssueWait(store, owned, input, issueDeps);
        } else {
          const plan = kind === 'pr' ? await preparePrWait(input, deps) : await prepareIssueWait(input, issueDeps);
          await check();
          // The deterministic private ID serializes competing first registrations with CAS.
          // Existing records retain their IDs; lookup is scoped to authenticated user/cat/thread.
          const at = this.now();
          task = { id: 'github-subscription-' + createHash('sha256').update(JSON.stringify([subject, caller.userId, caller.catId, caller.threadId])).digest('hex'),
            kind: plan.kind, subjectKey: plan.subjectKey, threadId: caller.threadId,
            ownerCatId: caller.catId, userId: caller.userId,
            title: `${kind === 'pr' ? 'PR' : 'Issue'} tracking: ${value.repoFullName}#${number}`,
            why: '', status: 'todo', createdBy: caller.catId, createdAt: at, updatedAt: at };
          installed = await installPreparedWait(store, { ...task, userId: caller.userId }, plan);
        }
        await check();
        await this.projectImportedWait(installed.id, check);
        phase = 'complete'; await diagnostic('registered', 'registered');
        return installed;
      } catch (error) {
        const code = registrationFailureCode(phase, error instanceof TrackingRegistrationError);
        const detail = await diagnosticError(error, this.options.context.secrets);
        await diagnostic('failed', code, error instanceof TrackingRegistrationError ? error.status : undefined, detail);
        this.options.context.log('warn', `GitHub tracking registration failed (${code}, ${phase})`, { error: detail });
        throw error;
      }
    }));
  }

  diagnostics() { return readRegistrationDiagnostics(this.options.context.storage); }

  async retry(input: unknown, caller?: PluginActionContext) {
    const value = z.object({ taskId: z.string().min(1).max(200), expectedScope: z.string().regex(/^[a-f0-9]{64}$/),
      expectedRecoveryRevision: z.number().int().nonnegative() }).strict().parse(input);
    if (!caller?.userId || !caller.catId || !caller.threadId || !caller.invocationId || typeof caller.assertCurrent !== 'function')
      throw new TrackingRegistrationError(503, 'Authenticated invocation required for a recovery retry');
    this.assertRunning(); await caller.assertCurrent();
    const task = await this.store.get(value.taskId);
    if (!task || task.userId !== caller.userId) throw new TrackingRegistrationError(409, 'Tracking is unavailable or belongs to a different user');
    return this.run(task.subjectKey!, async signal => {
      const check = async () => { this.assertRunning(); signal.throwIfAborted(); await caller.assertCurrent(); };
      await check();
      if (!await this.options.context.threads.get(task.threadId)) throw new TrackingRegistrationError(409, 'Original tracking thread is unavailable');
      await this.currentSubscription(task);
      const store = this.guardedStore(async () => { await check(); await this.currentSubscription(task); });
      await store.recovery.retry(task.id, value.expectedScope, value.expectedRecoveryRevision);
      return { data: { retried: true, taskId: task.id, subjectKey: task.subjectKey, pollingState: 'scheduled',
        message: 'Original wait, baseline, owner, notification progress and history retained.' } };
    });
  }

  private lifecycle(task: TaskItem, check: () => Promise<void>) {
    const store = this.guardedStore(async () => { await check(); await this.currentSubscription(task); });
    return new GitHubWaitLifecycleService({ taskStore: store, now: this.now,
      eventLog: { append: event => store.appendLifecycleEvent(task.id, event) },
      log: { info: () => {}, warn: () => this.options.context.log('warn', 'GitHub wait delivery/event will be retried'),
        error: () => this.options.context.log('error', 'GitHub wait lifecycle failed') },
      deliveryDeps: { messaging: { send: async ({ threadId, ...draft }) => {
        await this.projectImportedWait(task.id, check);
        return this.options.context.messaging.send(threadId, draft);
      } } },
    });
  }

  async unregister(input: unknown, caller?: PluginActionContext) {
    const value = z.object(unregisterTrackingInputSchema).strict().parse(input);
    if (!caller) throw new TrackingRegistrationError(503, 'Authenticated MCP invocation required');
    const scope = { scope: 'current_user_cat_thread' as const,
      message: 'Cancellation is limited to the current authenticated user, cat and thread; other subscribers are unchanged.' };
    return this.run(value.subjectKey.toLowerCase(), async signal => {
      const check = async () => { this.assertRunning(); signal.throwIfAborted(); await caller.assertCurrent(); };
      await check();
      const task = await this.store.getBySubject(value.subjectKey.toLowerCase(), caller);
      if (!task) return { unregistered: false, ...scope };
      this.assertOwner(task, caller);
      const result = await this.lifecycle(task, check).cancel(task.id, { kind: 'cat', catId: caller.catId, invocationId: caller.invocationId });
      await this.projectImportedWait(task.id, check);
      return { unregistered: true, result, ...scope };
    });
  }

  async recover(): Promise<void> {
    assertWaitStorage(this.options.context.storage);
    for (const kind of ['pr_tracking', 'issue_tracking'] as const) {
      for (const candidate of await this.store.recovery.listDue(kind, this.now())) {
        const task = candidate.task;
        if (!task.automationState?.waitOutcome || candidate.recovery.disposition) continue;
        let failed = false;
        await this.run(task.subjectKey!, async signal => {
          const check = async () => { this.assertRunning(); signal.throwIfAborted(); };
          await this.currentSubscription(task);
          await this.lifecycle(task, check).recoverOutcome(task.id);
          await this.projectImportedWait(task.id, check);
        }).catch(() => { failed = true; this.options.context.log('warn', 'GitHub pending outcome retained for recovery'); });
        await this.store.recovery.finish(candidate, failed ? 'failed' : 'deferred', this.now() + (this.options.pollIntervalMs ?? 60_000));
      }
    }
  }

  private async recoveryNotices(candidate: GitHubWaitRecoveryCandidate): Promise<void> {
    for (const notice of Object.values(candidate.recovery.notices)) {
      if (notice.state !== 'pending' || notice.nextAt > this.now()) continue;
      const current = (await this.store.recovery.facts(candidate.task.id))?.notices[notice.key];
      if (!current || current.state !== 'pending' || current.failures !== notice.failures) continue;
      try {
        const thread = await this.options.context.threads.get(notice.threadId);
        if (!thread) { await this.store.recovery.finishNotice(candidate.task.id, notice, 'owner_unavailable'); continue; }
        await this.options.context.messaging.send(notice.threadId, { identity: 'github-wait',
          payload: { provenance: { epistemicStatus: 'observation' }, elements: [{ elementId: notice.key, kind: 'text',
            payload: { text: `${candidate.task.subjectKey} 的自动检查已暂停（连续 5 次失败；${candidate.recovery.reasonCode ?? 'unknown'}）。原等待与通知进度仍保留；请查看 github_list_tracking 的恢复诊断后重试。` } }] },
          idempotencyKey: notice.key, meta: { phase: 'status', taskId: notice.taskId } });
        await this.store.recovery.finishNotice(candidate.task.id, notice, 'delivered');
      } catch {
        await this.store.recovery.finishNotice(candidate.task.id, notice, 'pending');
      }
    }
  }

  /** Historical copy stays inert: fresh typed registrations always freeze a live baseline. */
  importLegacyIssueProgress(value: unknown) {
    return this.run('legacy-issue-progress-import', signal =>
      copyLegacyIssueProgress(legacyIssueOperationInput(value), this.options.context.storage, signal));
  }

  poll(kind: 'pr' | 'issue'): Promise<void> {
    assertWaitStorage(this.options.context.storage);
    const running = this.polling.get(kind); if (running) return running;
    const operation = this.run(`poll:${kind}`, async signal => {
      await pollGitHubDueWaits({ options: this.options, store: this.store, now: this.now,
        run: (subject, action, timeoutMs) => this.run(subject, action, timeoutMs),
        assertRunning: () => this.assertRunning(), currentSubscription: task => this.currentSubscription(task),
        lifecycle: (task, check) => this.lifecycle(task, check),
        projectImportedWait: (id, check) => this.projectImportedWait(id, check),
        recoveryNotices: candidate => this.recoveryNotices(candidate),
      }, kind, signal);
    }, 55_000);
    this.polling.set(kind, operation);
    void operation.finally(() => this.polling.delete(kind)).catch(() => undefined);
    return operation;
  }

  async stop(): Promise<void> {
    this.stopController.abort(); await Promise.allSettled([...this.work]);
  }
}
