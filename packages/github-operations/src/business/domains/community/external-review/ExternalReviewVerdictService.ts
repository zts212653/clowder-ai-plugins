import type {
  CommunityEvent,
  ExternalReviewAggregate,
  PendingExternalReviewVerdict,
  ReviewDeliveryOutcome,
} from '../../../model/index.js';
import { prSubjectKey } from '../../../model/index.js';
import {
  decideExternalReviewReadiness,
  externalReviewVerdictAuthorizationFailure,
  isReadyForVerdict,
} from './external-review-aggregate.js';
import {
  type ExternalPendingVerdictSettlementResult,
  type ExternalReviewVerdict,
  ExternalReviewVerdictError,
  type ExternalReviewVerdictRecordInput,
  type ExternalReviewVerdictRecordResult,
  type ExternalReviewVerdictServiceOptions,
  loadCanonicalReviewDelivery,
  materializeExternalReviewDelivery,
  PENDING_VERIFICATION_REASONS,
  recordPendingExternalReviewVerdict,
  verdictFingerprint,
} from './external-review-verdict-submission.js';

export type {
  ExternalPendingVerdictSettlementResult,
  ExternalReviewDeliveryInput,
  ExternalReviewVerdict,
  ExternalReviewVerdictErrorCode,
  ExternalReviewVerdictRecordInput,
  ExternalReviewVerdictRecordResult,
  ExternalReviewVerdictServiceOptions,
} from './external-review-verdict-submission.js';
export { ExternalReviewVerdictError, isGitHubReviewDeliveryProof } from './external-review-verdict-submission.js';


export class ExternalReviewVerdictService {
  private readonly now: () => number;

  constructor(private readonly opts: ExternalReviewVerdictServiceOptions) {
    this.now = opts.now ?? Date.now;
  }

  async record(input: ExternalReviewVerdictRecordInput): Promise<ExternalReviewVerdictRecordResult> {
    const subjectKey = prSubjectKey(input.repoFullName, input.prNumber);
    const { aggregate, currentHeadSha, headGeneration, verificationReason } = await this.loadAggregate(
      input,
      subjectKey,
    );
    if (aggregate.delivery?.kind === 'delivered' && input.delivery.kind === 'pending_delivery') {
      throw new ExternalReviewVerdictError(
        'delivery_regression',
        'A delivered current-HEAD verdict cannot return to pending_delivery',
      );
    }
    const recordedAt = this.now();
    const delivery = materializeExternalReviewDelivery(input, currentHeadSha, recordedAt);
    const submissionFingerprint = verdictFingerprint(input, headGeneration);
    if (aggregate.delivery?.kind === 'delivered' && aggregate.deliveredVerdictFingerprint !== submissionFingerprint) {
      throw new ExternalReviewVerdictError('verdict_conflict',
        'A delivered verdict is immutable; only the original submission may be replayed');
    }
    if (aggregate.pendingVerdict && aggregate.pendingVerdict.fingerprint !== submissionFingerprint) {
      throw new ExternalReviewVerdictError(
        'verdict_conflict',
        'A different verdict submission already awaits canonical verification for this HEAD generation',
      );
    }
    if (verificationReason) {
      const pending = await recordPendingExternalReviewVerdict({
        eventLog: this.opts.eventLog,
        projector: this.opts.projector,
        objectStore: this.opts.objectStore,
        subjectKey,
        aggregate,
        currentHeadSha,
        headGeneration,
        submission: input,
        delivery,
        verificationReason,
        submissionFingerprint,
        recordedAt,
      });
      return pending;
    }

    return this.recordCanonicalVerdict({
      subjectKey,
      currentHeadSha,
      headGeneration,
      verdict: input.verdict,
      summary: input.summary.trim(),
      userNudgeRequired: input.userNudgeRequired === true,
      delivery,
      principal: input.principal,
      submissionFingerprint,
      recordedAt,
    });
  }

  async settlePending(subjectKey: string): Promise<ExternalPendingVerdictSettlementResult> {
    const aggregate = (await this.opts.objectStore.get(subjectKey))?.externalReview;
    const pending = aggregate?.pendingVerdict;
    if (!aggregate || !pending) return { kind: 'none' };
    if (
      pending.headSha !== aggregate.currentHeadSha ||
      pending.headGeneration !== aggregate.headGeneration ||
      aggregate.lifecycle === 'terminal'
    ) {
      return { kind: 'waiting', reason: 'stale_or_terminal_projection' };
    }
    if (
      aggregate.reviewerCatId !== pending.principal.catId ||
      aggregate.reviewerThreadId !== pending.principal.threadId
    ) {
      return { kind: 'waiting', reason: 'wrong_principal' };
    }
    if (!isReadyForVerdict(aggregate)) {
      const readiness = decideExternalReviewReadiness(aggregate);
      return { kind: 'waiting', reason: readiness.kind === 'wait' ? readiness.reason : 'head_not_ready' };
    }

    // A durable principal is provenance, never a new native invocation. The
    // installed consumer retries record() under a live Host second context.
    return { kind: 'waiting', reason: 'native_submission_required' };
  }

  private async recordCanonicalVerdict(input: {
    subjectKey: string;
    currentHeadSha: string;
    headGeneration: number;
    verdict: ExternalReviewVerdict;
    summary: string;
    userNudgeRequired: boolean;
    delivery: ReviewDeliveryOutcome;
    principal: { readonly catId: string; readonly threadId: string };
    submissionFingerprint: string;
    recordedAt: number;
  }): Promise<ExternalReviewVerdictRecordResult> {
    const {
      subjectKey,
      currentHeadSha,
      headGeneration,
      verdict,
      summary,
      userNudgeRequired,
      delivery,
      principal,
      submissionFingerprint,
      recordedAt,
    } = input;
    const event: CommunityEvent = {
      sourceEventId: `f168:review-verdict:${subjectKey}:g${headGeneration}:${submissionFingerprint}`,
      subjectKey,
      kind: 'case.review_verdict_recorded',
      classification: 'informational',
      payload: {
        headSha: currentHeadSha,
        headGeneration,
        fingerprint: submissionFingerprint,
        verdict,
        summary,
        userNudgeRequired,
        delivery,
        principal,
      },
      at: recordedAt,
    };
    const { appended } = await this.opts.eventLog.append(event);
    if (appended) {
      await this.opts.projector.apply(event);
      this.opts.recordVerdict?.();
      if (userNudgeRequired) {
        this.opts.recordUserNudgeRequired?.();
      }
    }

    const canonicalDelivery = await loadCanonicalReviewDelivery({
      objectStore: this.opts.objectStore,
      projector: this.opts.projector,
      subjectKey,
      delivery,
    });
    return {
      subjectKey,
      headSha: currentHeadSha,
      verdict,
      delivery: canonicalDelivery,
      lifecycle: canonicalDelivery.kind === 'delivered' ? 'delivered' : 'pending_delivery',
    };
  }

  private async loadAggregate(
    input: ExternalReviewVerdictRecordInput,
    subjectKey: string,
  ): Promise<{
    aggregate: ExternalReviewAggregate;
    currentHeadSha: string;
    headGeneration: number;
    verificationReason: PendingExternalReviewVerdict['verificationReason'] | null;
  }> {
    const config = await this.opts.repoConfigStore.getByRepo(input.repoFullName);
    if (!config) throw new ExternalReviewVerdictError('not_configured', 'Repository has no external-review policy');
    if (config.reviewMode !== 'maintainer_review') {
      throw new ExternalReviewVerdictError('observe_only', 'Repository policy is observe_only');
    }

    const currentHeadSha = await this.opts.fetchCurrentHead(input.repoFullName, input.prNumber);
    if (!currentHeadSha || currentHeadSha !== input.reviewedHeadSha) {
      throw new ExternalReviewVerdictError('stale_head', 'reviewedHeadSha does not match the current GitHub HEAD');
    }

    const projection = await this.opts.objectStore.get(subjectKey);
    const aggregate = projection?.externalReview;
    if (!aggregate || aggregate.currentHeadSha !== currentHeadSha) {
      throw new ExternalReviewVerdictError(
        'projection_unavailable',
        'Current external-review projection is unavailable',
      );
    }
    const authorizationFailure = externalReviewVerdictAuthorizationFailure(aggregate, input.principal);
    if (authorizationFailure) {
      throw new ExternalReviewVerdictError(authorizationFailure.code, authorizationFailure.message);
    }
    const headGeneration =
      typeof aggregate.headGeneration === 'number' && aggregate.headGeneration > 0 ? aggregate.headGeneration : 1;
    if (isReadyForVerdict(aggregate)) {
      return { aggregate, currentHeadSha, headGeneration, verificationReason: null };
    }
    const readiness = decideExternalReviewReadiness(aggregate);
    if (
      readiness.kind === 'wait' &&
      PENDING_VERIFICATION_REASONS.has(readiness.reason as PendingExternalReviewVerdict['verificationReason'])
    ) {
      return {
        aggregate,
        currentHeadSha,
        headGeneration,
        verificationReason: readiness.reason as PendingExternalReviewVerdict['verificationReason'],
      };
    }
    throw new ExternalReviewVerdictError('head_not_ready', 'Current HEAD has not reached reviewer-ready state');
  }

}
