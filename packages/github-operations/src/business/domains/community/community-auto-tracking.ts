/**
 * Request-side collection registration hint after a committed case.routed.
 * The production SDK store reconciles from the latest private journal route;
 * it does not trust this event's ownership on replay. Its schedule also scans
 * committed routes, so a failed hint cannot strand durable collection intent.
 * This is provider collection only, never Host Task/native wait authority.
 */

import type { CatId, CommunityEvent } from '../../model/index.js';
import { createCatId } from '../../model/index.js';
import type { CommunityTracking as ITaskStore } from './ports/CommunityTracking.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Options for registerRoutingTracking.
 * All fields are optional to preserve backward compatibility.
 */
export interface RegisterRoutingTrackingOpts {
  /**
   * Cloud R2 P2: Optional cursor seeder — called to fetch the current latest
   * comment ID for the issue before creating the tracking task. Without this,
   * the tracking task starts with cursor=0 and the first poll re-delivers all
   * historical comments since the issue was created.
   *
   * Matches the signature used by the manual register-issue-tracking endpoint
   * (`fetchIssueCommentCursor`). Not called for pr_tracking tasks (PR pollers
   * use their own cursor seeding path).
   */
  fetchCommentCursor?: (repoFullName: string, issueNumber: number) => Promise<number>;
  /**
   * Cloud R13 P1: userId of the user who triggered the routing (i.e. the /resolve caller).
   * The issue poller delivers comments using task.userId as the invocation target; without
   * this, task.userId is undefined and delivery falls back to '' (empty string), causing
   * silent failures.
   */
  userId?: string;
}

/**
 * Register issue_tracking or pr_tracking when a case is routed.
 * Called by ingest, not by the projector. Recovery is journal-driven in the
 * SDK collection store; old hints cannot reactivate a cancelled route generation.
 *
 * @param event  The case.routed CommunityEvent (other kinds are silently ignored)
 * @param taskStore  TaskStore to register the tracking task in
 * @param opts  Optional cursor seeding and other options
 */
export async function registerRoutingTracking(
  event: CommunityEvent,
  taskStore: ITaskStore,
  opts?: RegisterRoutingTrackingOpts,
): Promise<void> {
  if (event.kind !== 'case.routed') return;

  const payload = event.payload as Record<string, unknown>;
  const threadId = typeof payload.ownerThreadId === 'string' ? payload.ownerThreadId : '';
  const catId = typeof payload.catId === 'string' ? payload.catId : '';

  // Guard: can't register a useful task without both threadId and catId
  if (!threadId || !catId) return;

  const kind = event.subjectKey.startsWith('pr:') ? 'pr_tracking' : 'issue_tracking';
  // Human-readable title: strip the type prefix for display
  const subjectDisplay = event.subjectKey.replace(/^(?:issue|pr):/, '');
  const typeLabel = kind === 'pr_tracking' ? 'PR' : 'Issue';
  const title = `${typeLabel} tracking: ${subjectDisplay}`;

  // Cloud R2 P2: seed initial comment cursor for issue_tracking to avoid
  // replaying all historical comments on the first poll (cursor=0 default).
  // PR tracking has its own cursor seeding path; skip for pr_tracking.
  let initialCommentCursor: number | undefined;
  if (kind === 'issue_tracking' && opts?.fetchCommentCursor) {
    // Parse repoFullName and issueNumber from subjectKey ("issue:owner/repo#N")
    const match = event.subjectKey.match(/^issue:(.+)#(\d+)$/);
    if (match) {
      const [, repoFullName, issueNumberStr] = match;
      try {
        initialCommentCursor = await opts.fetchCommentCursor(repoFullName, Number(issueNumberStr));
      } catch {
        // Best-effort: cursor seeding failure does not block task registration.
        // The task will start with cursor=0 on the next poll — suboptimal but functional.
      }
    }
  }

  // Cloud R14 P1: seed lastDeliveredCursor to the same value as lastCommentCursor.
  // Without this, lastDeliveredCursor stays undefined after the first poll even when
  // lastCommentCursor has already advanced (e.g. a new comment was collected but routing
  // returned non-notified). On the next poll, line:
  //   persistedDeliveryCursor = task.automationState?.issue?.lastDeliveredCursor ?? collectionCursor
  // falls back to collectionCursor (= advanced lastCommentCursor), so allPending is empty
  // and the undelivered comment is silently dropped forever.
  // Seeding both cursors at the same value ensures the fallback is never triggered for
  // auto-registered tasks — lastDeliveredCursor is defined from registration onward.
  const automationState =
    initialCommentCursor !== undefined
      ? {
          issue: {
            lastCommentCursor: initialCommentCursor,
            lastDeliveredCursor: initialCommentCursor,
          },
        }
      : undefined;

  // upsertBySubject is idempotent — returns existing task if subjectKey already has one
  const catIdBranded: CatId = createCatId(catId);
  await taskStore.upsertBySubject({
    kind,
    subjectKey: event.subjectKey,
    routeSourceEventId: event.sourceEventId,
    threadId,
    ownerCatId: catIdBranded,
    title,
    why: `Auto-registered on case.routed: ${catId} thread ${threadId}`,
    createdBy: 'system',
    // Cloud R13 P1: record the resolving userId so the poller can deliver notifications
    // to the correct user. Without this, task.userId ?? '' resolves to '' in
    // IssueCommentTaskSpec and invocation trigger calls fail silently.
    ...(opts?.userId ? { userId: opts.userId } : {}),
    ...(automationState !== undefined ? { automationState } : {}),
  });
}
