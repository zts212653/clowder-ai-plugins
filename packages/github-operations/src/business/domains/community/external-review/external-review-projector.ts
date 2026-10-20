import type { CommunityEvent, ExternalReviewAggregate } from '../../../model/index.js';
import {
  applyExternalReviewEvent,
  createExternalReviewAggregate,
  currentVerdictSubmissionEpoch,
  type ExternalReviewApplyResult,
} from './external-review-aggregate.js';

const EXTERNAL_REVIEW_EVENT_KINDS = new Set<CommunityEvent['kind']>([
  'case.external_review_assigned',
  'case.head_observed',
  'case.ci_observed',
  'case.cloud_review_observed',
  'case.review_ready',
  'case.reviewer_wake_delivered',
  'case.review_verdict_submitted',
  'case.review_verdict_recorded',
]);

const EXTERNAL_REVIEW_TERMINAL_EVENT_KINDS = new Set<CommunityEvent['kind']>([
  'pr.merged',
  'pr.closed',
  'case.declined',
]);

export function isExternalReviewEventKind(kind: CommunityEvent['kind']): boolean {
  return EXTERNAL_REVIEW_EVENT_KINDS.has(kind);
}

export function isExternalReviewTerminalEventKind(kind: CommunityEvent['kind']): boolean {
  return EXTERNAL_REVIEW_TERMINAL_EVENT_KINDS.has(kind);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'string';
}

function assignmentVerdictSubmissionEpoch(current: ExternalReviewAggregate, assignmentChanged: boolean): number {
  return assignmentChanged && current.pendingVerdict
    ? currentVerdictSubmissionEpoch(current) + 1
    : currentVerdictSubmissionEpoch(current);
}

export function applyExternalReviewProjectionEvent(
  current: ExternalReviewAggregate | null,
  event: CommunityEvent,
): ExternalReviewApplyResult | { readonly ok: false; readonly reason: 'aggregate_missing' | 'invalid_assignment' } {
  if (event.kind === 'case.external_review_assigned') {
    const { mode, cloudPolicy, reviewerCatId, reviewerThreadId } = event.payload;
    if (
      (mode !== 'observe_only' && mode !== 'maintainer_review') ||
      (cloudPolicy !== 'optional' && cloudPolicy !== 'required') ||
      !isOptionalString(reviewerCatId) ||
      !isOptionalString(reviewerThreadId)
    ) {
      return { ok: false, reason: 'invalid_assignment' };
    }

    const configured = createExternalReviewAggregate({
      mode,
      cloudPolicy,
      reviewerCatId: typeof reviewerCatId === 'string' ? reviewerCatId : null,
      reviewerThreadId: typeof reviewerThreadId === 'string' ? reviewerThreadId : null,
    });
    const assignmentChanged =
      current !== null &&
      (current.mode !== configured.mode ||
        current.cloudPolicy !== configured.cloudPolicy ||
        current.reviewerCatId !== configured.reviewerCatId ||
        current.reviewerThreadId !== configured.reviewerThreadId);
    return {
      ok: true,
      value: current
        ? {
            ...current,
            mode: configured.mode,
            cloudPolicy: configured.cloudPolicy,
            reviewerCatId: configured.reviewerCatId,
            reviewerThreadId: configured.reviewerThreadId,
            verdictSubmissionEpoch: assignmentVerdictSubmissionEpoch(current, assignmentChanged),
            pendingVerdict: assignmentChanged ? null : current.pendingVerdict,
          }
        : configured,
    };
  }

  if (!current) return { ok: false, reason: 'aggregate_missing' };
  return applyExternalReviewEvent(current, event);
}
