// Provider policy retained from the frozen Host router. Registration, outbox
// and delivery now belong to GitHubTrackingRuntime; Host task/custody writes do not.
import type { CiBucket, CiPollResult } from './ci-cd-contract.js';
export type { CiBucket, CiCheckDetail, CiExecutionFailure, CiPollResult } from './ci-cd-contract.js';
export function classifyCiWaitBucket(poll: CiPollResult): CiBucket {
  if (poll.aggregateBucket !== 'fail') return poll.aggregateBucket;
  const failedChecks = poll.checks.filter((check) => check.bucket === 'fail');
  return failedChecks.length > 0 &&
    failedChecks.every((check) => check.executionFailure === 'billing_spending_limit_zero_step')
    ? 'external_infrastructure'
    : 'fail';
}

type RollupObservation = { readonly headSha: string; readonly state: 'empty' | 'present'; readonly streakStartedAt: number };
export function settleEmptyCheckRollup(
  poll: CiPollResult,
  previous: RollupObservation | undefined,
  now: number,
): { readonly poll: CiPollResult; readonly observation: RollupObservation } {
  if (poll.prState !== 'open' || poll.checkRollup !== 'empty') {
    return {
      poll,
      observation: { headSha: poll.headSha, state: 'present', streakStartedAt: now },
    };
  }

  const streakStartedAt =
    previous?.headSha === poll.headSha && previous.state === 'empty' ? previous.streakStartedAt : now;
  return {
    poll: { ...poll, aggregateBucket: 'pending' },
    observation: { headSha: poll.headSha, state: 'empty', streakStartedAt },
  };
}
