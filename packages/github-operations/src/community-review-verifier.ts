import { guardPredicateVerifier, type PluginPredicateVerifier, type PluginPredicateVerifierContext } from '@clowder-ai/plugin-sdk';
import type { PredicateFreshnessInput, PredicateCompletionInput, PredicateFreshnessResult, PredicateCompletionResult } from '@clowder-ai/plugin-contract';
import type { ICommunityObjectStore } from './business/domains/community/CommunityObjectStore.js';
import type { ICommunityRepoConfigStore } from './business/domains/community/CommunityRepoConfigStore.js';
import type { GitHubProvider } from './github-provider.js';

export const REVIEW_FRESHNESS_METHOD = 'github.review.verify-freshness';
export const REVIEW_COMPLETION_METHOD = 'github.review.verify-completion';
interface Options {
  readonly objectStore: Pick<ICommunityObjectStore, 'get'>;
  readonly repoConfigStore: Pick<ICommunityRepoConfigStore, 'getByRepo'>;
  readonly provider: Pick<GitHubProvider, 'observeReviewHead' | 'observeReviewDelivery'>;
}
type Request = PredicateFreshnessInput | PredicateCompletionInput;
type Refusal = { status: 'mismatch' | 'insufficient'; reason: string };
function refuse(reason: string, status: Refusal['status'] = 'insufficient'): Refusal { return { status, reason }; }
function subject(request: Request) {
  const match = /^pr:([a-z0-9_.-]+\/[a-z0-9_.-]+)#([1-9]\d*)$/.exec(request.subjectRef);
  if (!match || match[0] !== request.subjectRef || match[1]!.split('/').some(part => part === '.' || part === '..')) return null;
  const prNumber = Number(match[2]);
  return Number.isSafeInteger(prNumber) ? { repo: match[1]!, prNumber } : null;
}

/** Read-only business verification. Host selects/binds this private table and
 * owns lease CAS. No custody client, invocation ALS or writable store is held.
 * Current migrated state has no trusted publication association: completion
 * therefore cannot verify delivery, even when the provider object exists. */
export class CommunityReviewPredicateRuntime {
  readonly predicateVerifiers: Readonly<Record<string, PluginPredicateVerifier>>;
  private readonly lifetime = new AbortController();
  constructor(private readonly options: Options) {
    const active = () => this.lifetime.signal.throwIfAborted();
    this.predicateVerifiers = Object.freeze({
      [REVIEW_FRESHNESS_METHOD]: guardPredicateVerifier('freshness', (request, context) => this.freshness(request, context), active),
      [REVIEW_COMPLETION_METHOD]: guardPredicateVerifier('completion', (request, context) => {
        if (!('leaseId' in request)) throw new TypeError('Completion candidate required');
        return this.completion(request, context);
      }, active),
    });
  }
  stop(): void { this.lifetime.abort(); }
  private async fence(context: PluginPredicateVerifierContext): Promise<void> {
    this.lifetime.signal.throwIfAborted(); context.signal.throwIfAborted();
    await context.assertCurrent();
    this.lifetime.signal.throwIfAborted(); context.signal.throwIfAborted();
  }
  private async read(request: Request, context: PluginPredicateVerifierContext) {
    await this.fence(context);
    const target = subject(request);
    if (!target || request.predicate.freshnessKey !== `head:${request.predicate.headSha}`) return { refusal: refuse('invalid_review_subject', 'mismatch') } as const;
    const config = await this.options.repoConfigStore.getByRepo(target.repo);
    const projection = await this.options.objectStore.get(request.subjectRef);
    await this.fence(context);
    if (!config || config.repo !== target.repo || config.reviewMode !== 'maintainer_review') return { refusal: refuse('repository_not_enabled') } as const;
    if (!projection || projection.subjectKey !== request.subjectRef || projection.type !== 'pr' || projection.repo !== target.repo || projection.number !== target.prNumber) return { refusal: refuse('projection_unavailable') } as const;
    const review = projection.externalReview;
    if (!review || review.mode !== 'maintainer_review' || review.lifecycle === 'terminal') return { refusal: refuse('review_not_active') } as const;
    if (review.currentHeadSha !== request.predicate.headSha || !Number.isSafeInteger(review.headGeneration) || review.headGeneration < 1) return { refusal: refuse('private_head_mismatch', 'mismatch') } as const;
    if (!review.reviewerCatId || !review.reviewerThreadId || !context.assignment.holderCatIds.includes(review.reviewerCatId) || context.assignment.holderThreadId !== review.reviewerThreadId) return { refusal: refuse('assignment_mismatch', 'mismatch') } as const;
    if ('leaseId' in request && (context.principal.catId !== review.reviewerCatId || context.principal.threadId !== review.reviewerThreadId ||
      review.actionLeaseRef?.leaseId !== request.leaseId || review.actionLeaseRef.generation !== request.generation)) return { refusal: refuse('lease_or_caller_mismatch', 'mismatch') } as const;
    // Snapshot before any provider await; comparing rereads also catches a
    // same-SHA generation change, private assignment change and policy removal.
    return { target, review: structuredClone(review), stamp: JSON.stringify([config, projection]) } as const;
  }
  private async unchanged(request: Request, context: PluginPredicateVerifierContext, stamp: string): Promise<Refusal | null> {
    const after = await this.read(request, context);
    if (after.refusal) return after.refusal;
    return after.stamp === stamp ? null : refuse('private_state_changed', 'mismatch');
  }
  private signal(context: PluginPredicateVerifierContext): AbortSignal { return AbortSignal.any([context.signal, this.lifetime.signal]); }
  private async freshness(request: PredicateFreshnessInput, context: PluginPredicateVerifierContext): Promise<PredicateFreshnessResult> {
    const state = await this.read(request, context);
    if (state.refusal) return state.refusal;
    let head;
    try { head = await this.options.provider.observeReviewHead(state.target, this.signal(context)); }
    catch { await this.fence(context); return refuse('provider_unavailable'); }
    const changed = await this.unchanged(request, context, state.stamp);
    if (changed) return changed;
    if (!head) return refuse('provider_head_unavailable');
    if (head.state !== 'open' || head.headSha !== request.predicate.headSha) return refuse('provider_head_mismatch', 'mismatch');
    return { status: 'verified', evidenceRef: `github:${state.target.repo}#${state.target.prNumber}:head:${head.headSha}`,
      freshnessKey: request.predicate.freshnessKey, ownerCatId: state.review.reviewerCatId!, holderThreadId: state.review.reviewerThreadId! };
  }
  private async completion(request: PredicateCompletionInput, context: PluginPredicateVerifierContext): Promise<PredicateCompletionResult> {
    const state = await this.read(request, context);
    if (state.refusal) return state.refusal;
    const pending = state.review.pendingVerdict;
    if (!pending || pending.headSha !== request.predicate.headSha || pending.headGeneration !== state.review.headGeneration ||
      pending.principal.catId !== state.review.reviewerCatId || pending.principal.threadId !== state.review.reviewerThreadId ||
      pending.actionLeaseRef?.leaseId !== request.leaseId || pending.actionLeaseRef.generation !== request.generation ||
      pending.delivery.kind !== 'delivered' || pending.delivery.headSha !== request.predicate.headSha) return refuse('durable_submission_unavailable');
    if (!request.evidenceRefs.includes(`github:${pending.delivery.githubUrl}`)) return refuse('delivery_reference_mismatch', 'mismatch');
    let observation;
    try { observation = await this.options.provider.observeReviewDelivery({ ...state.target, url: pending.delivery.githubUrl }, this.signal(context)); }
    catch { await this.fence(context); return refuse('provider_unavailable'); }
    const changed = await this.unchanged(request, context, state.stamp);
    if (changed) return changed;
    if (!observation) return refuse('provider_delivery_unavailable');
    const { head, delivery } = observation;
    if (head.state !== 'open' || head.headSha !== request.predicate.headSha) return refuse('provider_head_mismatch', 'mismatch');
    if (delivery.commitSha === null) return refuse('delivery_has_no_revision_binding');
    if (delivery.commitSha !== request.predicate.headSha || (delivery.kind === 'review_comment' && delivery.originalCommitSha !== request.predicate.headSha)) return refuse('delivery_revision_mismatch', 'mismatch');
    // A matching URL/login is not an authenticated cat-to-publication binding.
    // Do not invent one from input, selfLogin, cat naming, or review body text.
    return refuse('publisher_association_unavailable');
  }
}
