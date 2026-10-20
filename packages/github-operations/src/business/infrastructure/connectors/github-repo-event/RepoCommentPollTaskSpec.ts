/**
 * F168 Phase C — C0.3 RepoCommentPollTaskSpec (repo-level comment poller)
 *
 * Collection-only poller that sweeps ALL issue comments across allowlisted repos
 * (including un-routed / untracked issues), closing the per-tracked-issue blind
 * spot of IssueCommentTaskSpec — which only polls issues that already have a
 * registered `issue_tracking` task and therefore never sees comments on issues
 * the engine has not yet routed.
 *
 * Three-path convergence (webhook + per-issue poller + this repo poller):
 *   - Shared dedup key `comment:{repo}#{issueNumber}:{commentId}` (issueCommentEventId)
 *     guarantees a given comment is appended to the event log exactly once,
 *     regardless of which path observes it first.
 *   - CommunityEvent kind 'issue.commented', classification 'informational'.
 *
 * Cursor semantics (INV-9 / INV-10):
 *   - The per-repo cursor is the max comment `updatedAt` (ISO-8601 UTC) observed
 *     so far, passed back to fetchRepoComments as the `since` lower bound. ISO-8601
 *     UTC strings sort lexicographically in chronological order, so plain string
 *     comparison is a safe max.
 *   - The cursor advances on BOTH appended:true and appended:false (dedup) results,
 *     so a duplicate comment can never force an unbounded re-fetch loop (polling
 *     churn). Only a thrown fetch/append error (transient) withholds advancement,
 *     leaving the cursor below the failed comment so the next poll retries it.
 *   - PR conversation comments (surfaced by the repo-level endpoint because PRs are
 *     issues) are NOT appended/projected — they belong to the ReviewFeedbackTaskSpec
 *     track — but they DO advance the cursor, so a repo with PR activity but no new
 *     issue comments can't stall the cursor into re-fetching the same pages every tick
 *     (cloud review R4 P2 — churn).
 *   - The projector is applied ONLY on appended:true. Re-applying an already-seen
 *     event (landed earlier via the webhook / per-issue path) out of temporal order
 *     would wrongly restore awaiting_external → in_progress; projection drift is
 *     repaired via rebuild, never out-of-order replay.
 *
 * Collection-only: append + project happen inside the gate and it always returns
 * { run: false }. Delivery (owner notification) is downstream — IssueCommentRouter
 * fans out from the case projection. An un-routed issue has no owner thread, so
 * delivery is intentionally not this poller's concern.
 */
import type { CommunityEvent } from '../../../model/index.js';
import { issueSubjectKey } from '../../../model/index.js';
import type { ICommunityEventLog } from '../../../domains/community/CommunityEventLog.js';
import { issueCommentEventId } from '../../../domains/community/community-keys.js';
import {
  classifyIssueComment,
  type IssueCommentClassification,
} from '../../../domains/community/issue-analysis/issue-comment-classifier.js';
import { gitHubAdmissionCanContinue, gitHubPollBudget, readGitHubObject, type GitHubPollOptions } from '../../github/admission-budget.js';
import { GitHubRateLimitError } from '../../github/request-budget.js';

/** Duplicate journal entries repair from ordered history, never out-of-order apply. */
interface ICommunityProjectorApply {
  apply(event: CommunityEvent): Promise<void>;
  rebuild(subjectKey: string): Promise<void>;
}

/**
 * A GitHub issue comment as surfaced by the repo-level comment listing
 * (GET /repos/{repo}/issues/comments?since=...). Carries the parent issueNumber
 * so the poller can derive the subject key without a second per-issue fetch.
 */
export interface RepoIssueComment {
  issueNumber: number;
  commentId: number;
  author: string;
  authorAssociation: string;
  body: string;
  /** ISO-8601 UTC timestamp — doubles as the per-repo `since` cursor. */
  updatedAt: string;
  /**
   * True when this comment is on a pull request. The repo-level /issues/comments endpoint
   * surfaces PR conversation comments too (PRs are issues in GitHub). PR comments belong to
   * the ReviewFeedbackTaskSpec track, so they are NOT appended/projected here — but they are
   * still fetched (and advance the cursor) so PR-only activity can't stall the cursor and
   * cause an unbounded re-fetch loop (cloud review R4 P2 — churn).
   */
  isPullRequest: boolean;
}

export interface RepoCommentPollTaskSpecOptions extends GitHubPollOptions {
  readonly eventLog: ICommunityEventLog;
  readonly projector?: ICommunityProjectorApply;
  /**
   * Repo-level comment fetch. `sinceIso` is the per-repo cursor (max updatedAt
   * observed so far); implementations pass it through to the GitHub `since` query
   * parameter to bound the listing.
   */
  readonly fetchRepoComments: (repo: string, sinceIso?: string, signal?: AbortSignal) => Promise<RepoIssueComment[]>;
  readonly repoAllowlist: string[];
  /** Per-repo collection cursor read (max comment updatedAt, or undefined on first poll). */
  readonly readCursor: (repo: string) => Promise<string | undefined>;
  /** Per-repo collection cursor write. */
  readonly writeCursor: (repo: string, cursor: string) => Promise<void>;
  /** Canonical classifier shared with webhook and per-issue polling paths. */
  readonly classifyComment?: (comment: RepoIssueComment) => IssueCommentClassification;
  readonly log: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  readonly pollIntervalMs?: number;
  /** F202-2B style: override task ID for plugin-scoped schedule instances. */
  readonly id?: string;
}

/**
 * Poll a single repo's comments and append them to the event log (collection-only).
 * Extracted from the gate loop so gate() cognitive complexity stays bounded.
 * First poll (no cursor) baselines instead of backfilling — see INV-9b / cloud P1-2.
 */
async function pollSingleRepo(opts: RepoCommentPollTaskSpecOptions, repo: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const since = await opts.readCursor(repo);
  signal?.throwIfAborted();
  if (since === undefined) {
    // P1-2 (cloud review): baseline the first poll instead of backfilling. With no cursor
    // (first enable / new repo / lost cursor), fetching with no `since` would pull the
    // repo's ENTIRE historical comment set into the event log (poll storm). C0.3's blind
    // spot is NEW un-routed follow-ups, not history — baseline the cursor to now and start
    // capturing forward. (Mirrors RepoScanTaskSpec's baseline-established semantics.)
    const baselineCursor = new Date().toISOString();
    await opts.writeCursor(repo, baselineCursor);
    opts.log.info(`[repo-comment-poll] baselined ${repo} at ${baselineCursor} (skip historical backfill)`);
    return;
  }

  // P2 (cloud review): query with a 1s overlap. GitHub `since` is "after timestamp" +
  // second-granularity; a comment created in the same second as the stored cursor but
  // after the previous paginated response would be skipped forever. Re-query 1s earlier
  // and let dedup by issueCommentEventId absorb the re-fetched overlap. The cursor below
  // still stores the exact max, so it advances normally (no stuck / regression).
  const sinceWithOverlap = new Date(Date.parse(since) - 1000).toISOString();
  const comments = await opts.fetchRepoComments(repo, sinceWithOverlap, signal);
  signal?.throwIfAborted();
  let maxCursor = since;
  for (const c of comments) {
    signal?.throwIfAborted();
    // PR conversation comments are surfaced by the repo-level endpoint (PRs are issues in
    // GitHub) but belong to the ReviewFeedbackTaskSpec track — do NOT append/project them
    // here. They still advance the cursor below, so a repo with PR activity but no new issue
    // comments doesn't re-fetch the same pages every tick (cloud review R4 P2 — churn).
    if (!c.isPullRequest) {
      const commentClassification = opts.classifyComment?.(c) ?? classifyIssueComment(c);
      const event: CommunityEvent = {
        sourceEventId: issueCommentEventId(repo, c.issueNumber, c.commentId),
        subjectKey: issueSubjectKey(repo, c.issueNumber),
        kind: 'issue.commented',
        classification: 'informational',
        payload: {
          commentId: c.commentId,
          authorLogin: c.author,
          authorAssociation: c.authorAssociation,
          body: c.body,
          critical: commentClassification.critical,
          ...(commentClassification.suppressionReason
            ? { suppressionReason: commentClassification.suppressionReason }
            : {}),
        },
        at: Date.now(),
      };

      const { appended } = await opts.eventLog.append(event);
      // Project only newly appended events. A duplicate (appended:false) is already in the
      // log via another path; re-applying it out of temporal order would wrongly restore
      // awaiting_external → in_progress.
      if (appended && opts.projector) {
        await opts.projector.apply(event);
      } else if (opts.projector) {
        await opts.projector.rebuild(event.subjectKey);
      }
    }

    // Advance cursor over ALL fetched comments (issue AND PR) so neither a duplicate
    // (appended:false) nor a skipped PR comment forces an unbounded re-fetch loop. Only a
    // thrown error withholds advancement, leaving the cursor below the failed comment for retry.
    if (maxCursor === undefined || c.updatedAt > maxCursor) {
      maxCursor = c.updatedAt;
    }
  }

  signal?.throwIfAborted();
  if (maxCursor !== undefined && maxCursor !== since) {
    await opts.writeCursor(repo, maxCursor);
  }
}

/** Package-owned collector. Lifecycle cancellation comes from the plugin disposer. */
export function createRepoCommentPoller(opts: RepoCommentPollTaskSpecOptions) {
  let nextRepoIndex = 0;
  return async (signal: AbortSignal): Promise<void> => {
    const ctx = gitHubPollBudget(signal, {pollBudgetMs: 30_000, objectTimeoutMs: 30_000, ...opts});
        signal?.throwIfAborted();
        const progress = await opts.readProgress?.();
        const priorIndex = progress === undefined ? -1 : opts.repoAllowlist.indexOf(progress);
        const startIndex = (priorIndex < 0 ? nextRepoIndex : priorIndex + 1) % Math.max(1, opts.repoAllowlist.length);
        for (let step = 0; step < opts.repoAllowlist.length; step++) {
          signal?.throwIfAborted();
          if (step > 0 && !gitHubAdmissionCanContinue(ctx)) break;
          const index = (startIndex + step) % opts.repoAllowlist.length;
          const repo = opts.repoAllowlist[index]!;
          nextRepoIndex = (index + 1) % opts.repoAllowlist.length;
          try {
            await pollSingleRepo({ ...opts,
              fetchRepoComments: (repo, since) => readGitHubObject(ctx, objectSignal => opts.fetchRepoComments(repo, since, objectSignal)),
            }, repo, signal);
          } catch (e) {
            signal?.throwIfAborted();
            if (e instanceof GitHubRateLimitError) continue;
            // fail-open: one repo's fetch/append failure must not block the others.
            // The cursor is not advanced for this repo, so the next poll retries.
            opts.log.warn(`[repo-comment-poll] failed to poll ${repo}, will retry next tick`, e);
          } finally {
            await opts.writeProgress?.(repo);
          }
        }


    signal.throwIfAborted();
  };
}
