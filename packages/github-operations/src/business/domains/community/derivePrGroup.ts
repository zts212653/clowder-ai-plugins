/**
 * Derive PR board group from pr_tracking AutomationState (F168).
 *
 * Groups:  completed → re-review-needed → has-conflict → in-review
 * Priority order matters: completed wins over everything.
 *
 * Real field semantics from CiCdRouter / ConflictRouter:
 *   ci.lastFingerprint = `${headSha}:${aggregateBucket}`
 *   ci.lastBucket = 'pass' | 'fail' | 'pending'
 *   conflict.mergeState = 'CONFLICTING' | 'MERGEABLE' | 'UNKNOWN'
 */

import type { PrBoardGroup } from '../../model/index.js';

/** Read-only provider facts, not a Host TaskStore or wait/custody model. */
interface PrBoardFacts {
  readonly ci?: { readonly headSha?: string; readonly lastFingerprint?: string; readonly lastBucket?: string };
  readonly conflict?: { readonly mergeState?: string };
  readonly closedAt?: number;
}

export function derivePrGroup(automationState?: PrBoardFacts | null, taskStatus?: string): PrBoardGroup {
  if (taskStatus === 'done') return 'completed';
  if (!automationState) return 'in-review';

  const { ci, conflict, closedAt } = automationState;

  if (closedAt != null) return 'completed';

  const hasNewCommit = ci?.headSha && ci.lastFingerprint && !ci.lastFingerprint.startsWith(`${ci.headSha}:`);

  if (hasNewCommit && ci?.lastBucket === 'pass') return 're-review-needed';

  if (conflict?.mergeState === 'CONFLICTING') return 'has-conflict';

  return 'in-review';
}
