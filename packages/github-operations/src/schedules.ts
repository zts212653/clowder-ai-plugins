export const GITHUB_SCHEDULES = [
  { id: 'cicd-check', everyMs: 60_000, timeoutMs: 30_000 },
  { id: 'conflict-check', everyMs: 300_000, timeoutMs: 30_000 },
  { id: 'review-feedback', everyMs: 60_000, timeoutMs: 30_000 },
  { id: 'repo-scan', everyMs: 300_000, timeoutMs: 30_000 },
  { id: 'issue-tracking', everyMs: 60_000, timeoutMs: 30_000 },
  { id: 'repo-comment-poll', everyMs: 60_000, timeoutMs: 30_000 },
  { id: 'community-reconciler', everyMs: 600_000, timeoutMs: 120_000 },
] as const;

export type GitHubScheduleId = (typeof GITHUB_SCHEDULES)[number]['id'];

export interface GitHubScheduleInvocation {
  scheduleId: GitHubScheduleId;
  runId: string;
  scheduledAt: string;
}

export interface GitHubOperationPort {
  run(input: GitHubScheduleInvocation): Promise<Readonly<{ publishedEventCount: number }>>;
}

/**
 * Package-owned schedule dispatch. Tracking registrations, cursors, leases, bindings, and event publication
 * remain behind the authenticated Host port; this function never reads process state or writes local storage.
 */
export async function runGitHubSchedule(
  input: GitHubScheduleInvocation,
  port: GitHubOperationPort,
): Promise<Readonly<{ publishedEventCount: number }>> {
  if (!GITHUB_SCHEDULES.some(schedule => schedule.id === input.scheduleId)) {
    throw new Error(`unknown GitHub schedule: ${input.scheduleId}`);
  }
  if (!input.runId.trim()) throw new Error('GitHub schedule runId is required');
  const timestamp = Date.parse(input.scheduledAt);
  if (!Number.isFinite(timestamp)) throw new Error('GitHub schedule scheduledAt must be ISO-8601');
  const result = await port.run(input);
  if (!Number.isSafeInteger(result.publishedEventCount) || result.publishedEventCount < 0) {
    throw new Error('GitHub operation port returned an invalid publishedEventCount');
  }
  return result;
}
