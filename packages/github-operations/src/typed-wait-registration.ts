import { z } from 'zod';
import { createHash } from 'node:crypto';
import {
  DEFAULT_GITHUB_TRACKING_NEXT_STEP, describeGitHubNotificationCoverage,
  expandGitHubPrTrackingGoal, expandGitHubIssueTracking,
  resolveGitHubNotificationPerspective, resolveGitHubIssueNotificationPerspective,
  type AutomationState, type AwaitStateV1, type TaskItem, type GitHubTrackingIdentityV1,
  type GitHubNotificationCoverageV1, type GitHubPrWaitPredicate,
} from './business/model/index.js';
import { canonicalizeGitHubWaitPredicates, canonicalizeGitHubIssueWaitPredicates } from './business/domains/github-signals/GitHubWaitPredicateCatalog.js';
import type { InitialPrWaitSnapshot } from './business/domains/github-signals/GitHubWaitBaselineReader.js';
import type { InitialIssueWaitSnapshot } from './business/domains/github-signals/GitHubIssueWaitBaselineReader.js';
import { transitionWaitState } from './business/domains/ball-custody/wait-state-machine.js';
import { automationGeneration } from './business/domains/github-signals/TaskAutomationState.js';
import type { GitHubWaitStorage } from './typed-wait-storage.js';
import { lifecycleEvent } from './business/domains/github-signals/GitHubWaitLifecycleService.js';
import { registerPrTrackingInputSchema, registerIssueTrackingInputSchema } from './tracking-mcp-schemas.js';

export class TrackingRegistrationError extends Error {
  constructor(readonly status: 400 | 409 | 422 | 503, message: string) { super(message); }
}

export interface PreparedGitHubWait {
  readonly kind: 'pr_tracking' | 'issue_tracking';
  readonly subjectKey: string;
  readonly state: AutomationState;
  readonly notification: GitHubNotificationCoverageV1;
  /** Stable input intent, excluding time-varying provider observations. */
  readonly requestFingerprint: string;
  readonly registrationId: string;
}

function fingerprint(input: unknown): string {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value)
      .filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
      .map(([name, item]) => [name, canonical(item)])) : value;
  return createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex');
}

function subject(kind: 'pr' | 'issue', repo: string, number: number): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new TrackingRegistrationError(400, 'repoFullName must be owner/repo');
  }
  return kind + ':' + repo.toLowerCase() + '#' + number;
}

function deadline(expiresAt: number | undefined, now: number) {
  if (expiresAt !== undefined && expiresAt <= now) throw new TrackingRegistrationError(400, 'expiresAt must be in the future');
}

// Preserve the original route's explicit unresolved-identity delivery mode.
async function trackingIdentity(read: () => Promise<GitHubTrackingIdentityV1>): Promise<GitHubTrackingIdentityV1> {
  try { return await read(); } catch { return {}; }
}

/** Moved registration business. Provider reads all complete before any task/state mutation. */
export async function preparePrWait(input: unknown, deps: {
  identity(repo: string, number: number): Promise<GitHubTrackingIdentityV1>;
  baseline(repo: string, number: number, when: readonly GitHubPrWaitPredicate[]): Promise<InitialPrWaitSnapshot>;
  coverage(repo: string, number: number, commentId: number): Promise<{ covered: boolean; reason?: string }>;
  now?: () => number;
}): Promise<PreparedGitHubWait> {
  const value = z.object(registerPrTrackingInputSchema).strict().parse(input);
  if (value.when && value.goal) throw new TrackingRegistrationError(400, 'provide at most one of when or goal');
  const at = (deps.now ?? Date.now)();
  deadline(value.expiresAt, at);
  const subjectKey = subject('pr', value.repoFullName, value.prNumber);
  const perspective = resolveGitHubNotificationPerspective(await trackingIdentity(() => deps.identity(value.repoFullName, value.prNumber)));
  const expansion = expandGitHubPrTrackingGoal(perspective, value.goal);
  if (!expansion.ok) throw new TrackingRegistrationError(400, expansion.error);
  const when = value.when ? canonicalizeGitHubWaitPredicates(value.when) as readonly GitHubPrWaitPredicate[] : expansion.when;
  const snapshot = await deps.baseline(value.repoFullName, value.prNumber, when);
  for (const predicate of when) {
    if (predicate.kind !== 'pr_review_result_available' || predicate.triggerCommentId === undefined) continue;
    const coverage = await deps.coverage(value.repoFullName, value.prNumber, predicate.triggerCommentId);
    if (!coverage.covered) throw new TrackingRegistrationError(422, 'Review-result trigger is not covered: ' + (coverage.reason ?? 'uncovered'));
  }
  return {
    kind: 'pr_tracking', subjectKey, registrationId: value.registrationId, requestFingerprint: fingerprint(value),
    notification: describeGitHubNotificationCoverage(perspective, when),
    state: { ...snapshot.collectorState, await: {
      v: 1, generation: 1, subjectRef: subjectKey as `pr:${string}#${number}`,
      ownerFence: { kind: 'containing_task', generation: 1 },
      baseline: snapshot.baseline, continuation: { when, then: value.nextStep ?? DEFAULT_GITHUB_TRACKING_NEXT_STEP },
      ...(value.expiresAt !== undefined ? { expiresAt: value.expiresAt } : {}),
      ...(value.autoRenew !== undefined ? { autoRenew: value.autoRenew } : {}),
      createdAt: at, provenance: 'explicit_registration',
    } },
  };
}

export async function prepareIssueWait(input: unknown, deps: {
  identity(repo: string, number: number): Promise<GitHubTrackingIdentityV1>;
  baseline(repo: string, number: number): Promise<InitialIssueWaitSnapshot>;
  now?: () => number;
}): Promise<PreparedGitHubWait> {
  const value = z.object(registerIssueTrackingInputSchema).strict().parse(input);
  const at = (deps.now ?? Date.now)();
  deadline(value.expiresAt, at);
  const subjectKey = subject('issue', value.repoFullName, value.issueNumber);
  const identity = await trackingIdentity(() => deps.identity(value.repoFullName, value.issueNumber));
  const perspective = resolveGitHubIssueNotificationPerspective(identity);
  const when = value.when ? canonicalizeGitHubIssueWaitPredicates(value.when) : expandGitHubIssueTracking(identity);
  const snapshot = await deps.baseline(value.repoFullName, value.issueNumber);
  return {
    kind: 'issue_tracking', subjectKey, registrationId: value.registrationId, requestFingerprint: fingerprint(value),
    notification: describeGitHubNotificationCoverage(perspective, when),
    state: { ...snapshot.collectorState, await: {
      v: 1, generation: 1, subjectRef: subjectKey as `issue:${string}#${number}`,
      ownerFence: { kind: 'containing_task', generation: 1 },
      baseline: snapshot.baseline, continuation: { when, then: value.nextStep ?? DEFAULT_GITHUB_TRACKING_NEXT_STEP },
      ...(value.expiresAt !== undefined ? { expiresAt: value.expiresAt } : {}),
      ...(value.autoRenew !== undefined ? { autoRenew: value.autoRenew } : {}),
      createdAt: at, provenance: 'explicit_registration',
    } },
  };
}

/** Replay before provider reads, including when the provider is down after a lost response. */
async function registerWait(store: GitHubWaitStorage, task: TaskItem, kind: PreparedGitHubWait['kind'],
  value: { registrationId: string; repoFullName: string; prNumber?: number; issueNumber?: number },
  prepare: () => Promise<PreparedGitHubWait>): Promise<TaskItem> {
  const expectedSubject = subject(kind === 'pr_tracking' ? 'pr' : 'issue', value.repoFullName,
    (kind === 'pr_tracking' ? value.prNumber : value.issueNumber)!);
  if (task.kind !== kind || task.subjectKey !== expectedSubject || !task.ownerCatId) {
    throw new TrackingRegistrationError(409, 'Tracking task does not match the subject/owner');
  }
  const current = await store.get(task.id);
  if (current) assertSameOwner(current, task);
  const replay = await store.registrationResult(task.id, { id: value.registrationId, fingerprint: fingerprint(value) });
  if (replay) { assertSameOwner(replay, task); return replay; }
  return installPreparedWait(store, task, await prepare());
}

export function registerPrWait(store: GitHubWaitStorage, task: TaskItem, input: unknown,
  deps: Parameters<typeof preparePrWait>[1]): Promise<TaskItem> {
  const value = z.object(registerPrTrackingInputSchema).strict().parse(input);
  return registerWait(store, task, 'pr_tracking', value, () => preparePrWait(value, deps));
}

export function registerIssueWait(store: GitHubWaitStorage, task: TaskItem, input: unknown,
  deps: Parameters<typeof prepareIssueWait>[1]): Promise<TaskItem> {
  const value = z.object(registerIssueTrackingInputSchema).strict().parse(input);
  return registerWait(store, task, 'issue_tracking', value, () => prepareIssueWait(value, deps));
}

function assertSameOwner(current: TaskItem, task: TaskItem): void {
  if (current.threadId !== task.threadId || current.ownerCatId !== task.ownerCatId
    || current.userId !== task.userId || current.subjectKey !== task.subjectKey) {
    throw new TrackingRegistrationError(409, 'Tracking belongs to a different owner or thread');
  }
}

/** Port of the route's generation/outbox transition, on the plugin-private aggregate. */
export async function installPreparedWait(store: GitHubWaitStorage, task: TaskItem, plan: PreparedGitHubWait): Promise<TaskItem> {
  if (task.kind !== plan.kind || task.subjectKey !== plan.subjectKey || !task.ownerCatId) {
    throw new TrackingRegistrationError(409, 'Tracking task does not match the subject/owner');
  }
  const current = await store.get(task.id);
  if (current) assertSameOwner(current, task);
  const request = { id: plan.registrationId, fingerprint: plan.requestFingerprint };
  const replayResult = async () => {
    const result = await store.registrationResult(task.id, request);
    if (result) assertSameOwner(result, task);
    return result;
  };
  const replay = await replayResult();
  if (replay) return replay;
  if (!current) {
    const created = await store.create({ ...task, status: 'doing', automationState: plan.state, notification: plan.notification }, request);
    if (!created) {
      const winner = await replayResult();
      if (winner) return winner;
      throw new TrackingRegistrationError(409, 'Tracking registration raced');
    }
    return created;
  }
  const previous = current.automationState;
  const at = plan.state.await!.createdAt;
  const generation = (automationGeneration(previous) ?? 0) + 1;
  const superseded = previous?.await ? transitionWaitState(previous, {
    type: 'superseded', generation: previous.await.generation, at,
  }) : undefined;
  const supersededOutcome = superseded?.applied ? superseded.state.waitOutcome : undefined;
  const pending = previous?.waitOutcome?.delivery === 'pending' ? previous.waitOutcome : undefined;
  if (pending && supersededOutcome?.delivery === 'pending') {
    throw new TrackingRegistrationError(409, 'Tracking has a pending delivery; retry after recovery');
  }
  const retained = pending ?? supersededOutcome;
  const active = { ...plan.state.await, generation, ownerFence: { kind: 'containing_task', generation } } as AwaitStateV1;
  const installed = await store.replaceAutomationStateIfGeneration(task.id, {
    expectedGeneration: automationGeneration(previous), expectedUpdatedAt: current.updatedAt,
    status: 'doing', automationState: { ...previous, ...plan.state, await: active, waitOutcome: retained } as AutomationState,
    registration: request,
    notification: plan.notification,
    ...(supersededOutcome ? { lifecycleEvent: lifecycleEvent(current, supersededOutcome) } : {}),
  });
  if (!installed) {
    const winner = await replayResult();
    if (winner) return winner;
    throw new TrackingRegistrationError(409, 'Tracking registration raced');
  }
  return installed;
}
