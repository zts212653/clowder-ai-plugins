/** GitHub observations only. Local plans, decisions and task state never live here. */
export interface IssueSourceComment {
  id: string;
  author: string;
  body: string;
  bodyHTML?: string;
  createdAt: string;
  updatedAt: string;
  lastEditedAt: string | null;
  url: string;
}
export interface IssueSourceFact {
  id?: string;
  number: number;
  title: string;
  url: string;
  state: string;
  labels: string[];
  /** Provider assignees. Undefined means not read yet; [] means unclaimed. */
  assignees?: string[];
  updatedAt: string;
  body?: string;
  bodyHTML?: string;
  author?: string;
  createdAt?: string;
  commentCount?: number;
  comments?: IssueSourceComment[];
  fetchedAt?: string;
  contentVersion?: string;
  reviewVersion?: string;
  unavailable?: boolean;
  /** Immutable source archive; independent from current list metadata. */
  detailVersion?: string;
  detailCheckedAt?: string;
}
export interface IssueSourceFailure {
  issueNumber?: number;
  kind: 'network' | 'auth' | 'rate_limit' | 'unavailable' | 'incomplete';
  message: string;
}
export interface IssueSourceSnapshot {
  repo: string;
  revision: number;
  fetchedAt: string;
  lastCheckedAt?: string;
  lastCompleteAt?: string;
  lastFullAt?: string;
  retryAt?: string;
  issues: IssueSourceFact[];
  failures: IssueSourceFailure[];
  summary: { added: number; changed: number; closed: number; reopened: number };
}
export interface IssueSourceReadResult {
  issues: IssueSourceFact[];
  failures: IssueSourceFailure[];
  complete: boolean;
  retryAt?: string;
}

function commentContent(comments: IssueSourceComment[] | undefined) {
  return comments?.map((c) => [c.id, c.author, c.body, c.createdAt, c.updatedAt, c.lastEditedAt, c.url]);
}
/** Rendered HTML contains per-request IDs (e.g. Mermaid). Markdown is the source truth. */
export function issueReviewContent(fact: IssueSourceFact) {
  return JSON.stringify([fact.title, fact.state, fact.body, commentContent(fact.comments)]);
}
export function issueSourceContent(fact: IssueSourceFact) {
  return JSON.stringify([
    fact.number,
    fact.title,
    fact.state,
    [...fact.labels].sort(),
    fact.assignees ? [...fact.assignees].sort() : undefined,
    fact.body,
    fact.author,
    fact.createdAt,
    fact.updatedAt,
    fact.commentCount,
    commentContent(fact.comments),
    fact.unavailable === true,
  ]);
}

/** List transport never carries prose, even for legacy snapshots. */
export function issueCatalogFact(fact: IssueSourceFact): IssueSourceFact {
  const { body: _body, bodyHTML: _html, comments: _comments, ...index } = fact;
  return index;
}
export interface IssueDetailResult {
  detail: IssueSourceFact | null;
  failures: IssueSourceFailure[];
  retryAt?: string;
}
