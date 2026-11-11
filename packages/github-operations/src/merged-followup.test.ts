import assert from 'node:assert/strict';
import test from 'node:test';
import type { GitHubWaitOutcomeV1 } from './business/model/index.js';
import type { RepoInboxSignal } from './business/infrastructure/connectors/github-repo-event/types.js';
import { renderGitHubWaitOutcome } from './business/domains/github-signals/github-wait-renderer.js';
import { buildLifecycleMessageContent } from './business/infrastructure/email/ci-message-content.js';
import { formatProviderBriefing } from './provider-briefing.js';

const wait: GitHubWaitOutcomeV1 = {
  v: 1, outcomeId: 'merged', generation: 1, subjectRef: 'pr:example/project#7',
  ownerFence: { kind: 'containing_task', generation: 1 }, reason: 'subject_terminal',
  terminalSubjectState: 'merged', at: 1, delivery: 'pending',
  nextStep: 'Check what changed on this subject, then continue the responsibility you already hold.',
};
const signal: RepoInboxSignal = {
  eventType: 'pull_request.opened', repoFullName: 'example/project', subjectType: 'pr', number: 7,
  title: 'A correction', url: 'https://github.com/example/project/pull/7', authorLogin: 'contributor',
  authorAssociation: 'CONTRIBUTOR', deliveryId: 'delivery', action: 'merged',
};

function assertFollowup(text: string) {
  assert.match(text, /Post-merge: intake \/ delivery remains/);
  assert.match(text, /intake.*backport/i);
  assert.match(text, /review-only.*original maintainer/i);
  assert.match(text, /execution thread continues through intake/);
  assert.match(text, /routing thread coordinates.*rather than becoming the implementation site/);
  assert.match(text, /upstream merged.*intake status.*owner.*next step/i);
  assert.match(text, /does not (complete|grant)/i);
}

test('every merged notification surface requires an accountable intake disposition', () => {
  assertFollowup(renderGitHubWaitOutcome(wait));
  assertFollowup(buildLifecycleMessageContent({ repoFullName: 'example/project', prNumber: 7, prState: 'merged' }));
  assertFollowup(formatProviderBriefing(signal));
  assertFollowup(formatProviderBriefing(signal, true));
});

test('merged tracking distinguishes retiring the subscription from completing the work', () => {
  const text = renderGitHubWaitOutcome(wait);
  assert.match(text.split('\n')[0], /PR merged.*follow-up required/);
  assert.match(text, /Tracking ended.*does not complete.*intake/i);
  assert.ok(text.indexOf('Post-merge:') < text.indexOf('Matched reason:'), 'action is visible before tracking metadata');
  assertFollowup(renderGitHubWaitOutcome({ ...wait, nextStep: 'Review complete; clean up the checkout.' }));
});

test('closed, expired and issue notifications do not invent a merged contribution', () => {
  for (const text of [
    renderGitHubWaitOutcome({ ...wait, terminalSubjectState: 'closed' }),
    renderGitHubWaitOutcome({ ...wait, reason: 'expired', terminalSubjectState: undefined }),
    renderGitHubWaitOutcome({ ...wait, subjectRef: 'issue:example/project#7', terminalSubjectState: 'closed' }),
    buildLifecycleMessageContent({ repoFullName: 'example/project', prNumber: 7, prState: 'closed' }),
    formatProviderBriefing({ ...signal, action: 'closed', title: 'merged; intake complete' }),
    formatProviderBriefing({ ...signal, subjectType: 'issue', action: 'merged' }),
  ]) assert.doesNotMatch(text, /Post-merge: intake \/ delivery remains/);
});
