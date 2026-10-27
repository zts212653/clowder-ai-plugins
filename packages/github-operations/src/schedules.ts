export const GITHUB_SCHEDULES = [
  { id: 'pr-tracking', everyMs: 60_000, timeoutMs: 90_000 },
  { id: 'repo-scan', everyMs: 300_000, timeoutMs: 90_000 },
  { id: 'issue-tracking', everyMs: 60_000, timeoutMs: 90_000 },
  { id: 'assignment-inbox', everyMs: 60_000, timeoutMs: 90_000 },
  { id: 'repo-comment-poll', everyMs: 60_000, timeoutMs: 120_000 },
  { id: 'community-reconciler', everyMs: 600_000, timeoutMs: 120_000 },
] as const;

export type GitHubScheduleId = (typeof GITHUB_SCHEDULES)[number]['id'];
