import { communityNativeTargets as nativeTargets, communityNativeInput as nativeInput, type CommunityNativeMethod } from './community-native-actions.js';
export type { CommunityNativeMethod } from './community-native-actions.js';
import Fastify, { type InjectOptions, type LightMyRequestResponse } from 'fastify';
import type { PluginActionContext, PluginStorageHost, PluginThreadHost } from '@clowder-ai/plugin-sdk';
import { z } from 'zod';
import { SdkCommunityCollectionStore } from './community-collection.js';
import { CommunityRouteProvider, type CommunityRouteProviderOptions } from './community-route-provider.js';
import { NativeIssueDraftRuntime, type NativeIssuePublisher } from './native-issue-drafts.js';
import { CommunityRequestContext } from './business/routes/community-request-context.js';
import { communityIssueRoutes, type CommunityIssuesRoutesOptions } from './business/routes/community-issues.js';
import { communityRepoConfigRoutes } from './business/routes/community-repo-config.js';
import { communityIssueDraftRoutes, type CommunityIssueDraftRoutesOptions } from './business/routes/community-issue-draft-routes.js';
import { SdkCommunityWorkflowIssueStore, SdkCommunityPrStore, SdkCommunityIssueDraftStore } from './business/domains/community/CommunityWorkflowStores.js';
import { SdkCommunityRepoConfigStore } from './business/domains/community/CommunityRepoConfigStore.js';
import { SdkCommunityEventLog } from './business/domains/community/CommunityEventLog.js';
import { SdkCommunityObjectStore } from './business/domains/community/CommunityObjectStore.js';
import { CommunityProjector, type CommunityProjectionOperations } from './business/domains/community/community-projector.js';
import { CommunityReconciliationFindingStore } from './business/domains/community/reconciliation/CommunityReconciliationFindingStore.js';

type OwnedStores = 'threadStore' | 'requestContext' | 'communityIssueStore' | 'communityPrStore' | 'repoConfigStore' | 'eventLog' | 'objectStore' | 'projector' | 'findingStore';
export interface CommunityHttpRouterOptions {
  readonly storage: PluginStorageHost;
  readonly threads: Pick<PluginThreadHost, 'get' | 'ensureByKey'>;
  /** Share the active CommunityRuntime queue, never its unguarded stores. */
  readonly projectionOperations: CommunityProjectionOperations;
  readonly provider?: Pick<CommunityRouteProviderOptions, 'token' | 'execFileAsync'>;
  readonly issues: Omit<CommunityIssuesRoutesOptions, OwnedStores | 'taskStore'> & { taskStore?: CommunityIssuesRoutesOptions['taskStore'] };
  readonly drafts: Omit<CommunityIssueDraftRoutesOptions, 'requestContext' | 'communityIssueDraftStore' | 'publication'> & { publisher: NativeIssuePublisher };
}

const forwarded = z.object({
  method: z.enum(['GET', 'POST', 'PATCH', 'DELETE']), path: z.string().min(1),
  query: z.record(z.union([z.string(), z.array(z.string())])).default({}),
  body: z.unknown().optional(),
  principal: z.object({ kind: z.literal('owner'), id: z.string().min(1) }).strict(),
});

function response(value: LightMyRequestResponse) {
  const json = String(value.headers['content-type'] ?? '').includes('application/json');
  return { status: value.statusCode, headers: { 'content-type': json ? 'application/json' : 'text/plain; charset=utf-8' }, body: json && value.body ? value.json() : value.body };
}

/** Embedded package router, never a listening server. Owner dispatch is solely
 * for the Host's non-anonymous webhook forwarding contribution. It MUST NOT be
 * published as a tool/native action: its principal is the Host wrapper, whereas
 * native callers enter through the separately allowlisted method and context.
 * Dynamic Host forwarding and production module registration are independent
 * wiring requirements; constructing this router does not prove either. */
export async function createCommunityHttpRouter(options: CommunityHttpRouterOptions) {
  const app = Fastify({ maxParamLength: 512 });
  const scope = new CommunityRequestContext(app);
  const storage = scope.mutationStorage(options.storage);
  const configs = new SdkCommunityRepoConfigStore(storage);
  const reader = options.provider && new CommunityRouteProvider({ ...options.provider,
    allowed: async repo => !!await configs.getByRepo(repo), assertCurrent: () => scope.assertCurrent(),
  });
  const events = new SdkCommunityEventLog(storage);
  const objects = new SdkCommunityObjectStore(storage);
  const issues = new SdkCommunityWorkflowIssueStore(storage);
  const prs = new SdkCommunityPrStore(storage);
  const drafts = new SdkCommunityIssueDraftStore(storage);
  // Reuse the journal algorithm in a separate namespace: native draft UI
  // cancellation must not mutate a Community publication behind its workflow.
  const publication = new NativeIssueDraftRuntime({ storage, config: { get: async () => {
    await scope.assertCurrent();
    const config = typeof options.drafts.config === 'function' ? await options.drafts.config() : options.drafts.config;
    await scope.assertCurrent(); return config.repoAllowlist.join(',');
  } } }, {
    create: async (draft, signal) => { await scope.assertCurrent(); return options.drafts.publisher.create(draft, signal); },
    find: async (draft, signal) => { await scope.assertCurrent(); return options.drafts.publisher.find(draft, signal); },
  }, 'community.workflow.publication.');
  const findings = new CommunityReconciliationFindingStore(storage);
  app.addHook('preHandler', async (_request, reply) => {
    if (!scope.userId()) return reply.code(401).send({ error: 'Host-authenticated Community request required' });
    await scope.assertCurrent();
  });
  await app.register(communityIssueRoutes, {
    ...options.issues,
    ...(reader ? {
      verifyPublicIssueComment: (input: { repo: string; issueNumber: number; url: string }) => reader.verifyPublicIssueComment(input),
      fetchIssues: (repo: string) => reader.fetchIssues(repo), fetchPrs: (repo: string) => reader.fetchPrs(repo),
      fetchPrReviews: (repo: string, number: number) => reader.fetchPrReviews(repo, number),
      fetchIssueCommentCursor: (repo: string, number: number) => reader.fetchIssueCommentCursor(repo, number),
    } : {}),
    taskStore: options.issues.taskStore ?? new SdkCommunityCollectionStore(storage),
    requestContext: scope, threadStore: scope.threads(options.threads), communityIssueStore: issues, communityPrStore: prs,
    repoConfigStore: configs, eventLog: events, objectStore: objects,
    projector: new CommunityProjector(events, objects, options.projectionOperations), findingStore: findings,
  });
  await app.register(communityRepoConfigRoutes, { requestContext: scope, repoConfigStore: configs });
  await app.register(communityIssueDraftRoutes, {
    ...options.drafts, requestContext: scope, communityIssueDraftStore: drafts,
    publication: { publish: async draft => {
      const journal = await publication.create({ requestId: `community:${draft.draftId}`, repo: draft.targetRepo, title: draft.title, bodyMarkdown: draft.bodyMarkdown, labels: draft.labels });
      const result = await publication.publish({ input: { draftId: journal.data.id } });
      return result.data.issue ? { issue: result.data.issue } : {};
    } },
  });
  await app.ready();
  return {
    async forwardOwner(value: unknown) {
      const request = forwarded.parse(value);
      // Query and path are separate in the Host forwarding contract. Keep raw
      // encoded path segments intact, including an encoded repository slash.
      if (!/^github\/community-[A-Za-z0-9%_.~/-]+$/.test(request.path) || request.path.split('/').some(part => part === '.' || part === '..')) throw new TypeError('Invalid Community path');
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(request.query)) for (const item of typeof value === 'string' ? [value] : value) query.append(key, item);
      const url = '/api/' + request.path.slice('github/'.length) + (query.size ? '?' + query.toString() : '');
      return response(await scope.injectOwner(request.principal, { method: request.method, url, ...(request.body === undefined ? {} : { payload: request.body as InjectOptions['payload'] }) }));
    },
    async invokeNative(method: CommunityNativeMethod, input: unknown, caller: PluginActionContext) {
      if (!Object.hasOwn(nativeTargets, method)) throw new TypeError('Undeclared Community native action');
      const value = nativeInput.parse(input);
      const url = `/api/community-issues/${encodeURIComponent(value.id)}/${nativeTargets[method]}`;
      return response(await scope.injectNative(caller, { method: 'POST', url, payload: value.payload }));
    },
    async stop() { scope.stop(); await Promise.all([publication.stop(), reader?.stop()]); await app.close(); },
  };
}
