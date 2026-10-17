import type { IssueSourceFact } from './issue-source.js';

export type { IssueSourceFact } from './issue-source.js';

/** Transitional application contract; credentials and authorization stay in the Host. */
export interface IssueSourceProfile {
  id: string;
  provider: string;
  instance: string;
  repositoryId: string;
  repository: string;
  name: string;
  visibility: 'public' | 'internal';
  synthetic?: boolean;
}
export interface SourcePreference {
  enabled: boolean;
  name: string;
  branch: string;
  base: string;
}
export interface IssueRef {
  sourceId: string;
  issueId: string;
  number: number;
}
export interface Versioned<T> {
  revision: number;
  value: T;
}
export type ImpactScope = 'unknown' | 'common' | 'internal';
export interface IssueInvestigation {
  ref: IssueRef;
  /** Last observed metadata keeps authored work discoverable if the catalog loses the item. */
  title: string;
  sourceVersion: string;
  scope: ImpactScope;
  module: string;
  tags: string;
  notes: string;
  evidence: string;
  branch: string;
  base: string;
  patch: string;
  taskUrl: string;
  adoption: 'pending' | 'not-needed' | 'applied';
  verification: 'pending' | 'failed' | 'passed';
  verificationEvidence: string;
  labelDraft: string;
}
export interface IssueRelation {
  refs: [IssueRef, IssueRef];
  kind: 'possible' | 'same-cause' | 'port';
  reason: string;
  sourceVersions: [string, string];
  /** Shared local conclusion is readable only while BOTH source grants are valid. */
  conclusion: string;
  createdBy: string;
  active: boolean;
}
export interface CoordinationSource {
  profile: IssueSourceProfile;
  preference: Versioned<SourcePreference>;
  issues: IssueSourceFact[];
  work: Versioned<IssueInvestigation>[];
  /** Initial model proposals, filtered to this authorized source and its readable issues. */
  classifications?: IssueClassification[];
  checkedAt?: string;
  retryAt?: string;
  error?: string;
}
export interface IssueClassification {
  id: string;
  model: string;
  generatedAt: string;
  source: {
    provider: string;
    instance: string;
    repositoryId: string;
    issueId: string;
    number: number;
    updatedAt: string;
    bodySha256: string;
  };
  labels: Record<'area' | 'kind' | 'symptom' | 'environment', string[]>;
  evidence: string;
}
export interface CoordinationSnapshot {
  sources: CoordinationSource[];
  relations: Versioned<IssueRelation>[];
}
export interface CoordinationDetail {
  fact: IssueSourceFact | null;
  error?: string;
  nextOffset?: number | null;
}
export interface CoordinationHost {
  load(refresh?: boolean): Promise<CoordinationSnapshot>;
  detail(ref: IssueRef, offset?: number, version?: string): Promise<CoordinationDetail>;
  saveWork(value: IssueInvestigation, expectedRevision: number): Promise<Versioned<IssueInvestigation>>;
  saveRelation(value: IssueRelation, expectedRevision: number): Promise<Versioned<IssueRelation>>;
  savePreference(
    sourceId: string,
    value: SourcePreference,
    expectedRevision: number,
  ): Promise<Versioned<SourcePreference>>;
  /** Optional existing single-source workspace; no implicit copying of its browser data. */
  legacyUrl?: string;
}
export const issueRefKey = (ref: IssueRef) => JSON.stringify([ref.sourceId, ref.issueId]);
export const relationKey = (refs: IssueRelation['refs']) => JSON.stringify(refs.map(issueRefKey).sort());
export function issueRef(sourceId: string, fact: IssueSourceFact): IssueRef {
  if (!fact.id) throw new Error('来源适配器必须提供稳定 Issue ID');
  return { sourceId, issueId: fact.id, number: fact.number };
}
export function newInvestigation(
  ref: IssueRef,
  title: string,
  sourceVersion: string,
  preference: SourcePreference,
): IssueInvestigation {
  return {
    ref,
    title,
    sourceVersion,
    scope: 'unknown',
    module: '',
    tags: '',
    notes: '',
    evidence: '',
    branch: preference.branch,
    base: preference.base,
    patch: '',
    taskUrl: '',
    adoption: 'pending',
    verification: 'pending',
    verificationEvidence: '',
    labelDraft: '',
  };
}
export function safeIssueUrl(raw: string): string | undefined {
  try {
    const u = new URL(raw);
    return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password ? u.href : undefined;
  } catch {
    return undefined;
  }
}
