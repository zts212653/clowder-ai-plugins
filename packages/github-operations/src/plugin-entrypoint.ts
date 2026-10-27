import { MigratedIssueRuntime } from './migrated-issue-runtime.js';
import { GitHubMigrationRuntime } from './migration-runtime.js';
import { migrationActions } from './migration-http.js';
import { z } from 'zod';
import { CommunityReviewVerdictRuntime, REVIEW_VERDICT_METHOD } from './community-review-verdict.js';
import { CommunityNarratorRuntime } from './community-narrator.js';
import { communityNativeMethods } from './community-native-actions.js';
import { createCommunityHttpRouter } from './community-http-router.js';
import { definePlugin, definePluginModule, type FeatureContext, type PluginModuleEntrypoint, type PluginActionContext } from '@clowder-ai/plugin-sdk';
import { GitHubProvider } from './github-provider.js';
import type { GitHubTrackingProvider } from './tracking-runtime.js';
import { TypedWaitRuntime } from './typed-wait-runtime.js';
import { CommunityRuntime, type CommunityProvider } from './community-runtime.js';
import type { UpsertRepoConfigInput } from './business/domains/community/CommunityRepoConfigStore.js';
import { recommendTriage } from './triage-recommendation.js';
import { previewPublicIssue } from './community-read-model.js';
import { NativeIssueDraftRuntime, type NativeIssuePublisher } from './native-issue-drafts.js';
import { PrProviderIndex, type PrIndexProvider } from './pr-provider-index.js';
import { GitHubPrIndexProvider } from './pr-index-provider.js';
import { ReviewTriggerReader } from './review-trigger-observation.js';
import { CommunityCollectionRuntime, SdkCommunityCollectionStore } from './community-collection.js';
import { GitHubPrTitleReader, prTitleHttp } from './pr-title-reader.js';
import { GitHubAssignmentInbox, type AssignmentProvider } from './assignment-inbox.js';
import { GitHubAssignmentProvider } from './assignment-provider.js';
import { createGitHubSettings } from './settings.js';
import { findThreadMetadata } from './metadata-thread.js';
import type { GitHubRequestOptions } from './business/infrastructure/github/request-budget.js';

// Host declared webhook dispatch nests the request under action params. The
// webhook handlers declare no static params; flat requests are invalid.
const webhookEnvelope = z.object({ request: z.record(z.unknown()) }).strict();

interface Provider extends GitHubTrackingProvider { selfLogin(): string | undefined }
export interface GitHubPluginOptions {
  readonly settingsExecFileAsync?: GitHubRequestOptions['execFileAsync'];
  readonly now?: () => number;
  readonly createReviewEvidenceProvider?: (context: FeatureContext) => Pick<GitHubProvider, 'observeReviewHead' | 'observeReviewDelivery'>;
  /** Test the real carrier with an isolated provider; production uses the migrated gh transport. */
  readonly createProvider?: (context: FeatureContext) => Provider;
  readonly createCommunityProvider?: (context: FeatureContext) => CommunityProvider;
  readonly createIssuePublisher?: (context: FeatureContext) => NativeIssuePublisher;
  readonly createPrIndexProvider?: (context: FeatureContext) => PrIndexProvider;
  readonly createReviewTriggerReader?: (context: FeatureContext) => ReviewTriggerReader;
  readonly createPrTitleReader?: (context: FeatureContext) => GitHubPrTitleReader;
  readonly createAssignmentProvider?: (context: FeatureContext) => AssignmentProvider;
}

async function activate(context: FeatureContext, options: GitHubPluginOptions) {
  // Host get() currently requires content access even for summaries. Package-owned
  // Community mappings need only an owner-visible metadata lookup.
  const threads = context.threads;
  context = { ...context, threads: { ...threads, get: id => findThreadMetadata(threads, id) } };
  const connectionSettings = createGitHubSettings(context, options.settingsExecFileAsync);
  const migration = new GitHubMigrationRuntime(context, options.now);
  const transport = new GitHubProvider({
    token: () => context.secrets.get('token'),
    log: { warn: (message, fields) => context.log('warn', message, fields) },
  });
  const provider = options.createProvider?.(context) ?? transport;
  const assignments = new GitHubAssignmentInbox(context, options.createAssignmentProvider?.(context) ??
    new GitHubAssignmentProvider({ token: () => context.secrets.get('token') }));
  const prTitles = options.createPrTitleReader?.(context) ?? new GitHubPrTitleReader({ token: () => context.secrets.get('token') });
  const reviewTriggers = options.createReviewTriggerReader?.(context) ?? new ReviewTriggerReader({
    token: () => context.secrets.get('token'),
  });
  const prIndex = new PrProviderIndex(context.storage, options.createPrIndexProvider?.(context) ?? new GitHubPrIndexProvider({ token: () => context.secrets.get('token') }));
  const publisher = options.createIssuePublisher?.(context) ?? transport;
  const drafts = new NativeIssueDraftRuntime(context, publisher);
  const community = new CommunityRuntime(context, options.createCommunityProvider?.(context) ?? transport);
  const narrator = new CommunityNarratorRuntime(context);
  const reviewEvidence = options.createReviewEvidenceProvider?.(context) ?? transport;
  const reviewVerdicts = new CommunityReviewVerdictRuntime({ storage: context.storage, provider: reviewEvidence, projectionOperations: community.projectionOperations });
  const collection = new CommunityCollectionRuntime({ store: new SdkCommunityCollectionStore(context.storage), provider,
    allowed: async repo => !!await community.configs.getByRepo(repo),
    collect: (target, snapshot) => community.collectTracking(target, snapshot),
    observe: (target, snapshot) => community.observeTracking(target, snapshot),
  });
  const tracking = new TypedWaitRuntime({
    context, provider,
    ...(options.now ? { now: options.now } : {}),
    coverage: (repoFullName, prNumber, triggerCommentId) => reviewTriggers.observe({ repoFullName, prNumber, triggerCommentId }),
    collect: (target, snapshot) => community.collectTracking(target, snapshot),
    observe: (target, snapshot) => community.observeTracking(target, snapshot),
  });
  const migratedIssues = new MigratedIssueRuntime(context, provider, () => provider.selfLogin(), options.now);
  if (!await migration.held()) await tracking.recover();
  const http = await createCommunityHttpRouter({
    storage: context.storage, threads: context.threads, projectionOperations: community.projectionOperations,
    provider: { token: () => context.secrets.get('token') },
    issues: { narrator },
    drafts: { publisher, config: async () => {
      const value = await context.config.get('publishRepositories');
      if (value !== undefined && typeof value !== 'string') throw new TypeError('Invalid publish repository configuration');
      const repos = [...new Set((value ?? '').split(/[\s,]+/).filter(Boolean).map(repo => repo.toLowerCase()))];
      if (repos.some(repo => !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))) throw new TypeError('Invalid publish repository configuration');
      return { defaultRepo: repos[0] ?? '', repoAllowlist: repos };
    } },
  });
  const poll = async (kind: 'pr' | 'issue') => {
    // Admit both module-owned streams before awaiting either: shutdown must
    // never resume a completed native tick into a newly started collector.
    await Promise.all([tracking.poll(kind), collection.poll(kind), ...(kind === 'issue' ? [migratedIssues.poll()] : [])]);
    return { data: { completed: true } };
  };
  return {
    actions: migration.guard({
      ...migrationActions(context, migration, () => tracking.recover()),
      ...connectionSettings.actions,
      'github.pr-title.http': prTitleHttp(prTitles),
      [REVIEW_VERDICT_METHOD]: (input: unknown, caller?: PluginActionContext) => reviewVerdicts.record(input, caller),
      ...Object.fromEntries(communityNativeMethods.map(method => [method, (input: unknown, caller?: PluginActionContext) => {
        if (!caller) throw new Error('Host native action context required');
        return http.invokeNative(method, input, caller);
      }])),
      // Only the owner-authenticated Host HTTP forwarder may call this method.
      // It is deliberately absent from tools, MCP actions and operations.
      'github.community.http': (value: unknown, caller?: PluginActionContext) => {
        if (caller) throw new Error('Community owner HTTP cannot be invoked as a native action');
        return http.forwardOwner(webhookEnvelope.parse(value).request);
      },
      // Pure provider observation; registration consumes it inside this module.
      'github.review-trigger.observe': (value: unknown) => reviewTriggers.observe(value),
      'github.webhook': (value: unknown) => community.webhook(webhookEnvelope.parse(value).request),
      'github.typed-wait.register-pr': (value: unknown, caller?: PluginActionContext) => tracking.registerPr(value, caller),
      'github.typed-wait.register-issue': (value: unknown, caller?: PluginActionContext) => tracking.registerIssue(value, caller),
      'github.typed-wait.unregister': (value: unknown, caller?: PluginActionContext) => tracking.unregister(value, caller),
      'github.tracking.list': async () => ({ data: { tracking: [
        ...await tracking.store.listByKind('pr_tracking'), ...await tracking.store.listByKind('issue_tracking'), ...await migratedIssues.list(),
      ], diagnostics: await tracking.diagnostics() } }),
      'github.pr-tracking': () => poll('pr'),
      'github.issue-tracking': () => poll('issue'),
      'github.assignment-poll': async () => ({ render: 'status', data: await assignments.poll() }),
      'github.assignment-status': async () => ({ render: 'status', data: await assignments.status() }),
      'github.repo-scan': async () => { await community.run('repo-scan'); return { data: { completed: true } }; },
      'github.repo-comment-poll': async () => { await community.run('repo-comment-poll'); return { data: { completed: true } }; },
      'github.community-reconciler': async () => { await community.run('community-reconciler'); const narratorDeliveries = await narrator.reconcile(); return { data: { completed: true, narratorDeliveries } }; },
      'github.repository.register': async (value: unknown) => ({ data: await community.register(repoInput(value, true) as unknown as UpsertRepoConfigInput) }),
      'github.repository.unregister': async (value: unknown) => ({ data: { removed: await community.unregister(repoInput(value, false).repo as string) } }),
      'github.repository.list': async () => ({ data: { repositories: await community.configs.listAll(), pullRequestRepositories: await prIndex.repositories() } }),
      'github.subject.inspect': (value: unknown) => community.inspectSubject(value),
      'github.pull-requests.refresh': async (value: unknown) => ({ data: await prIndex.refresh(value) }),
      'github.repository.observations': async (value: unknown) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('repository input required');
        const { prAfter, ...input } = value as Record<string, unknown>;
        const result = await community.inspectRepository(input);
        return { data: { ...result.data, pullRequests: await prIndex.read(input.repo, prAfter, input.limit) } };
      },
      'github.issue.preview': previewPublicIssue,
      'github.issue.metadata': (value: unknown) => community.inspectIssueMetadata(value),
      'github.legacy-history.inspect': (value: unknown) => community.inspectLegacyHistory(value),
      'github.draft.create': (value: unknown) => drafts.create(value),
      'github.draft.get': (value: unknown) => drafts.get(value),
      'github.triage.recommend': recommendTriage,
    }),
    dispose: async () => { await Promise.all([assignments.stop(), connectionSettings.dispose(), migration.stop(), migratedIssues.stop(), prTitles.stop(), reviewVerdicts.stop(), narrator.stop(), http.stop(), collection.stop(), tracking.stop(), community.stop(), drafts.stop(), reviewTriggers.stop(), prIndex.stop()]); },
  };
}

function repoInput(value: unknown, register: boolean): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('repository input must be an object');
  const input = value as Record<string, unknown>;
  const allowed = register ? ['repo', 'guardThreadId', 'guardCatId', 'reviewMode', 'cloudReviewPolicy'] : ['repo'];
  if (Object.keys(input).some(key => !allowed.includes(key)) || typeof input.repo !== 'string') throw new TypeError('unsupported repository field');
  if (register && (typeof input.guardThreadId !== 'string' || typeof input.guardCatId !== 'string')) throw new TypeError('repository notification destination is required');
  if (input.reviewMode !== undefined && !['observe_only', 'maintainer_review'].includes(input.reviewMode as string)) throw new TypeError('invalid reviewMode');
  if (input.cloudReviewPolicy !== undefined && !['optional', 'required'].includes(input.cloudReviewPolicy as string)) throw new TypeError('invalid cloudReviewPolicy');
  return input;
}

export function createGitHubPluginModule(options: GitHubPluginOptions = {}): PluginModuleEntrypoint {
  const runtimeModule = definePluginModule(manifest => definePlugin({
    manifest, activate: { 'github-collaboration': context => activate(context, options) },
  }));
  return { create: manifest => ({ ...runtimeModule.create(manifest),
    settings: host => createGitHubSettings(host, options.settingsExecFileAsync),
  }) };
}

export default createGitHubPluginModule();
