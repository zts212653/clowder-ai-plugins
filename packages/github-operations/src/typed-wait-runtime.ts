import { z } from 'zod';
import type { FeatureContext, PluginActionContext, PluginStorageHost, PluginTaskItem, PluginWaitUpdate } from '@clowder-ai/plugin-sdk';
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

export interface TypedWaitRuntimeOptions {
  readonly context: FeatureContext;
  readonly provider: GitHubTrackingProvider;
  readonly coverage: (repo: string, number: number, commentId: number) => Promise<{ covered: boolean; reason?: string }>;
  readonly collect?: (target: GitHubTarget, snapshot: GitHubSnapshot) => Promise<void>;
  readonly observe?: (target: GitHubTarget, snapshot: GitHubSnapshot) => Promise<void>;
  readonly now?: () => number;
  /** Bound each PR independently inside the bounded poll; tests may shorten it. */
  readonly objectTimeoutMs?: number;
}

/** All provider predicates, registration receipts and notification outboxes live here.
 * Host supplies only authenticated action context and existing SDK task/message ports. */
export class TypedWaitRuntime {
  readonly store: GitHubWaitStorage;
  private readonly stopController = new AbortController();
  private readonly lanes = new Map<string, Promise<unknown>>();
  private readonly work = new Set<Promise<unknown>>();
  private readonly polling = new Map<string, Promise<void>>();
  private readonly offsets = new Map<string, number>();
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

  private assertOwner(task: PluginTaskItem, caller: Pick<PluginActionContext, 'catId' | 'threadId'>) {
    if (task.ownerCatId !== caller.catId || task.threadId !== caller.threadId) {
      throw new TrackingRegistrationError(409, 'Tracking belongs to a different owner or thread');
    }
  }
  private async currentTask(task: TaskItem): Promise<PluginTaskItem> {
    const current = await this.options.context.tasks.get({ id: task.id });
    if (!current || current.subjectKey !== task.subjectKey || current.kind !== task.kind) throw new Error('Tracking task is unavailable');
    this.assertOwner(current, { catId: task.ownerCatId!, threadId: task.threadId });
    return current;
  }

  private async projectWait(taskId: string, check: () => Promise<void>): Promise<void> {
    await check();
    // Always project current private state, never an immutable registration receipt.
    const task = await this.store.get(taskId);
    if (!task) throw new Error('Private tracking task is unavailable');
    const active = task.automationState?.await;
    const outcome = task.automationState?.waitOutcome;
    const generation = Math.max(active?.generation ?? 0, outcome?.generation ?? 0);
    if (!generation) return;
    const host = await this.currentTask(task);
    if (outcome && outcome.ownerFence?.kind !== 'containing_task') throw new Error('Unsupported wait owner fence');
    const input: PluginWaitUpdate = {
      expectedGeneration: host.pluginWait?.generation ?? null, generation,
      active: active ? { ...(active.expiresAt === undefined ? {} : { expiresAt: active.expiresAt }) } : null,
      ...(outcome ? { outcome: { outcomeId: outcome.outcomeId, generation: outcome.generation,
        ownerFence: { kind: 'containing_task' as const, generation: outcome.ownerFence!.generation },
        reason: outcome.reason, delivery: outcome.delivery } } : {}),
    };
    await check();
    if (!await this.options.context.tasks.update(task.id, { wait: input }, {expectedThreadId: host.threadId})) throw new Error('Wait projection changed; retry from current state');
    await check();
  }

  private async settleProjection(taskId: string, check: () => Promise<void>) {
    await this.projectWait(taskId, check);
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
    return this.run(subject, async signal => {
      const check = async () => { this.assertRunning(); signal.throwIfAborted(); await caller.assertCurrent(); };
      await check();
      let task: PluginTaskItem | null = await this.options.context.tasks.get({ subjectKey: subject });
      if (task) this.assertOwner(task, caller);
      const target: GitHubTarget = { kind, number, repoFullName: value.repoFullName, threadId: caller.threadId, catId: caller.catId,
        reviewThreadIds: value.when?.flatMap(predicate => predicate.reviewThreadIds ?? []) ?? [] };
      let observation: Promise<GitHubSnapshot> | undefined;
      const read = () => observation ??= this.options.provider.read(target, signal);
      const deps = {
        identity: async () => (await read()).trackingIdentity ?? {},
        baseline: async (repo: string, number: number, when: Parameters<typeof prBaseline>[3]) =>
          prBaseline(await read(), repo, number, when, this.now),
        coverage: this.options.coverage, now: this.now,
      };
      const issueDeps = { ...deps, baseline: async (repo: string, number: number) => issueBaseline(await read(), repo, number, this.now) };
      const store = this.guardedStore(async () => { await check(); if (task) await this.currentTask({ ...task, userId: caller.userId }); });
      let installed: TaskItem;
      if (task) {
        const owned = { ...task, userId: caller.userId };
        installed = kind === 'pr' ? await registerPrWait(store, owned, input, deps) : await registerIssueWait(store, owned, input, issueDeps);
      } else {
        const plan = kind === 'pr' ? await preparePrWait(input, deps) : await prepareIssueWait(input, issueDeps);
        await check();
        // Unique-subject create refuses a competing owner; upsert would overwrite it.
        task = await this.options.context.tasks.create({ threadId: caller.threadId, ownerCatId: caller.catId,
          kind: plan.kind, subjectKey: plan.subjectKey, title: `${kind === 'pr' ? 'PR' : 'Issue'} tracking: ${value.repoFullName}#${number}` });
        this.assertOwner(task, caller);
        installed = await installPreparedWait(store, { ...task, userId: caller.userId }, plan);
      }
      await check();
      // A receipt describes the original response, not the current wait. A delayed
      // replay after cancellation must not resurrect the Host task projection.
      await this.projectWait(installed.id, check);
      return installed;
    });
  }

  private lifecycle(task: TaskItem, check: () => Promise<void>) {
    const store = this.guardedStore(check);
    return new GitHubWaitLifecycleService({ taskStore: store, now: this.now,
      eventLog: { append: event => store.appendLifecycleEvent(task.id, event) },
      log: { info: () => {}, warn: () => this.options.context.log('warn', 'GitHub wait delivery/event will be retried'),
        error: () => this.options.context.log('error', 'GitHub wait lifecycle failed') },
      deliveryDeps: { messaging: { send: async ({ threadId, ...draft }) => {
        await this.projectWait(task.id, check);
        return this.options.context.messaging.send(threadId, draft);
      } } },
    });
  }

  async unregister(input: unknown, caller?: PluginActionContext) {
    const value = z.object(unregisterTrackingInputSchema).strict().parse(input);
    if (!caller) throw new TrackingRegistrationError(503, 'Authenticated MCP invocation required');
    return this.run(value.subjectKey.toLowerCase(), async signal => {
      const check = async () => { this.assertRunning(); signal.throwIfAborted(); await caller.assertCurrent(); };
      await check(); const hostTask = await this.options.context.tasks.get({ subjectKey: value.subjectKey.toLowerCase() });
      if (!hostTask) return { unregistered: false };
      this.assertOwner(hostTask, caller);
      const task = await this.store.get(hostTask.id);
      if (!task) return { unregistered: false };
      if (task.userId !== caller.userId) throw new TrackingRegistrationError(409, 'Tracking belongs to a different user');
      const result = await this.lifecycle(task, check).cancel(task.id, { kind: 'cat', catId: caller.catId, invocationId: caller.invocationId });
      await this.settleProjection(task.id, check);
      return { unregistered: true, result };
    });
  }

  async recover(): Promise<void> {
    const tasks = [...await this.store.listByKind('pr_tracking'), ...await this.store.listByKind('issue_tracking')];
    for (const task of tasks) {
      if (!task.automationState?.waitOutcome) continue;
      await this.run(task.subjectKey!, async signal => {
        const check = async () => { this.assertRunning(); signal.throwIfAborted(); };
        await this.lifecycle(task, check).recoverOutcome(task.id);
        await this.settleProjection(task.id, check);
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
      const tasks = await this.store.listByKind(kind === 'pr' ? 'pr_tracking' : 'issue_tracking');
      const start = (this.offsets.get(kind) ?? 0) % Math.max(tasks.length, 1);
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
          const wait = task.automationState?.await;
          if (!wait || (wait.expiresAt !== undefined && wait.expiresAt <= this.now())) continue;
          const host = await this.options.context.tasks.get({ id: task.id });
          if (!host?.pluginWait || host.status === 'done' || host.threadId !== task.threadId || host.ownerCatId !== task.ownerCatId) continue;
          targets.push(waitTarget(task)); batchGenerations.set(task.id, wait.generation);
        }
        if (targets.length) {
          try { provider = await provider.forCiBatch(targets,
            AbortSignal.any([signal, AbortSignal.timeout(this.options.objectTimeoutMs ?? 10_000)])); }
          catch (error) { batchError = error; }
        }
        signal.throwIfAborted();
      }
      for (let i = 0; i < selected.length && !signal.aborted; i++) {
        const task = selected[i]!;
        this.offsets.set(kind, (start + i + 1) % tasks.length);
        await this.run(task.subjectKey!, async taskSignal => {
          const check = async () => { this.assertRunning(); signal.throwIfAborted(); taskSignal.throwIfAborted(); };
          const current = await this.store.get(task.id); if (!current) return;
          const lifecycle = this.lifecycle(current, check);
          const host = await this.options.context.tasks.get({ id: task.id });
          if (!host || host.threadId !== current.threadId || host.ownerCatId !== current.ownerCatId || host.status === 'done') {
            await lifecycle.ownerChanged(task.id); return;
          }
          // An initial failed projection needs an authenticated registration replay.
          // A background poll cannot manufacture its missing invocation receipt.
          if (!host.pluginWait) return;
          await lifecycle.recoverOutcome(task.id); await check();
          if (current.automationState?.waitOutcome) await this.settleProjection(task.id, check);
          if (!current.automationState?.await) { await this.settleProjection(task.id, check); return; }
          if (current.automationState.await.expiresAt !== undefined && current.automationState.await.expiresAt <= this.now()) {
            await lifecycle.observe({ taskId: task.id, at: this.now(), facts: {} });
            await this.settleProjection(task.id, check);
            return;
          }
          if (batchError) throw batchError; // Recover durable outboxes even when new facts are unavailable.
          const target = waitTarget(current);
          if (kind === 'pr' && this.options.provider.forCiBatch &&
              batchGenerations.get(task.id) !== current.automationState.await.generation) return;
          const snapshot = await provider.read(target, AbortSignal.any([signal, taskSignal]));
          await check();
          const configured = await this.options.context.config.get('cloudReviewerLogins');
          if (configured !== undefined && typeof configured !== 'string') throw new TypeError('cloudReviewerLogins must be a string');
          const observed = waitObservation(current, snapshot, this.now(),
            configured === undefined ? ['chatgpt-codex-connector[bot]'] : configured.split(/[\s,]+/).filter(Boolean));
          await this.options.observe?.(target, observed.snapshot); await check();
          await this.options.collect?.(target, waitEventSnapshot(current, observed.snapshot)); await check();
          await this.currentTask(current); await check();
          await lifecycle.observe(observed.observation);
          await this.settleProjection(task.id, check);
        }, this.options.objectTimeoutMs ?? 10_000).catch(() => this.options.context.log('warn', 'GitHub observation failed; wait and pending delivery remain recoverable'));
      }
    });
    this.polling.set(kind, operation);
    void operation.finally(() => this.polling.delete(kind)).catch(() => undefined);
    return operation;
  }

  async stop(): Promise<void> {
    this.stopController.abort(); await Promise.allSettled([...this.work]);
  }
}
