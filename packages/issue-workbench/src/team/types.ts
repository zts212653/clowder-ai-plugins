import type { FeatureContext, PluginActionContext } from '@clowder-ai/plugin-sdk';
import type { IssueSourceComment } from '../model/issue-source.js';

export interface TeamIssue {
  repo: string;
  number: number;
  id: string;
  title: string;
  body: string;
  updatedAt?: string;
  /** GitHub user.login, never inferred from issue prose. Null means unavailable. */
  author: string | null;
  state: 'open' | 'closed';
  labels: string[];
  assignees: string[];
  url: string;
}
export interface SharedDispatch {
  schema: 'issue-workbench.dispatch.v1';
  delivery?: 'invitation';
  id: string;
  issueId: string;
  assignee: string;
  score: number | null;
  reason: string;
  sourceVersion: string;
  acceptanceSuggestedFor?: string;
}
export interface AssignmentObservation {
  issue: TeamIssue;
  /** Provider assignment event ID, not issue updatedAt or a local clock. */
  assignmentId: string;
  delivery?: 'invitation';
  dispatch: SharedDispatch | null;
}
export interface SharedReceipt {
  schema: 'issue-workbench.receipt.v1';
  id: string;
  issueId: string;
  assignmentId: string;
  login: string;
  status: 'accepted' | 'working' | 'blocked' | 'ready';
  summary: string;
  evidenceUrls: string[];
}
export interface InvitationPage {
  observations: AssignmentObservation[];
  nextPage: number | null;
  newestUpdatedAt?: string;
}
export interface TeamProvider {
  /** Complete history for initial classification. A partial inventory must reject. */
  allIssues?(repo: string, signal: AbortSignal): Promise<TeamIssue[]>;
  /** Complete paginated Open Issue catalog; partial reads must reject. */
  openIssues(repo: string, signal: AbortSignal): Promise<TeamIssue[]>;
  identity(signal: AbortSignal): Promise<string>;
  /** Complete organization roster, including concealed members; throws if access is unverified. */
  organizationMembers(organization: string, signal: AbortSignal): Promise<string[]>;
  issue(repo: string, number: number, signal: AbortSignal): Promise<TeamIssue>;
  discussion?(issue: TeamIssue, signal: AbortSignal): Promise<IssueSourceComment[]>;
  assignable(repo: string, login: string, signal: AbortSignal): Promise<boolean>;
  canWrite(repo: string, login: string, signal: AbortSignal): Promise<boolean>;
  addAssignee(issue: TeamIssue, login: string, signal: AbortSignal): Promise<void>;
  publishDispatch(issue: TeamIssue, dispatch: SharedDispatch, signal: AbortSignal, allowCreate: boolean): Promise<string>;
  invitations(repo: string, login: string, trustedSenders: string[], signal: AbortSignal, page?: number, since?: string): Promise<InvitationPage>;
  invitation(issue: TeamIssue, assignmentId: string, login: string, trustedSenders: string[], signal: AbortSignal): Promise<AssignmentObservation | null>;
  assigned(repo: string, login: string, signal: AbortSignal): Promise<AssignmentObservation[]>;
  publishReceipt(issue: TeamIssue, receipt: SharedReceipt, signal: AbortSignal, allowCreate: boolean): Promise<string>;
  receipts(issue: TeamIssue, signal: AbortSignal, trustedSenders?: string[]): Promise<SharedReceipt[]>;
}
export type TeamContext = Pick<FeatureContext, 'pluginInstanceId' | 'config' | 'storage' | 'threads' | 'messaging' | 'log'>;
export type TeamCaller = PluginActionContext;
export interface TeamAnalysis {
  category: string;
  score: number | null;
  reason: string;
  evidence: string;
  blocksRuntime: boolean;
  workaround: string;
}
