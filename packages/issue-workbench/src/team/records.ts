import type { SharedReceipt, TeamAnalysis, TeamIssue } from './types.js';
import type { AssignmentOptions } from './group.js';

export interface TeamFeedback {
  verdict: 'accepted' | 'corrected' | 'rejected';
  reason: string;
  recordedAt: number;
  catId?: string;
  invocationId?: string;
  ownerMessageId?: string;
  ownerUserId?: string;
  ownerOperationId?: string;
}
export interface Job {
  kind: 'analysis';
  classificationQueueId?: string;
  id: string;
  issue: TeamIssue;
  sourceVersion: string;
  features: string[];
  threadId: string;
  catId: string;
  targetSelection?: 'owner';
  sourceMessageId?: string;
  requester: string;
  requesterKind?: 'cat' | 'owner' | 'policy';
  ownerUserId?: string;
  ownerOperationId?: string;
  createdAt?: number;
  status: 'pending' | 'delivered' | 'analyzed';
  messageId?: string;
  error?: string;
  analysis?: TeamAnalysis;
  provenance?: { catId: string; invocationId: string; sourceMessageId: string; recordedAt: number };
  assignment?: { status: 'pending' | 'assigned' | 'invited' | 'needs-decision'; delivery?: 'invitation' | 'assignment'; login?: string; reason?: string; commentAttempted?: boolean; commentId?: string; rulesHash?: string;
    basis?: 'reporter' | 'feature' | 'category' | 'manual'; groupName?: string; acceptanceSuggestedFor?: string };
  feedback?: TeamFeedback;
  feedbackHistory?: TeamFeedback[];
}
export interface Inbox {
  kind: 'inbox'; id: string; issue: TeamIssue; assignmentId: string; login: string;
  delivery?: 'invitation';
  receivedAt: number;
  threadId: string; catId: string; score: number | null; reason: string;
  status: 'pending' | 'delivered' | 'inactive'; messageId?: string; error?: string;
  dispatchId?: string;
  deliveryEpoch?: number;
  /** Owner's local acceptance is separate from Host Task admission and execution. */
  ownerAcceptance?: { userId: string; operationId: string; recordedAt: number; deliveryEpoch: number };
  ownerAcceptanceHistory?: NonNullable<Inbox['ownerAcceptance']>[];
  receipt?: { value: SharedReceipt; commentAttempted?: boolean; commentId?: string };
  withdrawal?: { status: 'pending' | 'delivered'; messageId?: string; error?: string };
  withdrawalHistory?: NonNullable<Inbox['withdrawal']>[];
}
/** A direct owner assignment is not a cat analysis and has no cat provenance. */
export interface OwnerAssignment extends Pick<Job, 'id' | 'issue' | 'sourceVersion' | 'features' | 'assignment' | 'createdAt'> {
  kind: 'assignment'; ownerUserId?: string; ownerOperationId?: string;
  requestedLogin?: string;
  automatic?: boolean;
  category?: string;
  analysis?: never;
}
export type DispatchRecord = Job | OwnerAssignment;
export type TeamRecord = DispatchRecord | Inbox;
export interface TeamClassification {
  id: string; issue: TeamIssue; analysis: TeamAnalysis; catId: string; recordedAt: number; bodySha256: string;
  /** Fresh provider stamp, only supplied after the analyzed content is revalidated. */
  verifiedUpdatedAt?: string;
}
export type TeamRecordDetail = TeamRecord & {
  revision: number; currentIssue: TeamIssue; sourceStale: boolean; sharedReceipts: SharedReceipt[];
  assignmentOptions: AssignmentOptions;
  receiver?: { current: boolean; accepted: boolean; threadUrl?: string; requestText: string };
};
export function statistics(rows: TeamRecord[]) {
  const jobs = rows.filter((row): row is Job => row.kind === 'analysis' && !!row.analysis);
  const reviews = jobs.filter(job => job.feedback), accepted = reviews.filter(job => job.feedback!.verdict === 'accepted').length;
  const distribution: Record<string, number> = {};
  const scores: Record<string, number> = {}, assignments: Record<string, number> = {}, invitations: Record<string, number> = {};
  for (const job of jobs) {
    const key = job.features.length ? '随 Feature 处理' : job.analysis!.category;
    distribution[key] = (distribution[key] ?? 0) + 1;
    const score = job.analysis!.score === null ? '未评分' : String(job.analysis!.score);
    scores[score] = (scores[score] ?? 0) + 1;
  }
  for (const row of rows) {
    if (row.kind !== 'inbox' && row.assignment?.status === 'invited' && row.assignment.login) {
      invitations[row.assignment.login] = (invitations[row.assignment.login] ?? 0) + 1;
    }
    if (row.kind !== 'inbox' && row.assignment?.status === 'assigned' && row.assignment.login) {
      assignments[row.assignment.login] = (assignments[row.assignment.login] ?? 0) + 1;
    }
  }
  return { analyzed: jobs.length, uniqueIssues: new Set(jobs.map(job => job.issue.repo + ':' + job.issue.id)).size,
    feedback: reviews.length, accepted, corrected: reviews.filter(job => job.feedback!.verdict === 'corrected').length,
    rejected: reviews.filter(job => job.feedback!.verdict === 'rejected').length, acceptanceRate: reviews.length ? accepted / reviews.length : null,
    distribution, scores, assignments, invitations, method: 'cat-semantic-analysis-with-explicit-feedback', trainingPerformed: false as const };
}
export type TeamStatistics = ReturnType<typeof statistics>;
