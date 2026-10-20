import type { GitHubComment as PrFeedbackComment, GitHubReview as PrReviewDecision } from '../../../../tracking-runtime.js';
import type { ExternalCloudObservation } from './ExternalReviewCoordinator.js';

/** Provider correlation only. This does not request a review or establish authority. */
export interface CloudReviewRequest {
  readonly headSha: string;
  readonly triggerCommentId: number;
  readonly requestedAt: number;
}

export interface ExternalCloudReviewClassifierInput {
  readonly currentHeadSha: string;
  readonly request?: CloudReviewRequest;
  readonly commentsComplete: boolean;
  readonly comments: readonly PrFeedbackComment[];
  readonly reviews: readonly PrReviewDecision[];
  readonly knownCloudReviewerLogins: readonly string[];
  readonly now: number;
  readonly timeoutMs: number;
}

export interface ExternalCloudReviewClassification {
  readonly observation: Omit<ExternalCloudObservation, 'repoFullName' | 'prNumber'> | null;
  readonly correlatedCommentIds: readonly number[];
  readonly correlatedReviewIds: readonly number[];
  readonly evidence?: ExternalCloudReviewEvidence;
}

export interface ExternalCloudReviewEvidence {
  readonly triggerCommentId: number;
  readonly sourceRef: `review:${number}` | `conversation:${number}`;
  readonly decisionCursor?: number;
  readonly conversationCommentCursor?: number;
  readonly reviewer: string;
  readonly decision: string;
}

function normalizeLogin(login: string): string {
  return login.trim().toLowerCase();
}

function emptyClassification(): ExternalCloudReviewClassification {
  return { observation: null, correlatedCommentIds: [], correlatedReviewIds: [] };
}

function reviewedCommitFromCanonicalCleanComment(body: string): string | null {
  const firstLine = body.trimStart().split(/\r?\n/, 1)[0]?.trim() ?? '';
  if (!/^Codex Review:\s*Didn't find any major issues\.(?:[^\r\n]*)$/i.test(firstLine)) return null;
  const matches = [...body.matchAll(/^\*\*Reviewed commit:\*\*\s*`([0-9a-f]{7,40})`\s*$/gim)];
  return matches.length === 1 ? (matches[0]?.[1] ?? null) : null;
}

function findCanonicalCleanConversation(input: {
  readonly comments: readonly PrFeedbackComment[];
  readonly currentHeadSha: string;
  readonly triggerCommentId: number;
  readonly conversationBaseline: number;
  readonly isKnownCloudReviewer: (login: string) => boolean;
}): PrFeedbackComment | undefined {
  return [...input.comments]
    .filter(
      (comment) =>
        comment.commentType === 'conversation' &&
        comment.id > input.triggerCommentId &&
        comment.id > input.conversationBaseline &&
        input.isKnownCloudReviewer(comment.author),
    )
    .sort((left, right) => right.id - left.id)
    .find((comment) => {
      const reviewedCommit = reviewedCommitFromCanonicalCleanComment(comment.body);
      return reviewedCommit !== null && input.currentHeadSha.toLowerCase().startsWith(reviewedCommit.toLowerCase());
    });
}

function classifyCurrentHeadReview(input: {
  readonly comments: readonly PrFeedbackComment[];
  readonly reviews: readonly PrReviewDecision[];
  readonly currentHeadSha: string;
  readonly triggerCommentId: number;
  readonly requestedAt: number;
  readonly isKnownCloudReviewer: (login: string) => boolean;
}): ExternalCloudReviewClassification | null {
  const decision = [...input.reviews]
    .filter((review) => review.commitId === input.currentHeadSha && input.isKnownCloudReviewer(review.author) &&
      ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED', 'COMMENTED'].includes(review.state) &&
      Date.parse(review.submittedAt ?? '') >= input.requestedAt)
    .sort((left, right) => right.id - left.id)[0];
  if (!decision) return null;
  const findings = input.comments.filter(
    (comment) =>
      comment.commentType === 'inline' &&
      comment.commitId === input.currentHeadSha &&
      comment.reviewId === decision.id &&
      input.isKnownCloudReviewer(comment.author),
  );
  const status =
    decision.state === 'DISMISSED'
      ? 'failed_or_timeout'
      : decision.state === 'CHANGES_REQUESTED' || findings.length > 0
        ? 'blocking'
        : 'clean';
  return {
    observation: {
      headSha: input.currentHeadSha,
      status,
      triggerCommentId: input.triggerCommentId,
      reviewId: decision.id,
    },
    correlatedCommentIds: findings.map((comment) => comment.id),
    correlatedReviewIds: [decision.id],
    evidence: {
      triggerCommentId: input.triggerCommentId,
      sourceRef: `review:${decision.id}`,
      decisionCursor: decision.id,
      reviewer: decision.author,
      decision: decision.state,
    },
  };
}

export function classifyExternalCloudReview(
  input: ExternalCloudReviewClassifierInput,
): ExternalCloudReviewClassification {
  const { request } = input;
  if (!request || !input.commentsComplete || request.headSha !== input.currentHeadSha) return emptyClassification();
  const { triggerCommentId } = request;
  // Do not accept a supplied timestamp as proof that an older review answers this request.
  // It must match a real provider conversation observation in the complete snapshot.
  if (!input.comments.some(comment => comment.commentType === 'conversation' && comment.id === triggerCommentId &&
    Date.parse(comment.createdAt ?? '') === request.requestedAt)) {
    return emptyClassification();
  }

  const knownLogins = new Set(input.knownCloudReviewerLogins.map(normalizeLogin));
  const isKnownCloudReviewer = (login: string) => knownLogins.has(normalizeLogin(login));
  const reviewClassification = classifyCurrentHeadReview({
    comments: input.comments,
    reviews: input.reviews,
    currentHeadSha: input.currentHeadSha,
    triggerCommentId,
    requestedAt: request.requestedAt,
    isKnownCloudReviewer,
  });
  if (reviewClassification) return reviewClassification;

  const conversationBaseline = triggerCommentId;
  const cleanConversation = findCanonicalCleanConversation({
    comments: input.comments,
    currentHeadSha: input.currentHeadSha,
    triggerCommentId,
    conversationBaseline,
    isKnownCloudReviewer,
  });
  if (cleanConversation) {
    return {
      observation: {
        headSha: input.currentHeadSha,
        status: 'clean',
        triggerCommentId,
      },
      correlatedCommentIds: [cleanConversation.id],
      correlatedReviewIds: [],
      evidence: {
        triggerCommentId,
        sourceRef: `conversation:${cleanConversation.id}`,
        conversationCommentCursor: cleanConversation.id,
        reviewer: cleanConversation.author,
        decision: 'CLEAN',
      },
    };
  }

  const timedOut = input.now - request.requestedAt >= input.timeoutMs;
  return {
    observation: {
      headSha: input.currentHeadSha,
      status: timedOut ? 'failed_or_timeout' : 'running',
      triggerCommentId,
    },
    correlatedCommentIds: [],
    correlatedReviewIds: [],
  };
}
