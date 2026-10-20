import type { RepoInboxSignal } from './business/infrastructure/connectors/github-repo-event/types.js';
import { sanitize } from './business/domains/community/issue-analysis/CommunityIssueSanitizer.js';

/** Keep external prose in one bounded JSON scalar, never template syntax.
 * This is data framing, not a claim that arbitrary prose becomes trustworthy. */
export function formatUntrustedProviderText(value: string): string {
  const cleaned = sanitize(value.slice(0, 8192), '');
  return JSON.stringify(cleaned.passed ? cleaned.title.slice(0, 512) : '[title withheld]')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** The presentation part of legacy narrator intake. This is provider evidence
 * for the configured notification destination, never a role assignment or a
 * request to call a private Host route. Host message delivery owns any wake. */
export function formatProviderBriefing(signal: RepoInboxSignal, reconciliation = false): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(signal.repoFullName) ||
    !Number.isSafeInteger(signal.number) || signal.number < 1 || !['pr', 'issue'].includes(signal.subjectType)) {
    throw new TypeError('invalid provider briefing subject');
  }
  const repo = signal.repoFullName.toLowerCase();
  const subject = `${signal.subjectType}:${repo}#${signal.number}`;
  const label = signal.subjectType === 'pr' ? 'PR' : 'Issue';
  const knownAction: Record<string, string> = { opened: 'opened', ready_for_review: 'ready for review', closed: 'closed', reopened: 'reopened', merged: 'merged' };
  const action = Object.hasOwn(knownAction, signal.action) ? knownAction[signal.action] : 'updated';
  return [
    `🔔 **${label} #${signal.number}** ${action}${reconciliation ? ' (reconciliation)' : ''}`,
    `Repository: ${repo}`,
    // One scalar line: provider newlines/mentions cannot become template lines.
    `Title (provider text): ${formatUntrustedProviderText(signal.title)}`,
    `Provider author: ${JSON.stringify(signal.authorLogin.slice(0, 128))} (${JSON.stringify(signal.authorAssociation.slice(0, 64))})`,
    `https://github.com/${repo}/${signal.subjectType === 'pr' ? 'pull' : 'issues'}/${signal.number}`,
    `Source: ${subject}`,
    '',
    'Read github_repository_observations and github_inspect_subject through the installed plugin tools before summarizing.',
    'Use github_recommend_triage for a recommendation from supplied evidence, not an authenticated decision.',
    'Keep the public summary and evidence references separate from routing advice. Host governance alone admits assignments or signoff.',
  ].join('\n');
}
