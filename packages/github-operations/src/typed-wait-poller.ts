import type { TypedWaitRuntimeOptions } from './typed-wait-runtime.js';
import type { GitHubWaitStorage } from './typed-wait-storage.js';
import type { TaskItem } from './business/model/index.js';
import type { GitHubWaitLifecycleService } from './business/domains/github-signals/GitHubWaitLifecycleService.js';
import type { GitHubWaitRecoveryCandidate } from './typed-wait-recovery-storage.js';
import type { GitHubTarget } from './tracking-runtime.js';
import { waitObservation, waitTarget, waitEventSnapshot } from './typed-wait-provider.js';
import { readNotificationFilter } from './notification-filter.js';
import { gitHubAdmissionCanContinue, gitHubObjectAdmission, gitHubObjectSignal, gitHubPollBudget } from './business/infrastructure/github/admission-budget.js';
import { GitHubRateLimitError, GitHubRequestDeferredError } from './business/infrastructure/github/request-budget.js';
import { diagnosticError, type DiagnosticError } from './tracking-diagnostics.js';

interface GitHubDuePollPorts {
  options: TypedWaitRuntimeOptions;
  store: GitHubWaitStorage;
  now(): number;
  run<T>(subject: string, action: (signal: AbortSignal) => Promise<T>, timeoutMs?: number): Promise<T>;
  assertRunning(): void;
  currentSubscription(task: TaskItem): Promise<TaskItem>;
  lifecycle(task: TaskItem, check: () => Promise<void>): GitHubWaitLifecycleService;
  projectImportedWait(id: string, check: () => Promise<void>): Promise<void>;
  recoveryNotices(candidate: GitHubWaitRecoveryCandidate): Promise<void>;
}
/** The GitHub owner retains provider, binding, lifecycle and delivery decisions. */
export async function pollGitHubDueWaits(runtime: GitHubDuePollPorts, kind: 'pr' | 'issue', signal: AbortSignal): Promise<void> {
  const started = runtime.now(), stats = { selected: 0, visited: 0, failed: 0, deferred: 0 };
  try {
      // Return before the next minute tick; leave time for canonical gh child
      // cleanup and Host RPC settlement inside the 90-second carrier deadline.
      const budget = gitHubPollBudget(signal, { now: runtime.now,
        pollBudgetMs: runtime.options.pollBudgetMs ?? 50_000,
        objectTimeoutMs: runtime.options.objectTimeoutMs ?? 40_000 });
      const candidates = await runtime.store.recovery.listDue(kind === 'pr' ? 'pr_tracking' : 'issue_tracking', runtime.now(), 20);
      if (!candidates.length) return;
      stats.selected = candidates.length;
      const selected = candidates.map(candidate => candidate.task);
      const byId = new Map(candidates.map(candidate => [candidate.task.id, candidate]));
      const batchGenerations = new Map<string, number>();
      let provider = runtime.options.provider;
      let batchError: unknown;
      if (kind === 'pr' && provider.forCiBatch) {
        const targets: GitHubTarget[] = [];
        for (const task of selected) {
          if (!gitHubAdmissionCanContinue(budget)) break;
          const recovery = byId.get(task.id)!.recovery;
          if (recovery.disposition || recovery.nextPollAt > runtime.now()) continue;
          const wait = task.automationState?.await;
          if (!wait || (wait.expiresAt !== undefined && wait.expiresAt <= runtime.now())) continue;
          if (task.status === 'done') continue;
          try { await runtime.currentSubscription(task); }
          catch { runtime.options.context.log('warn', 'GitHub imported binding is unavailable; observation remains paused'); continue; }
          targets.push(waitTarget(task)); batchGenerations.set(task.id, wait.generation);
        }
        if (targets.length) {
          try { provider = await provider.forCiBatch(targets,
            gitHubObjectSignal(budget)!); }
          catch (error) {
            if (error instanceof GitHubRateLimitError) batchError = error;
            else runtime.options.context.log('info', 'GitHub batch CI prefetch unavailable; subscriptions will be observed independently');
          }
        }
        signal.throwIfAborted();
      }
      for (let i = 0; i < selected.length && !signal.aborted && gitHubAdmissionCanContinue(budget); i++) {
        stats.visited++;
        const task = selected[i]!;
        const admission = gitHubObjectAdmission(budget), objectSignal = admission.signal!;
        let deferred = false, quotaDeferred = false, failed = false, attempted = false, succeeded = false;
        let errorDetail: DiagnosticError | undefined;
        let nextPollAt = runtime.now() + (runtime.options.pollIntervalMs ?? 60_000);
        const candidate = byId.get(task.id)!;
        await runtime.run(task.subjectKey!, async taskSignal => {
          const check = async () => { runtime.assertRunning(); signal.throwIfAborted(); taskSignal.throwIfAborted(); objectSignal.throwIfAborted(); };
          await runtime.recoveryNotices(candidate);
          const facts = await runtime.store.recovery.facts(task.id);
          const deadline = task.automationState?.await?.expiresAt;
          if (!facts || facts.scope !== candidate.recovery.scope || facts.revision !== candidate.recovery.revision || facts.disposition ||
            (facts.nextPollAt > runtime.now() && (deadline === undefined || deadline > runtime.now()))) return;
          const current = await runtime.store.get(task.id); if (!current) return;
          attempted = true;
          await runtime.currentSubscription(current);
          const lifecycle = runtime.lifecycle(current, check);
          await lifecycle.recoverOutcome(task.id); await check();
          if (current.automationState?.waitOutcome || !current.automationState?.await) await runtime.projectImportedWait(task.id, check);
          if (!current.automationState?.await) return;
          if (current.automationState.await.expiresAt !== undefined && current.automationState.await.expiresAt <= runtime.now()) {
            await lifecycle.observe({ taskId: task.id, at: runtime.now(), facts: {} });
            await runtime.projectImportedWait(task.id, check);
            return;
          }
          if (batchError) throw batchError; // Recover durable outboxes even when new facts are unavailable.
          const target = waitTarget(current);
          if (kind === 'pr' && runtime.options.provider.forCiBatch &&
              batchGenerations.get(task.id) !== current.automationState.await.generation) return;
          const snapshot = await provider.read(target, AbortSignal.any([signal, taskSignal, objectSignal]));
          await check();
          const configured = await runtime.options.context.config.get('cloudReviewerLogins');
          if (configured !== undefined && typeof configured !== 'string') throw new TypeError('cloudReviewerLogins must be a string');
          const observed = waitObservation(current, snapshot, runtime.now(),
            configured === undefined ? ['chatgpt-codex-connector[bot]'] : configured.split(/[\s,]+/).filter(Boolean));
          await runtime.options.observe?.(target, observed.snapshot); await check();
          await runtime.options.collect?.(target, waitEventSnapshot(current, observed.snapshot)); await check();
          await runtime.currentSubscription(current); await check();
          const notificationFilter = await readNotificationFilter(runtime.options.context, snapshot, observed.observation.facts.review?.reviewer);
          await lifecycle.observe({ ...observed.observation, notificationFilter });
          await runtime.projectImportedWait(task.id, check);
          succeeded = true;
        }, runtime.options.objectTimeoutMs ?? 40_000).catch(async error => {
          // A clipped timer can fire before Date.now reaches its deadline.
          // Preserve the admitted window's cause rather than inferring it later.
          deferred = objectSignal.aborted ? admission.limitedByPoll : !gitHubAdmissionCanContinue(budget);
          if (error instanceof GitHubRequestDeferredError) deferred = true;
          if (error instanceof GitHubRateLimitError) { deferred = true; quotaDeferred = true; nextPollAt = Math.max(nextPollAt, error.retryAt); }
          failed = !deferred && !signal.aborted;
          if (failed) errorDetail = await diagnosticError(error, runtime.options.context.secrets);
          runtime.options.context.log(deferred ? 'info' : 'warn', deferred
            ? 'GitHub poll budget used; resume this subscription next tick'
            : 'GitHub observation failed; wait and pending delivery remain recoverable',
            { taskId: task.id, kind, errorName: error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name) ? error.name : 'Error' });
        });
        if (attempted && !signal.aborted && (!deferred || quotaDeferred)) {
          await runtime.store.recovery.finish(candidate, failed ? 'failed' : succeeded ? 'succeeded' : 'deferred',
            Math.max(nextPollAt, runtime.now() + (runtime.options.pollIntervalMs ?? 60_000)), errorDetail)
            .catch(() => runtime.options.context.log('warn', 'GitHub recovery metadata publication deferred; original wait retained'));
        }
        stats.failed += Number(failed); stats.deferred += Number(deferred);
        if (signal.aborted || deferred) break;
      }
  } finally {
    runtime.options.context.log('info', 'GitHub wait recovery round', { kind, ...stats, elapsedMs: Math.max(0, runtime.now() - started) });
  }
}
