import { z } from 'zod';
import type { PluginActionContext, PluginCustodyHost, PluginStorageHost } from '@clowder-ai/plugin-sdk';
import type { GitHubProvider } from './github-provider.js';
import { SdkCommunityEventLog } from './business/domains/community/CommunityEventLog.js';
import { SdkCommunityObjectStore } from './business/domains/community/CommunityObjectStore.js';
import { SdkCommunityRepoConfigStore } from './business/domains/community/CommunityRepoConfigStore.js';
import { CommunityProjector, CommunityProjectionOperations } from './business/domains/community/community-projector.js';
import { ExternalReviewVerdictService } from './business/domains/community/external-review/ExternalReviewVerdictService.js';

export const REVIEW_VERDICT_METHOD = 'github.review.record-verdict';
export const reviewVerdictInput = z.object({
  repoFullName: z.string().regex(/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/).refine(repo => repo.split('/').every(part => part !== '.' && part !== '..')),
  prNumber: z.number().int().positive().safe(), reviewedHeadSha: z.string().regex(/^[a-f0-9]{40}$/),
  verdict: z.enum(['approved', 'changes_requested', 'commented']), summary: z.string().trim().min(1).max(10000),
  userNudgeRequired: z.boolean().optional(),
  delivery: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('delivered'), githubUrl: z.string().url().max(2048) }).strict(),
    z.object({ kind: z.literal('pending_delivery'), reason: z.string().trim().min(1).max(2000) }).strict(),
  ]),
  actionLeaseRef: z.object({ leaseId: z.string().min(1).max(512), generation: z.number().int().positive().safe() }).strict(),
}).strict();
interface Options {
  storage: PluginStorageHost; custody: PluginCustodyHost;
  projectionOperations: CommunityProjectionOperations;
  provider: Pick<GitHubProvider, 'observeReviewHead'>;
}

/** Only live native submissions enter here. Background schedules cannot turn a
 * stored reviewer into authority; retries use the same durable submission and
 * a newly authenticated Host invocation. Host owns all lease CAS and time. */
export class CommunityReviewVerdictRuntime {
  private readonly lifetime = new AbortController();
  private readonly submissions = new CommunityProjectionOperations();
  private readonly pending = new Set<Promise<unknown>>();
  constructor(private readonly options: Options) {}

  record(value: unknown, caller?: PluginActionContext) {
    const run = this.submit(value, caller);
    this.pending.add(run);
    void run.finally(() => this.pending.delete(run)).catch(() => {});
    return run;
  }
  private async submit(value: unknown, caller?: PluginActionContext) {
    this.lifetime.signal.throwIfAborted();
    if (!caller?.catId || !caller.threadId || !caller.userId || !caller.invocationId || typeof caller.assertCurrent !== 'function') {
      throw new Error('Host native action context required');
    }
    const { catId, threadId } = caller;
    const current = caller.assertCurrent.bind(caller);
    const input = reviewVerdictInput.parse(value);
    const subject = `pr:${input.repoFullName}#${input.prNumber}`;
    const check = async () => { this.lifetime.signal.throwIfAborted(); await current(); this.lifetime.signal.throwIfAborted(); };
    await check();
    return this.submissions.run(subject, async () => {
      await check();
      const rawConfigs = new SdkCommunityRepoConfigStore(this.options.storage);
      const initialConfig = await rawConfigs.getByRepo(input.repoFullName);
      if (initialConfig?.reviewMode !== 'maintainer_review') throw new Error('Repository review policy unavailable');
      const fence = async () => {
        await check();
        if (JSON.stringify(await rawConfigs.getByRepo(input.repoFullName)) !== JSON.stringify(initialConfig)) throw new Error('Repository policy changed during review submission');
        await check();
      };
      const source = this.options.storage;
      const storage: PluginStorageHost = {
        get: key => source.get(key), list: () => source.list(),
        set: async (key, value) => { await fence(); return source.set(key, value); },
        compareAndSet: async (key, revision, value) => { await fence(); return source.compareAndSet(key, revision, value); },
        delete: async (key, revision) => { await fence(); return source.delete(key, revision); },
      };
      const events = new SdkCommunityEventLog(storage), objects = new SdkCommunityObjectStore(storage);
      const review = (await objects.get(subject))?.externalReview;
      if (!review || review.lifecycle === 'terminal' || review.reviewerCatId !== catId || review.reviewerThreadId !== threadId) throw new Error('Native caller is not the active private reviewer');
      const expected = review.actionLeaseRef;
      if (!expected || expected.leaseId !== input.actionLeaseRef.leaseId || expected.generation !== input.actionLeaseRef.generation) throw new Error('Private review lease does not match submission');
      const custody = this.options.custody;
      const service = new ExternalReviewVerdictService({ eventLog: events, objectStore: objects, repoConfigStore: rawConfigs,
        projector: new CommunityProjector(events, objects, this.options.projectionOperations),
        fetchCurrentHead: async (repo, prNumber) => {
          await fence();
          const head = await this.options.provider.observeReviewHead({ repo, prNumber }, this.lifetime.signal);
          await fence(); return head?.state === 'open' ? head.headSha : '';
        },
        canonicalizeCompletionPredicate: async request => {
          await fence(); const result = await custody.canonicalize(request); await fence(); return result;
        },
        preflightLease: async (leaseId, generation, claimedCat, terminalPredicateDigest) => {
          if (claimedCat !== catId) throw new Error('Review principal changed');
          await fence(); const result = await custody.preflight({ leaseId, generation, terminalPredicateDigest }); await fence(); return result;
        },
        completeActionLease: async request => {
          if (request.catId !== catId) throw new Error('Review principal changed');
          await fence();
          // Deliberately reconstruct the public contract: no catId, now or verifier selection.
          const result = await custody.complete({ leaseId: request.leaseId, generation: request.generation, evidenceRefs: request.evidenceRefs });
          await fence(); return result;
        },
      });
      const result = await service.record({ ...input, principal: { catId, threadId } });
      await fence(); return { data: result };
    });
  }
  async stop(): Promise<void> { this.lifetime.abort(); await Promise.allSettled([...this.pending]); }
}
