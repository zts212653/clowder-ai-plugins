import { createHash, randomUUID } from 'node:crypto';
import type { PluginMessagingDraft, PluginStorageHost, PluginThreadHost } from '@clowder-ai/plugin-sdk';
import { createGitHubFeedbackFilter } from './business/infrastructure/email/github-feedback-filter.js';
import { createSetupNoiseFilter } from './business/infrastructure/email/setup-noise-filter.js';
import { classifyIssueComment } from './business/domains/community/issue-analysis/issue-comment-classifier.js';
import { classifyGitHubReviewLoopBrake } from './business/domains/github-signals/github-wait-renderer.js';
import { classifyExternalCloudReview, type CloudReviewRequest } from './business/domains/community/external-review/external-cloud-review-classifier.js';
import type { ExternalCloudObservation } from './business/domains/community/external-review/ExternalReviewCoordinator.js';
import { copyLegacyIssueProgress, readLegacyIssueProgress } from './legacy-issue-progress.js';
import { legacyIssueOperationInput } from './legacy-issue-observations.js';

export interface GitHubTarget {
  readonly kind: 'pr' | 'issue';
  readonly repoFullName: string;
  readonly number: number;
  readonly threadId: string;
  readonly catId: string;
  readonly reviewThreadIds?: readonly string[];
  readonly cloudReviewRequest?: CloudReviewRequest;
}
export interface GitHubComment {
  readonly id: number;
  readonly author: string;
  readonly body: string;
  readonly commentType: 'inline' | 'conversation';
  readonly commitId?: string;
  readonly reviewId?: number;
  readonly createdAt?: string;
  readonly actorType?: string;
  readonly authorAssociation?: string;
}
export interface GitHubReview {
  readonly id: number;
  readonly author: string;
  readonly state: string;
  readonly commitId?: string;
  readonly submittedAt?: string;
  readonly actorType?: string;
  readonly authorAssociation?: string;
}
export interface GitHubSnapshot {
  readonly trackingIdentity?: import('./business/model/index.js').GitHubTrackingIdentityV1;
  readonly state: 'open' | 'closed' | 'merged';
  readonly authorLogin?: string;
  readonly mergedByLogin?: string;
  readonly headSha?: string;
  readonly ci?: 'pending' | 'pass' | 'fail' | 'external_infrastructure';
  readonly ciBlockerCount?: number;
  readonly mergeState?: string;
  readonly comments: readonly GitHubComment[];
  readonly reviews: readonly GitHubReview[];
  /** Only the provider may attest an unfiltered, fully paginated comment read. */
  readonly commentsComplete?: boolean;
  readonly cloudObservation?: Omit<ExternalCloudObservation, 'repoFullName' | 'prNumber'>;
  readonly reviewThreads?: readonly { reviewThreadId: string; resolved: boolean; lastCommentId: string | null }[];
}
export interface GitHubTrackingProvider {
  read(target: GitHubTarget, signal: AbortSignal, cursor?: { inline: number; conversation: number }): Promise<GitHubSnapshot>;
  forCiBatch?(targets: readonly GitHubTarget[], signal: AbortSignal): Promise<GitHubTrackingProvider>;
}
type Channel = 'cicd-check' | 'conflict-check' | 'review-feedback' | 'issue-tracking';
interface Marker {
  readonly headSha?: string;
  readonly ci?: string;
  readonly mergeState?: string;
  readonly cloud?: string;
  readonly inline: number;
  readonly conversation: number;
  readonly reviews: Readonly<Record<string, string>>;
  readonly threads?: Readonly<Record<string, { resolved: boolean; lastCommentId: string | null }>>;
}
interface PendingNotification { readonly id: string; readonly text: string; readonly identity: string; readonly wake: boolean }
interface TrackingRecord {
  readonly schema: 1;
  readonly registrationId: string;
  readonly pollSequence: number;
  readonly target: GitHubTarget;
  readonly active: boolean;
  readonly terminal: boolean;
  readonly baselines: Partial<Record<Channel, Marker>>;
  readonly pending: readonly PendingNotification[];
}
export interface GitHubTrackingDependencies {
  /** Internal polling policy/test clock, never a Host action context. */
  readonly now?: () => number;
  readonly pollBudgetMs?: number;
  readonly objectTimeoutMs?: number;
  readonly storage: PluginStorageHost;
  readonly threads: Pick<PluginThreadHost, 'bind'>;
  readonly send: (threadId: string, draft: PluginMessagingDraft) => Promise<{ messageId: string; threadId: string }>;
  readonly provider: GitHubTrackingProvider;
  readonly selfLogin: () => Promise<string | undefined>;
  readonly noiseLogins: () => Promise<readonly string[]>;
  readonly cloudReviewerLogins?: () => Promise<readonly string[]>;
  /** Real module wires its Community journal here; a failed collection must
   * leave tracking cursors and terminal retirement unchanged. */
  readonly collect?: (target: GitHubTarget, snapshot: GitHubSnapshot) => Promise<void>;
  /** Provider-only projection. No callback principal, lease or verdict writes. */
  readonly observe?: (target: GitHubTarget, snapshot: GitHubSnapshot) => Promise<void>;
}

const PREFIX = 'github.tracking.v1.';
const channels: readonly Channel[] = ['cicd-check', 'conflict-check', 'review-feedback', 'issue-tracking'];
function subject(value: Pick<GitHubTarget, 'kind' | 'repoFullName' | 'number'>): string {
  if (value.kind !== 'pr' && value.kind !== 'issue') throw new TypeError('kind must be pr or issue');
  if (typeof value.repoFullName !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repoFullName)) {
    throw new TypeError('repoFullName must be owner/repository');
  }
  if (!Number.isSafeInteger(value.number) || value.number < 1) throw new TypeError('number must be a positive integer');
  return `${value.kind}:${value.repoFullName.toLowerCase()}#${value.number}`;
}
function keyOf(target: Pick<GitHubTarget, 'kind' | 'repoFullName' | 'number'>): string {
  return PREFIX + createHash('sha256').update(subject(target)).digest('hex');
}
// GitHub dismisses a review in place. Preserve the migrated #1392 rule:
// dismissal is final for that review ID, including late/omitted observations.
function reviewChanged(review: GitHubReview, previous: Marker): boolean {
  const known = previous.reviews[String(review.id)];
  return !known?.startsWith('DISMISSED:') && known !== `${review.state}:${review.commitId ?? ''}`;
}
function marker(snapshot: GitHubSnapshot, previous?: Marker): Marker {
  return {
    ...(snapshot.headSha === undefined ? {} : { headSha: snapshot.headSha }),
    ...(snapshot.ci === undefined ? {} : { ci: snapshot.ci }),
    ...(snapshot.mergeState === undefined ? {} : { mergeState: snapshot.mergeState }),
    ...(snapshot.cloudObservation ? { cloud: JSON.stringify(snapshot.cloudObservation) } : previous?.cloud ? { cloud: previous.cloud } : {}),
    inline: snapshot.comments.filter(c => c.commentType === 'inline').reduce((max, c) => Math.max(max, c.id), previous?.inline ?? 0),
    conversation: snapshot.comments.filter(c => c.commentType === 'conversation').reduce((max, c) => Math.max(max, c.id), previous?.conversation ?? 0),
    reviews: { ...previous?.reviews, ...Object.fromEntries(snapshot.reviews
      .filter(r => !previous?.reviews[String(r.id)]?.startsWith('DISMISSED:'))
      .map(r => [String(r.id), `${r.state}:${r.commitId ?? ''}`])) },
    ...(snapshot.reviewThreads ? { threads: Object.fromEntries(snapshot.reviewThreads.map(t => [t.reviewThreadId, { resolved: t.resolved, lastCommentId: t.lastCommentId }])) } : {}),
  };
}
function recordOf(value: unknown): TrackingRecord {
  const record = value as TrackingRecord;
  if (!record || record.schema !== 1 || !record.registrationId || !record.target || !Array.isArray(record.pending) ||
      !Number.isSafeInteger(record.pollSequence) || record.pollSequence < 0) {
    throw new TypeError('invalid persisted GitHub tracking record');
  }
  subject(record.target);
  return record;
}

/** Package-owned registrations, polling and durable notification outbox. No Host task/custody state. */
export class GitHubTrackingRuntime {
  private readonly lifecycle = new AbortController();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly polling = new Map<string, AbortController>();
  private stopping = false;
  private readonly now: () => number;
  private readonly pollBudgetMs: number;
  private readonly objectTimeoutMs: number;
  constructor(private readonly deps: GitHubTrackingDependencies) {
    this.now = deps.now ?? Date.now;
    this.pollBudgetMs = deps.pollBudgetMs ?? 25_000;
    this.objectTimeoutMs = deps.objectTimeoutMs ?? 10_000;
    if (![this.pollBudgetMs, this.objectTimeoutMs].every(value => Number.isSafeInteger(value) && value > 0)) {
      throw new TypeError('GitHub polling budgets must be positive integer milliseconds');
    }
  }

  private serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
    if (this.stopping) return Promise.reject(new Error('GitHub plugin is stopped'));
    const before = this.queues.get(key) ?? Promise.resolve();
    const next = before.catch(() => undefined).then(() => {
      this.lifecycle.signal.throwIfAborted();
      return operation();
    });
    this.queues.set(key, next);
    void next.finally(() => { if (this.queues.get(key) === next) this.queues.delete(key); }).catch(() => undefined);
    return next;
  }

  async register(input: GitHubTarget): Promise<{ subjectKey: string; active: true }> {
    const key = keyOf(input);
    if (input.cloudReviewRequest !== undefined) {
      const request = input.cloudReviewRequest;
      if (input.kind !== 'pr' || !request || typeof request !== 'object' || Array.isArray(request) ||
        Object.keys(request).some(key => !['headSha', 'triggerCommentId', 'requestedAt'].includes(key)) ||
        typeof request.headSha !== 'string' || !/^[a-f0-9]{40}$/i.test(request.headSha) ||
        !Number.isSafeInteger(request.triggerCommentId) || request.triggerCommentId < 1 ||
        !Number.isSafeInteger(request.requestedAt) || request.requestedAt < 0) throw new TypeError('invalid cloud review observation request');
    }
    if (!input.threadId?.trim() || !input.catId?.trim()) throw new TypeError('threadId and catId are required');
    if (input.reviewThreadIds !== undefined && (input.kind !== 'pr' || !Array.isArray(input.reviewThreadIds) ||
        input.reviewThreadIds.length > 100 || input.reviewThreadIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 256))) {
      throw new TypeError('reviewThreadIds must be at most 100 nonempty PR thread ids');
    }
    return this.serialize(key, async () => {
      const old = await this.deps.storage.get(key);
      if (old) {
        const existing = recordOf(old.value);
        if (existing.active) {
          if (existing.target.threadId !== input.threadId || existing.target.catId !== input.catId ||
              JSON.stringify(existing.target.reviewThreadIds ?? []) !== JSON.stringify(input.reviewThreadIds ?? []) ||
              existing.target.cloudReviewRequest?.headSha !== input.cloudReviewRequest?.headSha ||
              existing.target.cloudReviewRequest?.triggerCommentId !== input.cloudReviewRequest?.triggerCommentId ||
              existing.target.cloudReviewRequest?.requestedAt !== input.cloudReviewRequest?.requestedAt) {
            throw new Error('REGISTRATION_CONFLICT: unregister the existing target before changing its destination');
          }
          return { subjectKey: subject(input), active: true };
        }
      }
      // The mandatory Host bind validates existence, deleted state and owner
      // access under thread.write before provider reads or state activation.
      await this.deps.threads.bind(subject(input), input.threadId);
      const copied = !old && input.kind === 'issue' ? await readLegacyIssueProgress(subject(input), this.deps.storage) : undefined;
      const baseline: Marker = copied ? { inline: 0, conversation: copied.delivered, reviews: {} }
        : marker(await this.deps.provider.read(input, this.lifecycle.signal));
      this.lifecycle.signal.throwIfAborted();
      const record: TrackingRecord = {
        schema: 1, registrationId: randomUUID(), pollSequence: 0, target: { ...input, repoFullName: input.repoFullName.toLowerCase() },
        active: true, terminal: false,
        baselines: Object.fromEntries(channels.map(channel => [channel, baseline])), pending: [],
      };
      const result = await this.deps.storage.compareAndSet(key, old?.revision ?? null, record);
      if (!result.applied) throw new Error('registration changed concurrently');
      return { subjectKey: subject(input), active: true };
    });
  }

  async importLegacyIssueProgress(value: unknown) {
    return this.serialize('legacy-issue-progress-import', () => copyLegacyIssueProgress(
      legacyIssueOperationInput(value), this.deps.storage, this.lifecycle.signal, (key, work) => this.serialize(key, work)));
  }

  async unregister(target: Pick<GitHubTarget, 'kind' | 'repoFullName' | 'number'>): Promise<{ active: false }> {
    const key = keyOf(target);
    this.polling.get(key)?.abort(new Error('tracking unregistered'));
    return this.serialize(key, async () => {
      const current = await this.deps.storage.get(key);
      if (current) {
        const record = recordOf(current.value);
        const result = await this.deps.storage.compareAndSet(key, current.revision, { ...record, active: false });
        if (!result.applied) throw new Error('registration changed concurrently');
      }
      return { active: false };
    });
  }

  async list(): Promise<readonly { subjectKey: string; target: GitHubTarget; active: boolean; pending: number }[]> {
    const all = await this.deps.storage.list();
    return Object.entries(all).filter(([key]) => key.startsWith(PREFIX)).map(([, entry]) => {
      const record = recordOf(entry.value);
      return { subjectKey: subject(record.target), target: record.target, active: record.active, pending: record.pending.length };
    });
  }

  async poll(channel: Channel): Promise<void> {
    return this.serialize(`github.poll.${channel}`, () => this.pollBatch(channel));
  }

  private async pollBatch(channel: Channel): Promise<void> {
    this.lifecycle.signal.throwIfAborted();
    const deadline = this.now() + this.pollBudgetMs;
    const failures: unknown[] = [];
    const entries = await this.deps.storage.list();
    const eligible = Object.entries(entries).filter(([key, entry]) => {
      if (!key.startsWith(PREFIX)) return false;
      const record = recordOf(entry.value);
      return record.active && (channel === 'issue-tracking') === (record.target.kind === 'issue');
    }).map(([key]) => key).sort();
    if (!eligible.length) return;
    const cursorKey = `github.poll-cursor.${channel}`;
    const cursor = (await this.deps.storage.get(cursorKey))?.value;
    if (cursor !== undefined && typeof cursor !== 'string') throw new TypeError('invalid persisted GitHub poll cursor');
    const resume = typeof cursor === 'string' ? eligible.findIndex(key => key > cursor) : 0;
    const start = resume < 0 ? 0 : resume;
    let ordered = [...eligible.slice(start), ...eligible.slice(0, start)];
    let provider = this.deps.provider;
    if (channel === 'cicd-check' && provider.forCiBatch) {
      // Bound GraphQL query size and rotate the remaining subjects next tick.
      ordered = ordered.slice(0, 20);
      const targets = ordered.map(key => recordOf(entries[key]!.value).target);
      const signal = AbortSignal.any([this.lifecycle.signal, AbortSignal.timeout(Math.min(this.objectTimeoutMs, Math.max(1, deadline - this.now())))]);
      try {
        provider = await provider.forCiBatch(targets, signal);
        signal.throwIfAborted();
      } catch (error) {
        this.lifecycle.signal.throwIfAborted();
        await this.deps.storage.set(cursorKey, ordered.at(-1)!);
        throw error;
      }
    }
    for (const key of ordered) {
      this.lifecycle.signal.throwIfAborted();
      if (this.now() >= deadline) break;
      try { await this.serialize(key, () => this.pollTarget(key, channel, deadline, provider)); }
      catch (error) { this.lifecycle.signal.throwIfAborted(); failures.push(error); }
      // Failed remote targets also advance fairness. Their registration and
      // observation cursors remain intact for a later round.
      await this.deps.storage.set(cursorKey, key);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'GitHub poll failed for multiple targets');
  }

  private async pollTarget(key: string, channel: Channel, deadline: number, provider: GitHubTrackingProvider): Promise<void> {
    const controller = new AbortController();
    const abort = () => controller.abort(this.lifecycle.signal.reason);
    this.lifecycle.signal.addEventListener('abort', abort, { once: true });
    this.polling.set(key, controller);
    try {
      await this.flush(key, controller.signal);
      const current = await this.deps.storage.get(key);
      if (!current) return;
      const record = recordOf(current.value);
      if (!record.active) return;
      // All terminal observations collect the remaining comments before retiring.
      const feedback = record.baselines[record.target.kind === 'pr' ? 'review-feedback' : 'issue-tracking']!;
      if (this.now() >= deadline) return;
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(Math.min(this.objectTimeoutMs, Math.max(1, deadline - this.now())))]);
      // Await the actual provider child cleanup on abort; never race away from
      // a still-running child and release this registration's serialized lease.
      const read = await provider.read(record.target, signal, feedback);
      signal.throwIfAborted();
      controller.signal.throwIfAborted();
      const reviews = read.reviews.map(review => feedback.reviews[String(review.id)]?.startsWith('DISMISSED:')
        ? { ...review, state: 'DISMISSED' } : review);
      const observedReviewIds = new Set(reviews.map(review => String(review.id)));
      // A regressed provider list cannot clear prior cloud evidence via the
      // no-review/comment fallback. Wait for a complete observation instead.
      const missingReviewEvidence = Object.keys(feedback.reviews).some(id => !observedReviewIds.has(id));
      const classification = !missingReviewEvidence && record.target.kind === 'pr' && read.headSha && record.target.cloudReviewRequest
        ? classifyExternalCloudReview({
          currentHeadSha: read.headSha, request: record.target.cloudReviewRequest,
          commentsComplete: read.commentsComplete === true, comments: read.comments, reviews,
          knownCloudReviewerLogins: await this.deps.cloudReviewerLogins?.() ?? ['chatgpt-codex-connector[bot]'],
          now: this.now(), timeoutMs: 30 * 60_000,
        }) : null;
      // Never accept a provider/plugin payload's pre-computed cloud verdict.
      const { cloudObservation: _untrusted, ...facts } = read;
      const snapshot: GitHubSnapshot = { ...facts, reviews, ...(classification?.observation ? { cloudObservation: classification.observation } : {}) };
      await this.deps.observe?.(record.target, snapshot);
      controller.signal.throwIfAborted();
      if (channel === 'review-feedback' || channel === 'issue-tracking' || snapshot.state !== 'open') {
        await this.deps.collect?.(record.target, {
          ...snapshot,
          comments: snapshot.comments.filter(comment =>
            comment.id > (comment.commentType === 'inline' ? feedback.inline : feedback.conversation) &&
            (!comment.commitId || comment.commitId === snapshot.headSha)),
          reviews: snapshot.reviews.filter(review =>
            reviewChanged(review, feedback) &&
            (!review.commitId || review.commitId === snapshot.headSha ||
              (review.state === 'DISMISSED' && feedback.reviews[String(review.id)] !== undefined))),
        });
        controller.signal.throwIfAborted();
      }
      const changes = await this.changes(record, channel, snapshot);
      controller.signal.throwIfAborted();
      const terminal = snapshot.state !== 'open';
      const login = await this.deps.selfLogin();
      const selfMerge = snapshot.state === 'merged' && !!login &&
        snapshot.mergedByLogin?.toLowerCase() === login.toLowerCase();
      const newChangesRequested = snapshot.reviews.filter(review =>
        review.state === 'CHANGES_REQUESTED' && reviewChanged(review, feedback) &&
        (!review.commitId || review.commitId === snapshot.headSha) && review.author.toLowerCase() !== login?.toLowerCase());
      const pauseReviewWake = snapshot.state === 'open' && channel === 'review-feedback' && newChangesRequested.length > 0 &&
        classifyGitHubReviewLoopBrake(snapshot.reviews, newChangesRequested.map(review => review.id), snapshot.authorLogin).kind === 'pause_once';
      if (pauseReviewWake) changes.push('- Automatic review wake paused once after four formal changes-requested reviews. Read the accepted source and write a Finding Pattern Summary before requesting another review.');
      const text = [`🔔 **GitHub update** — ${subject(record.target)}`, '', ...changes].join('\n');
      const pollSequence = record.pollSequence + 1;
      if (!Number.isSafeInteger(pollSequence)) throw new Error('GitHub tracking poll sequence exhausted');
      const pending = changes.length ? [{
        id: `github:${record.registrationId}:${pollSequence}:${channel}:${createHash('sha256').update(JSON.stringify([marker(snapshot), snapshot.state, changes])).digest('hex')}`,
        text, identity: 'github-notification', wake: !selfMerge && !pauseReviewWake,
      }] : [];
      const next: TrackingRecord = {
        ...record, terminal, pollSequence, baselines: { ...record.baselines, [channel]: marker(snapshot, record.baselines[channel]) }, pending,
        active: terminal ? pending.length > 0 : true,
      };
      if (!(await this.deps.storage.compareAndSet(key, current.revision, next)).applied) return;
      await this.flush(key, controller.signal);
    } finally {
      this.lifecycle.signal.removeEventListener('abort', abort);
      this.polling.delete(key);
    }
  }

  private async changes(record: TrackingRecord, channel: Channel, snapshot: GitHubSnapshot): Promise<string[]> {
    const before = record.baselines[channel]!;
    const lines: string[] = [];
    if (snapshot.state !== 'open') lines.push(`- ${record.target.kind === 'pr' ? 'PR' : 'Issue'} ${snapshot.state}`);
    if (channel === 'cicd-check' && (snapshot.ci !== before.ci || snapshot.headSha !== before.headSha)) {
      lines.push(`- CI ${snapshot.ci ?? 'pending'} at ${(snapshot.headSha ?? '').slice(0, 12)}`);
    }
    if (channel === 'conflict-check' && snapshot.mergeState && snapshot.mergeState !== 'UNKNOWN' && snapshot.mergeState !== before.mergeState) {
      lines.push(`- Merge state ${snapshot.mergeState}`);
    }
    if (channel === 'review-feedback' || channel === 'issue-tracking' || snapshot.state !== 'open') {
      const feedbackBefore = record.baselines[record.target.kind === 'pr' ? 'review-feedback' : 'issue-tracking']!;
      if (snapshot.cloudObservation && JSON.stringify(snapshot.cloudObservation) !== feedbackBefore.cloud) {
        lines.push(`- Cloud review ${snapshot.cloudObservation.status} at ${snapshot.cloudObservation.headSha.slice(0, 12)} (provider observation; not a governance verdict)`);
      }
      const echo = createGitHubFeedbackFilter({ selfGitHubLogin: await this.deps.selfLogin() });
      const noise = createSetupNoiseFilter(await this.deps.noiseLogins());
      for (const comment of snapshot.comments) {
        if (comment.id <= (comment.commentType === 'inline' ? feedbackBefore.inline : feedbackBefore.conversation)) continue;
        if (comment.commitId && comment.commitId !== snapshot.headSha) continue;
        const classification = record.target.kind === 'issue'
          ? classifyIssueComment(comment, { isEchoComment: echo.shouldSkipComment, isNoiseComment: noise })
          : { critical: false, suppressionReason: echo.shouldSkipComment(comment) || noise(comment) };
        if (classification.suppressionReason) continue;
        // Provider bodies are evidence to classify, not instructions injected into the owner thread.
        lines.push(`- ${classification.critical ? 'Critical ' : ''}${comment.commentType} comment from ${comment.author}: github:${record.target.kind}-comment:${comment.id}`);
      }
      for (const review of snapshot.reviews) {
        const knownDismissal = review.state === 'DISMISSED' && feedbackBefore.reviews[String(review.id)] !== undefined;
        if (echo.shouldSkipReview(review) || (review.commitId && review.commitId !== snapshot.headSha && !knownDismissal)) continue;
        if (!reviewChanged(review, feedbackBefore)) continue;
        lines.push(`- Review ${review.state} from ${review.author}: github:review:${review.id}`);
      }
      for (const thread of snapshot.reviewThreads ?? []) {
        const prior = feedbackBefore.threads?.[thread.reviewThreadId];
        if (!prior) continue;
        if (prior.resolved !== thread.resolved) lines.push(`- Review thread ${thread.reviewThreadId} ${thread.resolved ? 'resolved' : 'reopened'}`);
        if (prior.lastCommentId !== thread.lastCommentId && thread.lastCommentId) lines.push(`- Review thread ${thread.reviewThreadId} reply: ${thread.lastCommentId}`);
      }
    }
    return lines;
  }

  private async flush(key: string, signal: AbortSignal): Promise<void> {
    const current = await this.deps.storage.get(key);
    if (!current) return;
    const record = recordOf(current.value);
    if (!record.active) return;
    for (const notification of record.pending) {
      signal.throwIfAborted();
      await this.deps.send(record.target.threadId, {
        identity: notification.identity, idempotencyKey: notification.id,
        ...(notification.wake ? { wake: { catId: record.target.catId } } : {}),
        url: `https://github.com/${record.target.repoFullName}/${record.target.kind === 'pr' ? 'pull' : 'issues'}/${record.target.number}`,
        payload: { provenance: { epistemicStatus: 'observation' }, elements: [
          { elementId: notification.id, kind: 'text', payload: { text: notification.text } },
        ] },
      });
    }
    if (record.pending.length > 0) {
      const result = await this.deps.storage.compareAndSet(key, current.revision, { ...record, pending: [], active: !record.terminal });
      if (!result.applied) throw new Error('notification acknowledgement raced with registration');
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.lifecycle.abort(new Error('GitHub plugin stopped'));
    await Promise.allSettled([...this.queues.values()]);
  }
}
