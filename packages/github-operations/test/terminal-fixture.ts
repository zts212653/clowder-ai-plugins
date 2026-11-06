import type { FeatureContext } from '@clowder-ai/plugin-sdk';
import { memoryStorage } from './memory-storage.js';
import { CommunityRuntime } from '../src/community-runtime.js';
import { CommunityProjector } from '../src/business/domains/community/community-projector.js';
import type { CommunityEvent, ExternalReviewAggregate } from '../src/business/model/index.js';
import type { GitHubSnapshot } from '../src/tracking-runtime.js';

export const subject = 'pr:example/project#12', head = 'b'.repeat(40), oldHead = 'a'.repeat(40);
export const target = { kind: 'pr' as const, repoFullName: 'example/project', number: 12, threadId: 'thread', catId: 'cat' };
export const time = Date.parse('2026-11-01T00:00:00Z');

export function terminalSnapshot(state: 'merged' | 'closed' = 'merged'): GitHubSnapshot {
  return {
    state, headSha: head, ci: 'pass', comments: [], commentsComplete: true, reviews: [
      { id: 10, author: 'reviewer', state: 'APPROVED', commitId: head, submittedAt: new Date(time - 1000).toISOString() },
    ],
    terminalFacts: {
      schemaVersion: 1, subjectKey: subject, state, headSha: head,
      closedAt: new Date(time).toISOString(), mergedAt: state === 'merged' ? new Date(time).toISOString() : null,
      mergeCommitSha: state === 'merged' ? 'c'.repeat(40) : null,
      reviews: [{ id: 10, author: 'reviewer', state: 'APPROVED', commitId: head, submittedAt: new Date(time - 1000).toISOString() }],
      ci: { headSha: head, status: 'pass', source: 'github-status-check-rollup', observedAt: time + 1000, checkRollup: 'present',
        checks: [{ name: 'gate', bucket: 'pass', link: 'https://github.com/example/project/actions/runs/1/job/2' }] },
      source: 'github-api', observedAt: time + 1000,
    },
  };
}

export async function terminalFixture() {
  const storage = memoryStorage(); let sends = 0;
  const context = { storage, config: { get: async () => undefined },
    secrets: { get: async (key: string) => key === 'webhookSecret' ? 'isolated-test-secret' : undefined }, log() {},
    messaging: { send: async () => { sends++; throw new Error('fact collection cannot deliver'); } } } as unknown as FeatureContext;
  const community = new CommunityRuntime(context, { selfLogin: () => 'self', listOpen: async () => [], repoComments: async () => [], state: async () => null });
  const projector = new CommunityProjector(community.events, community.objects, community.projectionOperations);
  for (const [i, [kind, payload]] of ([
    ['case.external_review_assigned', { mode: 'maintainer_review', cloudPolicy: 'optional', reviewerCatId: 'original-cat', reviewerThreadId: 'original-thread' }],
    ['case.head_observed', { headSha: oldHead }],
    ['case.ci_observed', { headSha: oldHead, status: 'pending' }],
  ] as const).entries()) {
    const event: CommunityEvent = { sourceEventId: 'seed-' + i, subjectKey: subject, kind, payload, classification: 'informational', at: i + 1 };
    await community.events.append(event); await projector.apply(event);
  }
  return { storage, community, projector, sends: () => sends };
}

/** Provider fields may advance; native review/delivery history must not. */
export function nativeHistory(review: ExternalReviewAggregate | null | undefined) {
  if (!review) return review;
  const { currentHeadSha, currentHeadObservedAt, headGeneration, ci, cloud, ...history } = review;
  return history;
}
