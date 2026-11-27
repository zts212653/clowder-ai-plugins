import type { FeatureContext, PluginActionContext } from '@clowder-ai/plugin-sdk';
import { TypedWaitRuntime } from '../src/typed-wait-runtime.js';
import type { GitHubSnapshot, GitHubTrackingProvider } from '../src/tracking-runtime.js';
import { memoryStorage } from './memory-storage.js';

export function fixture() {
  let now = 1000, failure: Error | undefined, reads = 0;
  const storage = memoryStorage(), sent: unknown[] = [], logs: Array<{ message: string; fields?: unknown }> = [];
  const observed: GitHubSnapshot[] = [], collected: GitHubSnapshot[] = [];
  let snapshot: GitHubSnapshot = { state: 'open', headSha: 'a'.repeat(40), ci: 'pending', comments: [], reviews: [], commentsComplete: true,
    trackingIdentity: { selfLogin: 'maintainer', subjectAuthorLogin: 'contributor' } };
  const context = { storage, config: { get: async () => undefined }, secrets: { get: async () => undefined },
    threads: { get: async () => ({ id: 'home' }) }, messaging: { send: async (_thread: string, draft: unknown) => {
      sent.push(draft); return { messageId: 'notice', threadId: 'home' }; } }, log(_level: string, message: string, fields?: unknown) { logs.push({ message, fields }); } } as unknown as FeatureContext;
  const caller: PluginActionContext = { userId: 'owner', catId: 'codex61-sol', threadId: 'home', invocationId: 'turn', assertCurrent: async () => {} };
  const provider: GitHubTrackingProvider = { read: async () => { reads++; if (failure) throw failure; return structuredClone(snapshot); } };
  const runtime = () => new TypedWaitRuntime({ context, now: () => now, coverage: async () => ({ covered: true }), provider,
    observe: async (_target, value) => { observed.push(structuredClone(value)); },
    collect: async (_target, value) => { collected.push(structuredClone(value)); } });
  return { storage, context, caller, sent, logs, runtime, provider, observed, collected, head: (sha: string) => { snapshot = { ...snapshot, headSha: sha }; },
    update: (patch: Partial<GitHubSnapshot>) => { snapshot = { ...snapshot, ...patch }; },
    reads: () => reads, advance: () => { now += 60_001; },
    fail: (error?: Error) => { failure = error; } };
}

const reviewedHead = 'a'.repeat(40);

export async function seedReceipt(f: ReturnType<typeof fixture>, over: Record<string, unknown> = {},
  url = 'https://github.com/owner/repo/pull/1#pullrequestreview-42') {
  const { SdkCommunityObjectStore } = await import('../src/business/domains/community/CommunityObjectStore.js');
  const { SdkCommunityEventLog } = await import('../src/business/domains/community/CommunityEventLog.js');
  const projection = {
    subjectKey: 'pr:owner/repo#1',
    externalReview: {
      mode: 'maintainer_review', cloudPolicy: 'optional', lifecycle: 'delivered',
      currentHeadSha: reviewedHead, headGeneration: 1, currentHeadObservedAt: 1000,
      lastReviewedHeadSha: reviewedHead, lastReviewedHeadGeneration: 1,
      lastDeliveredHeadSha: reviewedHead, lastDeliveredHeadGeneration: 1,
      ci: null, cloud: null, wake: null,
      delivery: { kind: 'delivered', headSha: reviewedHead, githubUrl: url, deliveredAt: 1000 },
      deliveredVerdictFingerprint: 'e'.repeat(24), verdictSubmissionEpoch: 1, pendingVerdict: null,
      reviewerCatId: 'codex61-sol', reviewerThreadId: 'home', ...over,
    },
  } as import('../src/business/model/index.js').CommunityObjectProjection;
  const receipt = projection.externalReview!;
  if (receipt.deliveredVerdictFingerprint && receipt.delivery?.kind === 'delivered') {
    await new SdkCommunityEventLog(f.storage).append({
      sourceEventId: `f168:review-verdict:${projection.subjectKey}:g${receipt.headGeneration}:${receipt.deliveredVerdictFingerprint}`,
      subjectKey: projection.subjectKey, kind: 'case.review_verdict_recorded', classification: 'informational', at: 1000,
      payload: { headSha: receipt.currentHeadSha, headGeneration: receipt.headGeneration,
        fingerprint: receipt.deliveredVerdictFingerprint, delivery: receipt.delivery,
        principal: { catId: receipt.reviewerCatId, threadId: receipt.reviewerThreadId } },
    });
  }
  await new SdkCommunityObjectStore(f.storage).save(projection);
}
