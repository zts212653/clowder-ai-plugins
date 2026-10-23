import type { FeatureContext } from '@clowder-ai/plugin-sdk';
import { createRepoScanner } from './business/infrastructure/connectors/github-repo-event/RepoScanTaskSpec.js';
import { GitHubRepoWebhookHandler } from './business/infrastructure/connectors/github-repo-event/GitHubRepoWebhookHandler.js';
import { SdkDeliveryDedup } from './business/infrastructure/connectors/github-repo-event/SdkDeliveryDedup.js';
import type { GitHubSnapshot, GitHubTarget } from './tracking-runtime.js';
import type { CommunityEvent } from './business/model/index.js';
import { issueCommentEventId, reviewEventId } from './business/domains/community/community-keys.js';
import { SdkCommunityEventLog } from './business/domains/community/CommunityEventLog.js';
import { SdkCommunityObjectStore } from './business/domains/community/CommunityObjectStore.js';
import { SdkCommunityRepoConfigStore, type UpsertRepoConfigInput } from './business/domains/community/CommunityRepoConfigStore.js';
import { CommunityProjector, CommunityProjectionOperations } from './business/domains/community/community-projector.js';
import { CommunityReconciliationFindingStore } from './business/domains/community/reconciliation/CommunityReconciliationFindingStore.js';
import { runCommunityReconciliation } from './business/domains/community/reconciliation/CommunityReconcilerTaskSpec.js';
import type { GitHubSnapshot as ReconciliationSnapshot } from './business/domains/community/reconciliation/CommunityReconciler.js';
import { createRepoCommentPoller, type RepoIssueComment } from './business/infrastructure/connectors/github-repo-event/RepoCommentPollTaskSpec.js';
import { classifyIssueComment } from './business/domains/community/issue-analysis/issue-comment-classifier.js';
import { createGitHubFeedbackFilter } from './business/infrastructure/email/github-feedback-filter.js';
import { createSetupNoiseFilter } from './business/infrastructure/email/setup-noise-filter.js';
import { ExternalReviewCoordinator } from './business/domains/community/external-review/ExternalReviewCoordinator.js';
import { providerObservation } from './community-read-model.js';
import { SdkCommunityIssueStore } from './business/domains/community/CommunityIssueStore.js';
import { copyLegacyIssueObservations, legacyIssueOperationInput } from './legacy-issue-observations.js';
import { communityProgressKey as stateKey, copyLegacyRepositoryProgress, restoreLegacyRepositoryProgress } from './legacy-repository-progress.js';
import { copyLegacyProviderHistory, inspectLegacyProviderHistory } from './legacy-provider-history.js';

export interface RepoSubject {
  kind: 'pr' | 'issue'; number: number; title: string; url: string;
  author: string; authorAssociation: string; draft: boolean;
}
export interface CommunityProvider {
  listOpen(repo: string, signal: AbortSignal): Promise<RepoSubject[]>;
  repoComments(repo: string, since: string | undefined, signal: AbortSignal): Promise<RepoIssueComment[]>;
  state(repo: string, kind: 'pr' | 'issue', number: number, signal: AbortSignal): Promise<ReconciliationSnapshot | null>;
  selfLogin(): string | undefined;
}

/** Community business belongs to this installation. Host provides only storage,
 * thread permissions and message delivery, including the optional wake. */
export class CommunityRuntime {
  readonly events: SdkCommunityEventLog;
  readonly objects: SdkCommunityObjectStore;
  readonly configs: SdkCommunityRepoConfigStore;
  readonly findings: CommunityReconciliationFindingStore;
  readonly projectionOperations = new CommunityProjectionOperations();
  private readonly projector: CommunityProjector;
  private readonly observations: ExternalReviewCoordinator;
  private readonly lifetime = new AbortController();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly repos: string[] = [];
  private noiseLogins: string[] = [];
  private readonly commentPoll: (signal: AbortSignal) => Promise<void>;
  private stopping = false;
  private readonly scan: (signal: AbortSignal) => Promise<void>;
  private readonly scanResults = new Map<string, RepoSubject[]>();

  private readonly log: Readonly<Record<'info'|'warn'|'error', (...args: unknown[]) => void>>;

  constructor(private readonly context: FeatureContext, private readonly provider: CommunityProvider) {
    this.log = {info: (...args: unknown[]) => context.log('info', String(args[0]), {args}),warn: (...args: unknown[]) => context.log('warn', String(args[0]), {args}),error: (...args: unknown[]) => context.log('error', String(args[0]), {args})};
    this.events = new SdkCommunityEventLog(context.storage);
    this.objects = new SdkCommunityObjectStore(context.storage);
    this.configs = new SdkCommunityRepoConfigStore(context.storage);
    this.findings = new CommunityReconciliationFindingStore(context.storage);
    this.projector = new CommunityProjector(this.events, this.objects, this.projectionOperations);
    this.observations = new ExternalReviewCoordinator({
      repoConfigStore: this.configs, eventLog: this.events, projector: this.projector,
      objectStore: this.objects, log: this.log,
    });
    const readOpen = async (repo: string, signal?: AbortSignal) => {
      const existing = this.scanResults.get(repo);
      if (existing) return existing;
      const items = await provider.listOpen(repo, signal ?? this.lifetime.signal);
      this.scanResults.set(repo, items);
      return items;
    };
    this.scan = createRepoScanner({
      repoAllowlist: this.repos, log: this.log, eventLog: this.events, projector: this.projector,
      ...this.pollProgress('repo-scan'),
      reconciliationDedup: {
        isNotified: async (repo, kind, number) => !!await context.storage.get(stateKey('scan-notified', `${kind}:${repo}#${number}`)),
        markNotified: async (repo, kind, number) => { await context.storage.set(stateKey('scan-notified', `${kind}:${repo}#${number}`), true); },
        isBaselineEstablished: async repo => !!await context.storage.get(stateKey('scan-baseline', repo)),
        markBaselineEstablished: async repo => { await context.storage.set(stateKey('scan-baseline', repo), true); },
      },
      fetchOpenPRs: async (repo, signal) => (await readOpen(repo, signal)).filter(item => item.kind === 'pr').map(item => ({
        number: item.number, title: item.title, html_url: item.url, user: item.author, author_association: item.authorAssociation, draft: item.draft,
      })),
      fetchOpenIssues: async (repo, signal) => (await readOpen(repo, signal)).filter(item => item.kind === 'issue').map(item => ({
        number: item.number, title: item.title, html_url: item.url, user: item.author, author_association: item.authorAssociation,
      })),
      deliver: async (signal, content) => {
        const config = await this.configs.getByRepo(signal.repoFullName);
        if (!config) throw new Error('Repository registration was removed');
        await context.messaging.send(config.notificationThreadId ?? config.guardThreadId, {
          identity: 'github-notification', idempotencyKey: `github:scan:${signal.subjectType}:${signal.repoFullName}#${signal.number}`,
          wake: { catId: config.guardCatId }, url: signal.url,
          payload: { provenance: { epistemicStatus: 'observation' }, elements: [{
            elementId: signal.deliveryId, kind: 'text', payload: { text: content },
          }] },
        });
      },
    });
    this.commentPoll = createRepoCommentPoller({
      repoAllowlist: this.repos, eventLog: this.events, projector: this.projector,
      ...this.pollProgress('repo-comment-poll'),
      fetchRepoComments: (repo, since, signal) => provider.repoComments(repo, since, signal ?? this.lifetime.signal),
      readCursor: async repo => (await context.storage.get(stateKey('comment-cursor', repo)))?.value as string | undefined,
      writeCursor: async (repo, value) => { await context.storage.set(stateKey('comment-cursor', repo), value); },
      classifyComment: comment => classifyIssueComment(comment, {
        isEchoComment: createGitHubFeedbackFilter({ getSelfGitHubLogin: () => provider.selfLogin() }).shouldSkipComment,
        isNoiseComment: value => createSetupNoiseFilter(this.noiseLogins)({ ...value, commentType: 'conversation' }),
      }),
      log: this.log,
    });
  }

  private pollProgress(kind: string) {
    const key = `community.poll-progress.${kind}`;
    return {
      readProgress: async (): Promise<string | undefined> => {
        const entry = await this.context.storage.get(key);
        if (!entry) return undefined;
        if (typeof entry.value !== 'string') throw new TypeError('invalid persisted repository poll progress');
        return entry.value;
      },
      writeProgress: async (repo: string) => { await this.context.storage.set(key, repo); },
    };
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    if (this.stopping) return Promise.reject(new Error('Community plugin stopped'));
    const run = this.queue.catch(() => undefined).then(() => { this.lifetime.signal.throwIfAborted(); return operation(); });
    this.queue = run;
    return run;
  }

  register(input: UpsertRepoConfigInput): Promise<unknown> {
    return this.serialize(async () => {
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repo) || !input.guardCatId?.trim()) throw new TypeError('repo and notification cat are required');
      // Host checks destination existence and access.
      // No thread content is needed to authorize this notification destination.
      if (!await this.context.threads.get(input.guardThreadId)) throw new Error('Repository guard thread unavailable');
      await restoreLegacyRepositoryProgress(input.repo, this.context.storage, this.lifetime.signal);
      return this.configs.upsert(input);
    });
  }
  unregister(repo: string): Promise<boolean> { return this.serialize(() => this.configs.deleteByRepo(repo)); }

  importLegacyIssues(value: unknown) {
    return this.serialize(() => copyLegacyIssueObservations(legacyIssueOperationInput(value),
      new SdkCommunityIssueStore(this.context.storage), this.lifetime.signal));
  }

  importLegacyHistory(value: unknown) {
    return this.serialize(() => copyLegacyProviderHistory(legacyIssueOperationInput(value),
      this.context.storage, this.lifetime.signal));
  }

  inspectLegacyHistory(value: unknown) {
    return this.serialize(() => inspectLegacyProviderHistory(value, this.context.storage));
  }

  importLegacyRepositoryProgress(value: unknown) {
    return this.serialize(() => copyLegacyRepositoryProgress(legacyIssueOperationInput(value),
      this.context.storage, this.lifetime.signal));
  }

  inspectIssueMetadata(value: unknown) {
    return this.serialize(async () => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('issue metadata input required');
      const input = value as Record<string, unknown>;
      if (Object.keys(input).some(key => !['repo', 'number'].includes(key)) || typeof input.repo !== 'string' ||
        !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repo) || !Number.isSafeInteger(input.number) || (input.number as number) < 1) {
        throw new TypeError('invalid issue metadata subject');
      }
      return { data: { observation: await new SdkCommunityIssueStore(this.context.storage).getByRepoAndNumber(input.repo, input.number as number),
        provenance: 'installation-private-metadata' } };
    });
  }

  inspectRepository(value: unknown) {
    return this.serialize(async () => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('repository inspection input required');
      const input = value as Record<string, unknown>;
      if (Object.keys(input).some(key => !['repo', 'after', 'limit'].includes(key))) throw new TypeError('unsupported repository inspection field');
      if (typeof input.repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repo)) throw new TypeError('invalid repository');
      const repo = input.repo.toLowerCase();
      const limit = input.limit ?? 50;
      if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError('invalid pagination');
      if (input.after !== undefined && (typeof input.after !== 'string' ||
        !/^(?:pr|issue):[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9][0-9]*$/.test(input.after) ||
        !input.after.toLowerCase().replace(/^(?:pr|issue):/, '').startsWith(repo + '#'))) throw new TypeError('invalid repository cursor');
      const after = typeof input.after === 'string' ? input.after.toLowerCase() : '';
      const subjects = (await this.events.listSubjects()).filter(subject =>
        (subject.startsWith(`pr:${repo}#`) || subject.startsWith(`issue:${repo}#`)) && subject > after).sort();
      const selected = subjects.slice(0, limit);
      const items = [];
      for (const subject of selected) {
        this.lifetime.signal.throwIfAborted();
        items.push(providerObservation(subject, await this.events.read(subject), await this.objects.get(subject)));
      }
      return { data: { repo, items, nextAfter: subjects.length > limit ? selected.at(-1)! : null,
        provenance: 'installation-private-provider-observations' } };
    });
  }

  inspectSubject(value: unknown) {
    return this.serialize(async () => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('subject inspection input required');
      const input = value as Record<string, unknown>;
      if (Object.keys(input).some(key => !['subjectKey', 'fromSequence', 'limit'].includes(key))) throw new TypeError('unsupported inspection field');
      if (typeof input.subjectKey !== 'string' || !/^(?:pr|issue):[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9][0-9]*$/.test(input.subjectKey)) {
        throw new TypeError('subjectKey must identify a repository PR or issue');
      }
      const from = input.fromSequence ?? 0;
      const limit = input.limit ?? 50;
      if (typeof from !== 'number' || !Number.isSafeInteger(from) || from < 0 ||
          typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError('invalid inspection pagination');
      const subject = input.subjectKey.toLowerCase();
      const events = await this.events.read(subject, from);
      return { data: { subjectKey: subject, projection: await this.objects.get(subject),
        events: events.slice(0, limit), nextSequence: events.length > limit ? from + limit : null } };
    });
  }

  observeTracking(target: GitHubTarget, snapshot: GitHubSnapshot): Promise<void> {
    return this.serialize(async () => {
      if (target.kind !== 'pr' || !snapshot.headSha || !snapshot.ci || snapshot.state !== 'open') return;
      await this.observations.recordCi({
        repoFullName: target.repoFullName, prNumber: target.number, headSha: snapshot.headSha,
        aggregateBucket: snapshot.ci,
      }, target);
      if (snapshot.cloudObservation) await this.observations.recordCloud({
        repoFullName: target.repoFullName, prNumber: target.number, ...snapshot.cloudObservation,
      }, target);
    });
  }

  collectTracking(target: GitHubTarget, snapshot: GitHubSnapshot): Promise<void> {
    return this.serialize(async () => {
      const subjectKey = `${target.kind}:${target.repoFullName}#${target.number}`;
      const events: CommunityEvent[] = [];
      const noise = await this.context.config.get('setupNoiseBotLogins');
      if (noise !== undefined && typeof noise !== 'string') throw new TypeError('setupNoiseBotLogins must be a string');
      const classify = (comment: { author: string; body: string }) => classifyIssueComment(comment, {
        isEchoComment: createGitHubFeedbackFilter({ getSelfGitHubLogin: () => this.provider.selfLogin() }).shouldSkipComment,
        isNoiseComment: value => createSetupNoiseFilter((noise ?? '').split(/[\s,]+/).filter(Boolean))({ ...value, commentType: 'conversation' }),
      });
      const timestamp = (value?: string) => value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : Date.now();
      for (const comment of snapshot.comments) {
        const classification = classify(comment);
        const payload = target.kind === 'issue' ? {
          commentId: comment.id, authorLogin: comment.author, body: comment.body, critical: classification.critical,
          ...(classification.suppressionReason ? { suppressionReason: classification.suppressionReason } : {}),
        } : { commentId: comment.id, author: comment.author, commentType: comment.commentType };
        events.push({
          sourceEventId: target.kind === 'issue' ? issueCommentEventId(target.repoFullName, target.number, comment.id)
            : `prcomment:${target.repoFullName}#${target.number}:${comment.commentType}:${comment.id}`,
          subjectKey, kind: target.kind === 'issue' ? 'issue.commented' : 'pr.review_submitted', classification: 'informational',
          payload: { ...payload, ...(comment.actorType ? { actorType: comment.actorType } : {}),
            ...(comment.authorAssociation ? { authorAssociation: comment.authorAssociation } : {}) },
          at: timestamp(comment.createdAt),
        });
      }
      for (const review of snapshot.reviews) events.push({
        sourceEventId: reviewEventId(target.repoFullName, target.number, review.id, review.state), subjectKey, kind: 'pr.review_submitted',
        classification: 'informational', at: timestamp(review.submittedAt), payload: {
          reviewId: review.id, author: review.author, reviewState: review.state,
          ...(review.actorType ? { actorType: review.actorType } : {}), ...(review.authorAssociation ? { authorAssociation: review.authorAssociation } : {}),
        },
      });
      if (snapshot.state !== 'open') events.push({
        sourceEventId: `lifecycle:${subjectKey}:${snapshot.state}`, subjectKey, classification: 'state-changing',
        kind: target.kind === 'issue' ? 'issue.closed' : snapshot.state === 'merged' ? 'pr.merged' : 'pr.closed', payload: {}, at: Date.now(),
      });
      for (const event of events) {
        this.lifetime.signal.throwIfAborted();
        const appended = await this.events.append(event);
        if (appended.appended) await this.projector.apply(event);
        else await this.projector.rebuild(subjectKey);
      }
    });
  }

  webhook(input: unknown): Promise<{ status: number; body: unknown }> {
    return this.serialize(async () => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('webhook request required');
      const request = input as Record<string, unknown>;
      if (request.method !== 'POST') return { status: 405, body: { error: 'Method not allowed' } };
      const secret = await this.context.secrets.get('webhookSecret');
      if (!secret) return { status: 503, body: { error: 'Webhook secret is not configured' } };
      if (!(request.rawBody instanceof Uint8Array)) return { status: 400, body: { error: 'Original request bytes required' } };
      const raw = Buffer.from(request.rawBody);
      const headers: Record<string, string> = {};
      if (request.headers && typeof request.headers === 'object' && !Array.isArray(request.headers)) {
        for (const [key, value] of Object.entries(request.headers)) {
          if (typeof value === 'string') headers[key.toLowerCase()] = value;
        }
      }
      let body: unknown;
      try { body = JSON.parse(raw.toString('utf8')); }
      catch { return { status: 400, body: { error: 'Invalid JSON' } }; }
      const configs = await this.configs.listAll();
      const handler = new GitHubRepoWebhookHandler({ webhookSecret: secret, repoAllowlist: configs.map(c => c.repo) }, {
        dedup: new SdkDeliveryDedup(this.context.storage), eventLog: this.events, projector: this.projector,
        reconciliationDedup: { markNotified: async (repo, kind, number) => {
          await this.context.storage.set(stateKey('scan-notified', `${kind}:${repo}#${number}`), true);
        } },
        deliver: async (signal, content) => {
          const config = await this.configs.getByRepo(signal.repoFullName);
          if (!config) throw new Error('Repository registration was removed');
          return this.context.messaging.send(config.notificationThreadId ?? config.guardThreadId, {
            identity: 'github-notification', idempotencyKey: `github:webhook:${signal.deliveryId}`,
            wake: { catId: config.guardCatId }, url: signal.url,
            payload: { provenance: { epistemicStatus: 'observation' }, elements: [{
              elementId: signal.deliveryId, kind: 'text', payload: { text: content },
            }] },
          });
        },
      });
      const result = await handler.handleWebhook(body, headers, raw);
      return { status: result.kind === 'error' ? result.status : 200, body: result };
    });
  }

  run(kind: 'repo-scan' | 'repo-comment-poll' | 'community-reconciler'): Promise<void> {
    return this.serialize(async () => {
      const configs = await this.configs.listAll();
      if (!configs.length) return;
      this.repos.splice(0, this.repos.length, ...configs.map(c => c.repo));
      const signal = this.lifetime.signal;
      if (kind === 'repo-scan') {
        this.scanResults.clear();
        try { await this.scan(signal); } finally { this.scanResults.clear(); }
        return;
      }
      if (kind === 'repo-comment-poll') {
        const noise = await this.context.config.get('setupNoiseBotLogins');
        if (noise !== undefined && typeof noise !== 'string') throw new TypeError('setupNoiseBotLogins must be a string');
        this.noiseLogins = (noise ?? '').split(/[\s,]+/).filter(Boolean);
        await this.commentPoll(signal); return;
      }
      // Only configured repositories remain active; historical projections are retained.
      const active = new Set(this.repos);
      await runCommunityReconciliation({
        ...this.pollProgress('community-reconciler'),
        objectStore: { get: subject => this.objects.get(subject), listSubjectKeys: async () =>
          (await this.objects.listSubjectKeys()).filter(subject => active.has(subject.replace(/^(?:pr|issue):/, '').replace(/#\d+$/, ''))) },
        eventLog: this.events, projector: this.projector, findingStore: this.findings,
        fetchIssueState: (repo, number, signal) => this.provider.state(repo, 'issue', number, signal ?? this.lifetime.signal),
        fetchPrState: (repo, number, signal) => this.provider.state(repo, 'pr', number, signal ?? this.lifetime.signal),
        isBaselineEstablished: async subject => !!await this.context.storage.get(stateKey('reconciler-baseline', subject)),
        markBaselineEstablished: async subject => { await this.context.storage.set(stateKey('reconciler-baseline', subject), true); },
        log: this.log,
      }, signal);
    });
  }

  async stop(): Promise<void> {
    this.stopping = true; this.lifetime.abort(new Error('Community plugin stopped'));
    await this.queue.catch(() => undefined);
  }
}
