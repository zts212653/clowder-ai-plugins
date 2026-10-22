import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { FeatureContext, PluginActionContext, PluginStorageHost } from '@clowder-ai/plugin-sdk';
import type { TaskItem } from './business/model/index.js';
import { GitHubWaitLifecycleService } from './business/domains/github-signals/GitHubWaitLifecycleService.js';
import { GitHubWaitStorage } from './typed-wait-storage.js';
import { preparePrWait, prepareIssueWait, installPreparedWait, registerPrWait, registerIssueWait,
  TrackingRegistrationError } from './typed-wait-registration.js';
import { registerPrTrackingInputSchema, registerIssueTrackingInputSchema, unregisterTrackingInputSchema } from './tracking-mcp-schemas.js';
import { issueBaseline, prBaseline, waitObservation, waitTarget, waitEventSnapshot } from './typed-wait-provider.js';
import type { GitHubSnapshot, GitHubTarget, GitHubTrackingProvider } from './tracking-runtime.js';
import { copyLegacyIssueProgress } from './legacy-issue-progress.js';
import { legacyIssueOperationInput } from './legacy-issue-observations.js';
import { readRegistrationDiagnostics, writeRegistrationDiagnostic, registrationFailureCode, diagnosticError, type DiagnosticError, type RegistrationDiagnostic } from './tracking-diagnostics.js';
import { readNotificationFilter } from './notification-filter.js';
import { assertMigratedWaitCurrent, projectMigratedWait } from './migration-host-wait.js';
import { gitHubAdmissionCanContinue, gitHubObjectAdmission, gitHubObjectSignal, gitHubPollBudget } from './business/infrastructure/github/admission-budget.js';
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
    return new GitHubWaitStorage({
      get: key => storage.get(key), list: () => storage.list(),
      compareAndSet: async (...args) => { await check(); return storage.compareAndSet(...args); },
      set: async (...args) => { await check(); return storage.set(...args); },
      delete: async (...args) => { await check(); return storage.delete(...args); },
    } satisfies PluginStorageHost, this.now);
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
    const tasks = [...await this.store.listByKind('pr_tracking'), ...await this.store.listByKind('issue_tracking')];
    for (const task of tasks) {
      if (!task.automationState?.waitOutcome) continue;
      await this.run(task.subjectKey!, async signal => {
        const check = async () => { this.assertRunning(); signal.throwIfAborted(); };
        await this.lifecycle(task, check).recoverOutcome(task.id);
        await this.projectImportedWait(task.id, check);
      }).catch(() => this.options.context.log('warn', 'GitHub pending outcome retained for recovery'));
    }
  }

  /** Historical copy stays inert: fresh typed registrations always freeze a live baseline. */
  importLegacyIssueProgress(value: unknown) {
    return this.run('legacy-issue-progress-import', signal =>
      copyLegacyIssueProgress(legacyIssueOperationInput(value), this.options.context.storage, signal));
  }

  poll(kind: 'pr' | 'issue'): Promise<void> {
    const running = this.polling.get(kind); if (running) return running;
    const operation = this.run(`poll:${kind}`, async signal => {
      // Return before the next minute tick; leave time for canonical gh child
      // cleanup and Host RPC settlement inside the 90-second carrier deadline.
      const budget = gitHubPollBudget(signal, { now: this.now,
        pollBudgetMs: this.options.pollBudgetMs ?? 50_000,
        objectTimeoutMs: this.options.objectTimeoutMs ?? 40_000 });
      const tasks = (await this.store.listByKind(kind === 'pr' ? 'pr_tracking' : 'issue_tracking'))
        .filter(task => task.automationState?.await || task.automationState?.waitOutcome?.delivery === 'pending');
      if (!tasks.length) return;
      const storage = this.options.context.storage, progressKey = `github.typed-wait.poll-cursor.${kind}`;
      const progress = (await storage.get(progressKey))?.value;
      if (progress !== undefined && typeof progress !== 'string') throw new Error('Invalid typed poll progress');
      const resume = typeof progress === 'string' ? tasks.findIndex(task => task.id === progress) : -1;
      const start = (resume + 1) % tasks.length;
      // Freeze only currently authorized, active wait targets for this tick.
      // This is a fact read, not native completion authority. Recheck below before
      // using it: a concurrent registration must not inherit an older snapshot.
      const selected = Array.from({ length: Math.min(tasks.length, 20) }, (_, i) => tasks[(start + i) % tasks.length]!);
      const batchGenerations = new Map<string, number>();
      let provider = this.options.provider;
      let batchError: unknown;
      if (kind === 'pr' && provider.forCiBatch) {
        const targets: GitHubTarget[] = [];
        for (const task of selected) {
          if (!gitHubAdmissionCanContinue(budget)) break;
          const wait = task.automationState?.await;
          if (!wait || (wait.expiresAt !== undefined && wait.expiresAt <= this.now())) continue;
          if (task.status === 'done') continue;
          try { await this.currentSubscription(task); }
          catch { this.options.context.log('warn', 'GitHub imported binding is unavailable; observation remains paused'); continue; }
          targets.push(waitTarget(task)); batchGenerations.set(task.id, wait.generation);
        }
        if (targets.length) {
          try { provider = await provider.forCiBatch(targets,
            gitHubObjectSignal(budget)!); }
          catch (error) { batchError = error; }
        }
        signal.throwIfAborted();
      }
      for (let i = 0; i < selected.length && !signal.aborted && gitHubAdmissionCanContinue(budget); i++) {
        const task = selected[i]!;
        const admission = gitHubObjectAdmission(budget), objectSignal = admission.signal!;
        let deferred = false;
        await this.run(task.subjectKey!, async taskSignal => {
          const check = async () => { this.assertRunning(); signal.throwIfAborted(); taskSignal.throwIfAborted(); objectSignal.throwIfAborted(); };
          const current = await this.store.get(task.id); if (!current) return;
          await this.currentSubscription(current);
          const lifecycle = this.lifecycle(current, check);
          await lifecycle.recoverOutcome(task.id); await check();
          if (current.automationState?.waitOutcome || !current.automationState?.await) await this.projectImportedWait(task.id, check);
          if (!current.automationState?.await) return;
          if (current.automationState.await.expiresAt !== undefined && current.automationState.await.expiresAt <= this.now()) {
            await lifecycle.observe({ taskId: task.id, at: this.now(), facts: {} });
            await this.projectImportedWait(task.id, check);
            return;
          }
          if (batchError) throw batchError; // Recover durable outboxes even when new facts are unavailable.
          const target = waitTarget(current);
          if (kind === 'pr' && this.options.provider.forCiBatch &&
              batchGenerations.get(task.id) !== current.automationState.await.generation) return;
          const snapshot = await provider.read(target, AbortSignal.any([signal, taskSignal, objectSignal]));
          await check();
          const configured = await this.options.context.config.get('cloudReviewerLogins');
          if (configured !== undefined && typeof configured !== 'string') throw new TypeError('cloudReviewerLogins must be a string');
          const observed = waitObservation(current, snapshot, this.now(),
            configured === undefined ? ['chatgpt-codex-connector[bot]'] : configured.split(/[\s,]+/).filter(Boolean));
          await this.options.observe?.(target, observed.snapshot); await check();
          await this.options.collect?.(target, waitEventSnapshot(current, observed.snapshot)); await check();
          await this.currentSubscription(current); await check();
          const notificationFilter = await readNotificationFilter(this.options.context, snapshot, observed.observation.facts.review?.reviewer);
          await lifecycle.observe({ ...observed.observation, notificationFilter });
          await this.projectImportedWait(task.id, check);
        }, this.options.objectTimeoutMs ?? 40_000).catch(error => {
          // A clipped timer can fire before Date.now reaches its deadline.
          // Preserve the admitted window's cause rather than inferring it later.
          deferred = objectSignal.aborted ? admission.limitedByPoll : !gitHubAdmissionCanContinue(budget);
          this.options.context.log(deferred ? 'info' : 'warn', deferred
            ? 'GitHub poll budget used; resume this subscription next tick'
            : 'GitHub observation failed; wait and pending delivery remain recoverable',
            { taskId: task.id, kind, errorName: error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name) ? error.name : 'Error' });
        });
        if (signal.aborted || deferred) break;
        // Failed observations advance admission fairness, never provider facts.
        // Preserve this position across module upgrades and process restarts.
        const cursor = await storage.get(progressKey);
        if (!(await storage.compareAndSet(progressKey, cursor?.revision ?? null, task.id)).applied) {
          this.options.context.log('warn', 'Typed poll progress could not be saved; retain subscriptions for retry');
          break;
        }
      }
    }, 55_000);
    this.polling.set(kind, operation);
    void operation.finally(() => this.polling.delete(kind)).catch(() => undefined);
    return operation;
  }

  async stop(): Promise<void> {
    this.stopController.abort(); await Promise.allSettled([...this.work]);
  }
}
