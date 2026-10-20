import type { GitHubIssueAwaitStateV1, GitHubPrAwaitStateV1, GitHubWaitOutcomeV1, GitHubNotificationCoverageV1 } from './github-wait.js';
import type { PluginTaskItem } from '@clowder-ai/plugin-sdk';

/** CI/CD automation state for pr_tracking tasks */
export interface CiAutomationState {
  readonly headSha?: string;
  readonly lastFingerprint?: string;
  readonly lastBucket?: string;
  readonly lastNotifiedAt?: number;
  readonly enabled?: boolean;
  readonly skipNotified?: boolean;
  /**
   * Empty statusCheckRollup is ambiguous for a fresh HEAD: it can mean either
   * "this PR has no checks" or "GitHub has not created the check runs yet".
   * Neither is evidence that CI passed, so an empty rollup stays pending however
   * long it lasts. The same-HEAD observation streak is still persisted so
   * diagnostics can tell a fresh gap from a HEAD that never gained any check.
   */
  readonly rollupObservation?: {
    readonly headSha: string;
    readonly state: 'empty' | 'present';
    readonly streakStartedAt: number;
  };
  /** Terminal PR state — persisted by CiCdRouter when it observes it (F200 AC-D2.3). */
  readonly prState?: 'merged' | 'closed';
  /**
   * #1392 AC-2: when CiCdRouter first observed `prState`. A wait that is for something only the
   * review collector can see is left for that collector's final observation, for a bounded time
   * measured from here.
   */
  readonly terminalObservedAt?: number;
  /**
   * Durable receipts for PR-terminal world-truth effects. The terminal collector
   * remains schedulable until `completedAt` is present for the current `prState`.
   */
  readonly terminalEffects?: {
    readonly prState: 'merged' | 'closed';
    readonly prLifecycle?: true;
    readonly distillation?: true;
    readonly communityProjection?: true;
    readonly completedAt?: number;
  };
}

/** Conflict detection automation state for pr_tracking tasks */
export interface ConflictAutomationState {
  readonly mergeState?: string;
  readonly lastFingerprint?: string;
  readonly lastNotifiedAt?: number;
}

/** Review feedback automation state for pr_tracking tasks */
export interface ReviewAutomationState {
  /** Full review-state frontier; retains dismissals and detects incomplete provider reads. */
  readonly observedReviews?: Readonly<Record<string, string>>;
  /** @deprecated Combined cursor from schema v1. Inline and conversation IDs are incomparable. */
  readonly lastCommentCursor?: number;
  readonly lastInlineCommentCursor?: number;
  readonly lastConversationCommentCursor?: number;
  /**
   * True while a legacy combined cursor is being replayed into the two source-specific
   * cursors. Backfill through the frozen source targets remains state-only until durable.
   */
  readonly commentCursorMigrationPending?: boolean;
  /** Snapshot frontier for the one-time legacy backfill; later source activity remains live. */
  readonly commentCursorMigrationTargets?: {
    readonly inline: number;
    readonly conversation: number;
  };
  readonly lastDecisionCursor?: number;
  readonly lastNotifiedAt?: number;
  /**
   * Terminal PR state recorded by the review collector's final observation. Until it is present, CI
   * does not end a wait that only the review collector can observe (#1392 AC-2).
   */
  readonly prState?: 'merged' | 'closed';
}

/** Issue comment automation state for issue_tracking tasks (F202 Phase 2D) */
export interface IssueAutomationState {
  readonly lastCommentCursor?: number;
  readonly lastNotifiedAt?: number;
  readonly issueState?: 'open' | 'closed';
  /**
   * F168 Phase B: dual-cursor delivery tracking.
   * Tracks the max comment id routed to the thread or intentionally suppressed as an echo.
   * Separate from lastCommentCursor (collection) so delivery retries don't re-append events.
   * lastNotifiedAt is updated separately only after the owner wake is accepted.
   * Undefined means "not yet managed by dual-cursor; default to lastCommentCursor".
   */
  readonly lastDeliveredCursor?: number;
  /** Routed connector message whose owner wake has not yet reached durable admission. */
  readonly pendingWake?: IssuePendingWake | null;
}

export interface IssuePendingWake {
  readonly messageId: string;
  readonly threadId: string;
  readonly catId: string;
  readonly content: string;
  readonly deliveredCursor: number;
  readonly closeTaskAfterWake?: boolean;
}

/** F280 Phase B: PR-only collector and wait state. */
export interface PrAutomationState {
  readonly ci?: CiAutomationState;
  readonly conflict?: ConflictAutomationState;
  readonly review?: ReviewAutomationState;
  readonly closedAt?: number;
  readonly await?: GitHubPrAwaitStateV1;
  readonly waitOutcome?: GitHubWaitOutcomeV1;
  /** Type-level quarantine: issue compatibility cannot be installed on a PR state. */
  readonly issue?: never;
}

/** F280 Phase C: issue collector and typed one-shot wait state. */
export interface IssueWaitAutomationState {
  readonly issue?: IssueAutomationState;
  readonly closedAt?: number;
  readonly await?: GitHubIssueAwaitStateV1;
  readonly waitOutcome?: GitHubWaitOutcomeV1;
  /** Type-level quarantine: PR facts cannot be installed on an issue state. */
  readonly ci?: never;
  readonly conflict?: never;
  readonly review?: never;
}

/** Composite automation state embedded in pr_tracking/issue_tracking tasks (#320 KD-14, F202-2D). */
export type AutomationState = PrAutomationState | IssueWaitAutomationState;

/** Plugin-private wait record; Host task projection carries no provider state. */
export interface TaskItem extends PluginTaskItem {
  readonly automationState?: AutomationState;
  readonly userId?: string;
  readonly notification?: GitHubNotificationCoverageV1;
}
