import type { FeatureContext, PluginStorageHost } from '@clowder-ai/plugin-sdk';
import type { ExternalReviewAggregate, GitHubWaitMatchedDelta, TaskItem } from './business/model/index.js';
import { SdkCommunityObjectStore } from './business/domains/community/CommunityObjectStore.js';
import type { GitHubSnapshot } from './tracking-runtime.js';

interface NotificationPolicyOptions {
  readonly task?: TaskItem;
  readonly storage?: PluginStorageHost;
  readonly subjectState?: 'merged' | 'closed';
}

type NotificationLogContext = Pick<FeatureContext, 'config'> & { readonly log?: FeatureContext['log'] };

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
  receipt: ExternalReviewAggregate | null,
  task: TaskItem | undefined,
  snapshot: GitHubSnapshot,
): boolean {
  const active = task?.automationState?.await;
  const delivery = receipt?.delivery;
  if (!task?.subjectKey || !active || !receipt || delivery?.kind !== 'delivered' || !snapshot.headSha) return false;
  if (receipt.reviewerCatId !== task.ownerCatId || receipt.reviewerThreadId !== task.threadId) return false;
  if (receipt.headGeneration !== active.generation || receipt.currentHeadSha !== snapshot.headSha || delivery.headSha !== snapshot.headSha) return false;
  const anchor = /#(pullrequestreview|issuecomment|discussion_r)-?([1-9][0-9]*)$/.exec(delivery.githubUrl);
  if (!anchor) return false;
  const [, surface, id] = anchor;
  if (surface === 'pullrequestreview') {
    if (match.kind !== 'pr_review_decision_changed' && match.kind !== 'pr_review_result_available') return false;
    return sourceId(match.sourceRef, ['review:', 'github:pr-review:']) === id;
  }
  if (match.kind !== 'pr_conversation_comment_added' && match.kind !== 'pr_inline_comment_added' && match.kind !== 'pr_review_result_available') return false;
  const prefixes = surface === 'issuecomment'
    ? ['conversation:', 'github:pr-comment:']
    : ['inline:', 'github:pr-comment:'];
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
  receipt: ExternalReviewAggregate | null,
): boolean {
  const { task, subjectState } = options;
  if (match.kind !== 'pr_head_changed' || snapshot.ci !== 'pending' || subjectState ||
      snapshot.mergeState === 'CONFLICTING' || !hasFormalReview(task)) return false;
  return !allMatches.some(other =>
    other !== match && other.kind !== 'pr_head_changed' && !isExactSelfReceipt(other, receipt, task, snapshot));
}

async function loadSelfReceipt(
  context: NotificationLogContext,
  task: TaskItem | undefined,
  storage: PluginStorageHost | undefined,
): Promise<ExternalReviewAggregate | null> {
  if (!task?.subjectKey || !storage) return null;
  try {
    return (await new SdkCommunityObjectStore(storage).get(task.subjectKey))?.externalReview ?? null;
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
        const fromComments = comment || /^(?:conversation:|github:(?:pr|issue)-comment:)/.test(match.sourceRef ?? '');
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
