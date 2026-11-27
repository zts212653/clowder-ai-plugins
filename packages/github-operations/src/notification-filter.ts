import type { FeatureContext, PluginStorageHost } from '@clowder-ai/plugin-sdk';
import type { ExternalReviewAggregate, GitHubWaitMatchedDelta, TaskItem } from './business/model/index.js';
import { SdkCommunityObjectStore } from './business/domains/community/CommunityObjectStore.js';
import { SdkCommunityEventLog } from './business/domains/community/CommunityEventLog.js';
import { parseGitHubReviewDeliveryProof } from './business/domains/community/external-review/external-review-verdict-submission.js';
import type { GitHubSnapshot } from './tracking-runtime.js';

interface NotificationPolicyOptions {
  readonly task?: TaskItem;
  readonly storage?: PluginStorageHost;
  readonly subjectState?: 'merged' | 'closed';
}

type NotificationLogContext = Pick<FeatureContext, 'config'> & { readonly log?: FeatureContext['log'] };

interface SelfReceipt {
  readonly aggregate: ExternalReviewAggregate;
  readonly principal: { readonly catId: string; readonly threadId: string };
}

function sourceId(sourceRef: string | undefined, prefixes: readonly string[]): string | null {
  for (const prefix of prefixes) {
    if (!sourceRef?.startsWith(prefix)) continue;
    const id = sourceRef.slice(prefix.length);
    if (/^[1-9][0-9]*$/.test(id)) return id;
  }
  return null;
}

function isExactSelfReceipt(
  match: GitHubWaitMatchedDelta,
  proof: SelfReceipt | null,
  task: TaskItem | undefined,
  snapshot: GitHubSnapshot,
): boolean {
  const active = task?.automationState?.await;
  const receipt = proof?.aggregate;
  const delivery = receipt?.delivery;
  if (!task?.subjectKey || !active || !proof || !receipt || delivery?.kind !== 'delivered' || !snapshot.headSha) return false;
  if (proof.principal.catId !== task.ownerCatId || proof.principal.threadId !== task.threadId) return false;
  // HEAD occurrences and wait renewals have independent generation counters.
  // Prove delivery freshness inside the review aggregate, including a returning SHA.
  if (!Number.isSafeInteger(receipt.headGeneration) || receipt.headGeneration < 1 ||
      receipt.lastDeliveredHeadGeneration !== receipt.headGeneration || receipt.lastDeliveredHeadSha !== snapshot.headSha ||
      receipt.currentHeadSha !== snapshot.headSha || delivery.headSha !== snapshot.headSha) return false;
  const anchor = parseGitHubReviewDeliveryProof(delivery.githubUrl);
  if (!anchor || anchor.subjectKey !== task.subjectKey) return false;
  const { surface, id } = anchor;
  if (surface === 'review') {
    if (match.kind !== 'pr_review_decision_changed' && match.kind !== 'pr_review_result_available') return false;
    const reviewId = sourceId(match.sourceRef, ['review:', 'github:pr-review:']);
    if (snapshot.reviews.some(review => String(review.id) === reviewId && review.state === 'DISMISSED')) return false;
    return reviewId === id;
  }
  const expectedKind = surface === 'conversation' ? 'pr_conversation_comment_added' : 'pr_inline_comment_added';
  if (match.kind !== expectedKind && match.kind !== 'pr_review_result_available') return false;
  const prefix = surface === 'conversation' ? 'conversation:' : 'inline:';
  // A result has no comment kind to disambiguate the provider's shared numeric ID.
  const prefixes = match.kind === 'pr_review_result_available' ? [prefix] : [prefix, 'github:pr-comment:'];
  return sourceId(match.sourceRef, prefixes) === id;
}

function hasFormalReview(task: TaskItem | undefined): boolean {
  const baseline = task?.automationState?.await?.baseline;
  if (!baseline || !('headSha' in baseline)) return false;
  if (baseline.review?.decision === 'APPROVED' || baseline.review?.decision === 'CHANGES_REQUESTED') return true;
  return Object.values(baseline.review?.verdicts ?? {}).some(review =>
    review.state === 'APPROVED' || review.state === 'CHANGES_REQUESTED');
}

function shouldCoalescePendingHeadUpdate(
  match: GitHubWaitMatchedDelta,
  allMatches: readonly GitHubWaitMatchedDelta[],
  options: NotificationPolicyOptions,
  snapshot: GitHubSnapshot,
  receipt: SelfReceipt | null,
): boolean {
  const { task, subjectState } = options;
  const awaitsCiTerminal = task?.automationState?.await?.continuation.when.some(predicate => predicate.kind === 'pr_ci_terminal') === true;
  if (match.kind !== 'pr_head_changed' || snapshot.ci !== 'pending' || snapshot.ciRollup !== 'present' ||
      !awaitsCiTerminal || subjectState || snapshot.mergeState === 'CONFLICTING' || !hasFormalReview(task)) return false;
  return !allMatches.some(other =>
    other !== match && other.kind !== 'pr_head_changed' && !isExactSelfReceipt(other, receipt, task, snapshot));
}

async function loadSelfReceipt(
  context: NotificationLogContext,
  task: TaskItem | undefined,
  storage: PluginStorageHost | undefined,
): Promise<SelfReceipt | null> {
  if (!task?.subjectKey || !storage) return null;
  try {
    const aggregate = (await new SdkCommunityObjectStore(storage).get(task.subjectKey))?.externalReview;
    const delivery = aggregate?.delivery;
    const fingerprint = aggregate?.deliveredVerdictFingerprint;
    if (!aggregate || delivery?.kind !== 'delivered' || typeof fingerprint !== 'string' || !/^[a-f0-9]{24}$/.test(fingerprint)) return null;
    const sourceEventId = `f168:review-verdict:${task.subjectKey}:g${aggregate.headGeneration}:${fingerprint}`;
    const event = await new SdkCommunityEventLog(storage).getEvent(sourceEventId);
    if (!event || event.subjectKey !== task.subjectKey || event.kind !== 'case.review_verdict_recorded') return null;
    const payload = event.payload, recorded = payload.delivery, principal = payload.principal;
    if (payload.headSha !== aggregate.currentHeadSha || payload.headGeneration !== aggregate.headGeneration ||
        payload.fingerprint !== fingerprint || !recorded || typeof recorded !== 'object' ||
        !('kind' in recorded) || recorded.kind !== 'delivered' || !('headSha' in recorded) || recorded.headSha !== delivery.headSha ||
        !('githubUrl' in recorded) || recorded.githubUrl !== delivery.githubUrl ||
        !principal || typeof principal !== 'object' || !('catId' in principal) || typeof principal.catId !== 'string' || !principal.catId ||
        !('threadId' in principal) || typeof principal.threadId !== 'string' || !principal.threadId) return null;
    return { aggregate, principal: { catId: principal.catId, threadId: principal.threadId } };
  } catch (error) {
    context.log?.('info', 'GitHub self-receipt proof unavailable; provider events remain deliverable', {
      taskId: task.id,
      errorName: error instanceof Error ? error.name : 'Error',
    });
    return null;
  }
}

/** Notification policy never filters provider collection, evidence or stored cursors. */
export async function readNotificationFilter(
  context: NotificationLogContext,
  snapshot: GitHubSnapshot,
  reviewer?: string,
  options: NotificationPolicyOptions = {},
): Promise<(match: GitHubWaitMatchedDelta, allMatches?: readonly GitHubWaitMatchedDelta[]) => boolean> {
  const read = async (key: string) => {
    const value = await context.config.get(key);
    if (value !== undefined && typeof value !== 'string') throw new TypeError('Invalid notification actor policy');
    return new Set((value ?? '').split(/[\s,]+/).filter(Boolean).map(login => login.toLowerCase()));
  };
  const allow = await read('notificationAllowlist');
  const block = await read('notificationBlocklist');
  const receipt = await loadSelfReceipt(context, options.task, options.storage);
  return (match, allMatches = [match]) => {
    if (allow.size || block.size) {
      const comment = match.kind.endsWith('comment_added') || match.kind === 'issue_author_commented';
      const review = match.kind === 'pr_review_decision_changed' || match.kind === 'pr_review_result_available';
      if (comment || review) {
        const id = Number(match.sourceRef?.split(':').at(-1));
        const fromComments = comment || /^(?:conversation:|inline:|github:(?:pr|issue)-comment:)/.test(match.sourceRef ?? '');
        const surface = match.kind === 'pr_inline_comment_added' || match.sourceRef?.startsWith('inline:') ? 'inline' : 'conversation';
        const author = fromComments
          ? snapshot.comments.find(row => row.id === id && (row.commentType ?? 'conversation') === surface)?.author ?? (review ? reviewer : undefined)
          : snapshot.reviews.find(row => row.id === id)?.author ?? reviewer;
        if (!author && allow.size) return false;
        if (author) {
          const login = author.toLowerCase();
          if (block.has(login) || (allow.size && !allow.has(login))) return false;
        }
      }
    }
    if (isExactSelfReceipt(match, receipt, options.task, snapshot)) return false;
    return !shouldCoalescePendingHeadUpdate(match, allMatches, options, snapshot, receipt);
  };
}
