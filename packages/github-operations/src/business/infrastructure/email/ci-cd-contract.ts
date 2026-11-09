
export type CiBucket = 'pass' | 'fail' | 'pending' | 'external_infrastructure';
export type CiExecutionFailure = 'billing_spending_limit_zero_step';

export interface CiCheckDetail {
  readonly name: string;
  readonly bucket: CiBucket;
  readonly link?: string;
  readonly workflow?: string;
  readonly description?: string;
  /** Raw provider evidence retained for terminal historical inspection. */
  readonly providerStatus?: string;
  readonly providerConclusion?: string | null;
  /** Closed enum derived only from typed GitHub execution payloads. */
  readonly executionFailure?: CiExecutionFailure;
}

export interface CiPollResult {
  /** Exact response subject and rollup commit were independently matched. */
  readonly identityVerified?: true;
  readonly repoFullName: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly prState: 'open' | 'merged' | 'closed';
  readonly aggregateBucket: CiBucket;
  /** Raw GitHub rollup presence; an empty rollup is never positive CI evidence. */
  readonly checkRollup?: 'empty' | 'present';
  readonly checks: readonly CiCheckDetail[];
  /** GitHub login of the user who merged the PR (only present when prState=merged). */
  readonly mergedByLogin?: string;
}
