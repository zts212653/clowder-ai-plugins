import type { FeatureContext } from '@clowder-ai/plugin-sdk';
import type { GitHubWaitMatchedDelta } from './business/model/index.js';
import type { GitHubSnapshot } from './tracking-runtime.js';

/** Notification policy never filters provider collection, evidence or stored cursors. */
export async function readNotificationFilter(context: Pick<FeatureContext, 'config'>,
  snapshot: GitHubSnapshot, reviewer?: string): Promise<(match: GitHubWaitMatchedDelta) => boolean> {
  const read = async (key: string) => {
    const value = await context.config.get(key);
    if (value !== undefined && typeof value !== 'string') throw new TypeError('Invalid notification actor policy');
    return new Set((value ?? '').split(/[\s,]+/).filter(Boolean).map(login => login.toLowerCase()));
  };
  const allow = await read('notificationAllowlist');
  const block = await read('notificationBlocklist');
  return match => {
    if (!allow.size && !block.size) return true;
    const comment = match.kind.endsWith('comment_added') || match.kind === 'issue_author_commented';
    const review = match.kind === 'pr_review_decision_changed' || match.kind === 'pr_review_result_available';
    if (!comment && !review) return true; // HEAD, CI, merge/conflict and thread-state facts have no actor filter.
    const id = Number(match.sourceRef?.split(':').at(-1));
    const fromComments = comment || /^(?:conversation:|github:(?:pr|issue)-comment:)/.test(match.sourceRef ?? '');
    const surface = match.kind === 'pr_inline_comment_added' || match.sourceRef?.startsWith('inline:') ? 'inline' : 'conversation';
    const author = fromComments
      ? snapshot.comments.find(row => row.id === id && (row.commentType ?? 'conversation') === surface)?.author ?? (review ? reviewer : undefined)
      : snapshot.reviews.find(row => row.id === id)?.author ?? reviewer;
    if (!author) return !allow.size;
    const login = author.toLowerCase();
    return !block.has(login) && (!allow.size || allow.has(login));
  };
}
