import type { GitHubSnapshot, GitHubTarget } from './tracking-runtime.js';
import type { GitHubPrWaitPredicate, TaskItem, PrAutomationState, IssueWaitAutomationState } from './business/model/index.js';
import { readGitHubWaitBaseline } from './business/domains/github-signals/GitHubWaitBaselineReader.js';
import { readGitHubIssueWaitBaseline } from './business/domains/github-signals/GitHubIssueWaitBaselineReader.js';
import { reviewVerdictsOf } from './business/domains/github-signals/GitHubReviewVerdicts.js';
import type { GitHubWaitObservation } from './business/domains/github-signals/GitHubWaitLifecycleService.js';
import { classifyGitHubReviewLoopBrake } from './business/domains/github-signals/github-wait-renderer.js';
import { classifyExternalCloudReview } from './business/domains/community/external-review/external-cloud-review-classifier.js';

const maxId = (rows: readonly { id: number }[]) => rows.reduce((max, row) => Math.max(max, row.id), 0);

export function waitTarget(task: TaskItem): GitHubTarget {
  const match = /^(pr|issue):([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9][0-9]*)$/.exec(task.subjectKey ?? '');
  if (!match || !task.ownerCatId) throw new Error('Invalid stored GitHub tracking subject');
  return { kind: match[1] as 'pr' | 'issue', repoFullName: match[2]!, number: Number(match[3]),
    catId: task.ownerCatId, threadId: task.threadId,
    reviewThreadIds: task.automationState?.await?.continuation.when.flatMap(predicate =>
      predicate.kind === 'pr_review_thread_changed' ? predicate.reviewThreadIds : []) ?? [] };
}

export async function prBaseline(snapshot: GitHubSnapshot, repo: string, number: number, when: readonly GitHubPrWaitPredicate[], now: () => number) {
  if (snapshot.commentsComplete !== true) throw new Error('Complete GitHub baseline required');
  const result = await readGitHubWaitBaseline({ repoFullName: repo, prNumber: number, when }, {
    fetchCi: async () => snapshot.headSha && snapshot.ci ? { headSha: snapshot.headSha, aggregateBucket: snapshot.ci } : null,
    fetchInlineComments: async () => snapshot.comments.filter(row => row.commentType === 'inline'),
    fetchConversationComments: async () => snapshot.comments.filter(row => row.commentType === 'conversation'),
    fetchReviews: async () => snapshot.reviews.map(row => ({ ...row, user: { login: row.author } })),
    fetchMergeState: async () => snapshot.mergeState ?? 'UNKNOWN',
    fetchReviewThreads: async () => snapshot.reviewThreads ?? [], now,
  });
  return { ...result, collectorState: { ...result.collectorState, review: {
    ...result.collectorState.review,
    lastInlineCommentCursor: maxId(snapshot.comments.filter(row => row.commentType === 'inline')),
    lastConversationCommentCursor: maxId(snapshot.comments.filter(row => row.commentType === 'conversation')),
    lastDecisionCursor: maxId(snapshot.reviews),
    observedReviews: Object.fromEntries(snapshot.reviews.map(row => [String(row.id), row.state])),
  } } };
}

/** Journal only new provider events; registration history stays a baseline. */
export function waitEventSnapshot(task: TaskItem, snapshot: GitHubSnapshot): GitHubSnapshot {
  const state = task.automationState;
  const review = (state as PrAutomationState | undefined)?.review;
  const issue = (state as IssueWaitAutomationState | undefined)?.issue;
  return { ...snapshot,
    comments: snapshot.comments.filter(row => row.id > (task.kind === 'issue_tracking' ? issue?.lastCommentCursor ?? 0 :
      row.commentType === 'inline' ? review?.lastInlineCommentCursor ?? 0 : review?.lastConversationCommentCursor ?? 0)
      && (!row.commitId || row.commitId === snapshot.headSha)),
    reviews: snapshot.reviews.filter(row =>
      (row.id > (review?.lastDecisionCursor ?? 0) ||
        (review?.observedReviews?.[String(row.id)] !== undefined && review.observedReviews[String(row.id)] !== row.state)) &&
      (!row.commitId || row.commitId === snapshot.headSha ||
        (row.state === 'DISMISSED' && review?.observedReviews?.[String(row.id)] !== undefined))),
  };
}

export function issueBaseline(snapshot: GitHubSnapshot, repo: string, number: number, now: () => number) {
  if (snapshot.commentsComplete !== true) throw new Error('Complete GitHub baseline required');
  return readGitHubIssueWaitBaseline({ repoFullName: repo, issueNumber: number }, {
    fetchCommentCursor: async () => maxId(snapshot.comments),
    fetchMetadata: async () => ({ state: snapshot.state === 'open' ? 'open' : 'closed', authorLogin: snapshot.authorLogin }), now,
  });
}

/** Adapt one complete provider read to the unchanged predicate/lifecycle algorithms. */
export function waitObservation(task: TaskItem, snapshot: GitHubSnapshot, now: number,
  cloudReviewers: readonly string[]): { observation: GitHubWaitObservation; snapshot: GitHubSnapshot } {
  if (snapshot.commentsComplete !== true) throw new Error('Complete GitHub observation required');
  const comments = snapshot.comments.filter(row => !row.commitId || row.commitId === snapshot.headSha).map(row => ({
    id: row.id, author: row.author, commentType: row.commentType, body: row.body, actorType: row.actorType,
    sourceRef: task.kind === 'issue_tracking' ? `github:issue-comment:${row.id}` : `github:pr-comment:${row.id}`,
  }));
  if (task.kind === 'issue_tracking') return { snapshot, observation: {
    taskId: task.id, at: now, facts: { issue: { state: snapshot.state === 'open' ? 'open' : 'closed', comments } },
    collectorPatch: { issue: { lastCommentCursor: maxId(snapshot.comments), issueState: snapshot.state === 'open' ? 'open' : 'closed' } },
    ...(snapshot.state !== 'open' ? { subjectState: 'closed' as const } : {}),
  } };
  if (!snapshot.headSha || !snapshot.ci) throw new Error('Current PR HEAD/CI unavailable');
  const baseline = task.automationState?.await?.baseline;
  const before = baseline && 'headSha' in baseline ? baseline.review : undefined;
  const seen = (task.automationState as PrAutomationState | undefined)?.review?.observedReviews ?? {};
  const reviews = snapshot.reviews.map(row => seen[String(row.id)] === 'DISMISSED' || before?.verdicts?.[String(row.id)]?.state === 'DISMISSED'
    ? { ...row, state: 'DISMISSED' } : row);
  const currentReviews = reviews.filter(row => row.commitId === snapshot.headSha);
  const latest = [...currentReviews].sort((a, b) => a.id - b.id).at(-1);
  const trigger = snapshot.comments.find(row => row.commentType === 'conversation' && row.id === before?.resultTriggerCommentId);
  const requestedAt = Date.parse(trigger?.createdAt ?? '');
  const completeReviews = [...Object.keys(seen), ...Object.keys(before?.verdicts ?? {})].every(id => reviews.some(row => String(row.id) === id));
  const classification = completeReviews && trigger && Number.isFinite(requestedAt) ? classifyExternalCloudReview({
    currentHeadSha: snapshot.headSha,
    request: { headSha: before!.resultTriggerHeadSha ?? '', triggerCommentId: trigger.id, requestedAt },
    commentsComplete: true, comments: snapshot.comments, reviews, knownCloudReviewerLogins: cloudReviewers,
    now, timeoutMs: 30 * 60_000,
  }) : undefined;
  const evidence = classification?.evidence;
  const newReviews = currentReviews.filter(row => row.id > (before?.decisionCursor ?? 0));
  const { cloudObservation: _ignored, ...raw } = snapshot;
  return { snapshot: { ...raw, reviews, ...(classification?.observation ? { cloudObservation: classification.observation } : {}) },
    observation: {
      taskId: task.id, at: now,
      facts: { headSha: snapshot.headSha,
        review: {
          decisionCursor: Math.max(before?.decisionCursor ?? 0, maxId(currentReviews)), headDecisionCursor: maxId(currentReviews),
          decision: evidence?.decision ?? latest?.state, reviewer: evidence?.reviewer ?? latest?.author,
          verdicts: reviewVerdictsOf(reviews), threads: snapshot.reviewThreads, comments,
          ...(evidence ? { resultTriggerCommentId: evidence.triggerCommentId, resultSourceRef: evidence.sourceRef,
            resultConversationCommentCursor: evidence.conversationCommentCursor } :
            before?.resultTriggerCommentId === undefined && latest && latest.id > (before?.decisionCursor ?? 0)
              ? { resultSourceRef: `review:${latest.id}` } : {}),
        },
        ci: { bucket: snapshot.ci, fingerprint: `${snapshot.headSha}:${snapshot.ci}`, blockerCount: snapshot.ciBlockerCount ?? 0 },
        conflict: { mergeState: snapshot.mergeState ?? 'UNKNOWN' },
      },
      collectorPatch: {
        review: { lastInlineCommentCursor: maxId(snapshot.comments.filter(row => row.commentType === 'inline')),
          lastConversationCommentCursor: maxId(snapshot.comments.filter(row => row.commentType === 'conversation')),
          lastCommentCursor: maxId(snapshot.comments), lastDecisionCursor: maxId(reviews),
          observedReviews: { ...seen, ...Object.fromEntries(reviews.map(row => [String(row.id), row.state])) } },
        ci: { headSha: snapshot.headSha, lastBucket: snapshot.ci, lastFingerprint: `${snapshot.headSha}:${snapshot.ci}` },
        conflict: { mergeState: snapshot.mergeState ?? 'UNKNOWN' },
      },
      ...(snapshot.state !== 'open' ? { subjectState: snapshot.state } : {}),
      reviewLoopBrake: classifyGitHubReviewLoopBrake(reviews, newReviews.map(row => row.id), snapshot.authorLogin),
    },
  };
}
