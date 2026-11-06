/** Provider facts only. These fields never attest a native review or delivery. */
export interface PrTerminalFacts {
  readonly schemaVersion: 1;
  readonly subjectKey: string;
  readonly state: 'merged' | 'closed';
  readonly headSha: string | null;
  readonly closedAt: string | null;
  readonly mergedAt: string | null;
  readonly mergeCommitSha: string | null;
  readonly reviews: readonly {
    readonly id: number;
    readonly author: string;
    readonly state: string;
    readonly commitId: string | null;
    readonly submittedAt: string | null;
  }[];
  readonly ci: PrCiEvidence | null;
  readonly ciHistory?: readonly PrCiEvidence[];
  readonly source: 'github-api' | 'github-webhook';
  readonly observedAt: number;
}

export interface PrCiEvidence {
  readonly headSha: string;
  readonly status: 'pending' | 'pass' | 'fail' | 'external_infrastructure' | 'unknown';
  readonly source: 'github-status-check-rollup';
  readonly observedAt: number;
  readonly checkRollup: 'empty' | 'present';
  readonly checks: readonly { readonly name: string; readonly bucket: string; readonly link?: string; readonly workflow?: string;
    readonly providerStatus?: string; readonly providerConclusion?: string | null }[];
}
