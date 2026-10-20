import { z } from 'zod';
import { executeGitHubRequest, type GitHubRequestOptions } from './business/infrastructure/github/request-budget.js';

/** Provider facts only. These do not authenticate a cat, bind a lease, or prove
 * that an arbitrary comment is a current-HEAD review by its assigned reviewer. */
export interface GitHubReviewSubject { readonly repo: string; readonly prNumber: number }
export interface GitHubReviewHead extends GitHubReviewSubject {
  readonly headSha: string;
  readonly state: 'open' | 'closed' | 'merged';
}
interface DeliveryObject {
  readonly id: number;
  readonly url: string;
  readonly authorLogin: string;
  readonly body: string;
  readonly publishedAt: string;
}
export type GitHubReviewDelivery = DeliveryObject & (
  | { readonly kind: 'review'; readonly commitSha: string; readonly state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' }
  | { readonly kind: 'review_comment'; readonly commitSha: string; readonly originalCommitSha: string; readonly reviewId: number }
  | { readonly kind: 'issue_comment'; readonly commitSha: null }
);
export interface GitHubReviewDeliveryObservation {
  readonly head: GitHubReviewHead;
  readonly delivery: GitHubReviewDelivery;
}

const id = z.number().int().positive().safe();
const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).refine(value => value.length === 40 || value.length === 64);
const timestamp = z.string().refine(value => /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value)));
const user = z.object({ login: z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9\[\]-]*$/).refine(value => value === value.trim()) });
const prSchema = z.object({ number: id, html_url: z.string(), state: z.enum(['open', 'closed']), merged: z.boolean(),
  head: z.object({ sha }), base: z.object({ repo: z.object({ full_name: z.string() }) }) });
const reviewSchema = z.object({ id, html_url: z.string(), pull_request_url: z.string(), user, body: z.string(),
  state: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED']), submitted_at: timestamp, commit_id: sha });
const inlineSchema = z.object({ id, html_url: z.string(), pull_request_url: z.string(), user,
  body: z.string().refine(value => value.trim().length > 0), created_at: timestamp,
  commit_id: sha, original_commit_id: sha, pull_request_review_id: id });
const commentSchema = z.object({ id, html_url: z.string(), issue_url: z.string(), user,
  body: z.string().refine(value => value.trim().length > 0), created_at: timestamp });

function validReviewSubject(input: GitHubReviewSubject): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repo) && input.repo === input.repo.trim() &&
    input.repo.split('/').every(part => part !== '.' && part !== '..') &&
    Number.isSafeInteger(input.prNumber) && input.prNumber > 0;
}

type DeliveryAddress = { kind: GitHubReviewDelivery['kind']; id: number };
function deliveryAddress(subject: GitHubReviewSubject, text: string): DeliveryAddress | null {
  // Match the raw spelling, not URL-normalized dot segments, credentials or
  // encoded aliases. Repository/account spelling alone is case-insensitive.
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/([1-9]\d*)(?:\/files)?#(pullrequestreview-|discussion_r|issuecomment-|r)([1-9]\d*)$/.exec(text);
  if (!match || match[0] !== text || match[1]!.toLowerCase() !== subject.repo.toLowerCase() || match[2] !== String(subject.prNumber)) return null;
  const number = Number(match[4]);
  if (!Number.isSafeInteger(number)) return null;
  return { kind: match[3] === 'pullrequestreview-' ? 'review' : match[3] === 'issuecomment-' ? 'issue_comment' : 'review_comment', id: number };
}
function sameDelivery(subject: GitHubReviewSubject, text: string, expected: DeliveryAddress): boolean {
  const address = deliveryAddress(subject, text);
  return address?.kind === expected.kind && address.id === expected.id;
}
function parentUrl(subject: GitHubReviewSubject, text: string, kind: 'issues' | 'pulls'): boolean {
  return text.toLowerCase() === `https://api.github.com/repos/${subject.repo}/${kind}/${subject.prNumber}`.toLowerCase();
}
async function get(path: string, options: GitHubRequestOptions): Promise<unknown> {
  return JSON.parse((await executeGitHubRequest(['api', path, '--hostname', 'github.com'], options)).stdout);
}

export async function observeReviewHead(input: GitHubReviewSubject, options: GitHubRequestOptions): Promise<GitHubReviewHead | null> {
  if (!validReviewSubject(input)) return null;
  const parsed = prSchema.safeParse(await get(`/repos/${input.repo}/pulls/${input.prNumber}`, options));
  if (!parsed.success) return null;
  const value = parsed.data;
  if (value.number !== input.prNumber || value.base.repo.full_name.toLowerCase() !== input.repo.toLowerCase() ||
    value.html_url.toLowerCase() !== `https://github.com/${input.repo}/pull/${input.prNumber}`.toLowerCase() ||
    (value.merged && value.state !== 'closed')) return null;
  return { repo: input.repo, prNumber: input.prNumber, headSha: value.head.sha, state: value.merged ? 'merged' : value.state };
}

async function readDelivery(subject: GitHubReviewSubject, address: DeliveryAddress, options: GitHubRequestOptions): Promise<GitHubReviewDelivery | null> {
  const root = `/repos/${subject.repo}`;
  const path = address.kind === 'review' ? `${root}/pulls/${subject.prNumber}/reviews/${address.id}`
    : address.kind === 'review_comment' ? `${root}/pulls/comments/${address.id}` : `${root}/issues/comments/${address.id}`;
  const raw = await get(path, options);
  if (address.kind === 'review') {
    const parsed = reviewSchema.safeParse(raw);
    if (!parsed.success) return null;
    const value = parsed.data;
    if (value.id !== address.id || !sameDelivery(subject, value.html_url, address) || !parentUrl(subject, value.pull_request_url, 'pulls')) return null;
    return { kind: 'review', id: value.id, url: value.html_url, authorLogin: value.user.login, body: value.body,
      publishedAt: value.submitted_at, commitSha: value.commit_id, state: value.state };
  }
  if (address.kind === 'review_comment') {
    const parsed = inlineSchema.safeParse(raw);
    if (!parsed.success) return null;
    const value = parsed.data;
    if (value.id !== address.id || !sameDelivery(subject, value.html_url, address) || !parentUrl(subject, value.pull_request_url, 'pulls')) return null;
    // Own-token GETs can see pending review material: require its exact parent
    // review to have been submitted, rather than infer publication from a URL.
    const review = await readDelivery(subject, { kind: 'review', id: value.pull_request_review_id }, options);
    if (!review || review.authorLogin.toLowerCase() !== value.user.login.toLowerCase()) return null;
    return { kind: 'review_comment', id: value.id, url: value.html_url, authorLogin: value.user.login, body: value.body,
      publishedAt: review.publishedAt, commitSha: value.commit_id, originalCommitSha: value.original_commit_id,
      reviewId: value.pull_request_review_id };
  }
  const parsed = commentSchema.safeParse(raw);
  if (!parsed.success) return null;
  const value = parsed.data;
  if (value.id !== address.id || !sameDelivery(subject, value.html_url, address) || !parentUrl(subject, value.issue_url, 'issues')) return null;
  return { kind: 'issue_comment', id: value.id, url: value.html_url, authorLogin: value.user.login,
    body: value.body, publishedAt: value.created_at, commitSha: null };
}

export async function observeReviewDelivery(
  input: GitHubReviewSubject & { readonly url: string }, options: GitHubRequestOptions,
): Promise<GitHubReviewDeliveryObservation | null> {
  if (!validReviewSubject(input)) return null;
  const address = deliveryAddress(input, input.url);
  if (!address) return null;
  const subject = { repo: input.repo, prNumber: input.prNumber };
  const before = await observeReviewHead(subject, options);
  if (!before || before.state !== 'open') return null;
  const delivery = await readDelivery(subject, address, options);
  if (!delivery) return null;
  const after = await observeReviewHead(subject, options);
  if (!after || after.state !== 'open' || after.headSha !== before.headSha) return null;
  options.signal?.throwIfAborted();
  return { head: after, delivery };
}
