import assert from 'node:assert/strict';
import test from 'node:test';
import { GitHubProvider } from './github-provider.js';

const head = 'b'.repeat(40), target = { kind: 'pr' as const, repoFullName: 'example/project', number: 12, threadId: 'thread', catId: 'cat' };
type Case = 'normal' | 'ci-subject' | 'ci-commit' | 'review-parent' | 'empty' | 'cancelled' | 'pages';
function fixture(state: 'MERGED' | 'CLOSED', foreign = false, scenario: Case = 'normal') {
  const provider = new GitHubProvider({ token: async () => 'isolated-terminal-test', log: { warn() {} }, execFileAsync: async (_file, args) => {
    if (args[1] === 'user') return { stdout: 'owner' };
    if (args[1] === 'graphql') return { stdout: JSON.stringify({ data: { r0: { p0: {
      number: scenario === 'ci-subject' ? 13 : 12, repository: { nameWithOwner: 'example/project' }, headRefOid: head, state,
      mergedAt: state === 'MERGED' ? '2026-11-01T00:00:00Z' : null, mergedBy: null,
      commits: { nodes: [{ commit: { oid: scenario === 'ci-commit' ? 'f'.repeat(40) : head, statusCheckRollup: { contexts: {
        pageInfo: { hasNextPage: scenario === 'pages' && !args.some(arg => arg.includes('after:')), endCursor: 'next-page' }, nodes: scenario === 'empty' ? [] : [
        { __typename: 'CheckRun', name: args.some(arg => arg.includes('after:')) ? 'second-page' : 'gate', status: 'COMPLETED',
          conclusion: scenario === 'cancelled' ? 'CANCELLED' : 'SUCCESS', detailsUrl: 'https://github.com/example/project/actions/runs/1/job/2', checkSuite: { commit: { oid: head } } },
      ] } } } }] },
    } } } }) };
    if (args[1] === '/repos/example/project/pulls/12') return { stdout: JSON.stringify({ number: 12,
      html_url: `https://github.com/${foreign ? 'other/project' : 'example/project'}/pull/12`, state: 'closed', head: { sha: head }, closed_at: '2026-11-01T00:00:00Z',
      merged_at: state === 'MERGED' ? '2026-11-01T00:00:00Z' : null, merge_commit_sha: state === 'MERGED' ? 'c'.repeat(40) : null }) };
    if (args[1]?.includes('/reviews?')) return { stdout: JSON.stringify({ id: 10, user: { login: 'reviewer' }, state: 'APPROVED', commit_id: head, submitted_at: '2026-10-31T23:59:59Z', pull_request_url: `https://api.github.com/repos/example/project/pulls/${scenario === 'review-parent' ? 13 : 12}` }) };
    return { stdout: '' };
  } });
  return provider;
}
for (const state of ['MERGED', 'CLOSED'] as const) for (const batch of [false, true]) {
  test(`${state} ${batch ? 'batch' : 'exact'} snapshot keeps actual CI and final subject facts`, async () => {
    const provider = fixture(state), signal = new AbortController().signal;
    const reader = batch ? await provider.forCiBatch([target], signal) : provider;
    const snapshot = await reader.read(target, signal);
    assert.equal(snapshot.ci, 'pass', 'a terminal PR with a successful rollup is not pending');
    assert.equal(snapshot.terminalFacts?.headSha, head);
    assert.equal(snapshot.terminalFacts?.reviews[0]?.commitId, head);
    assert.equal(snapshot.terminalFacts?.ci?.source, 'github-status-check-rollup');
  });
}
test('a foreign provider subject cannot be recorded under the requested PR', async () => {
  await assert.rejects(fixture('MERGED', true).read(target, new AbortController().signal), /subject|identity/i);
});
for (const scenario of ['ci-subject', 'ci-commit', 'review-parent'] as const) test(`terminal ${scenario} mismatch cannot attest final facts`, async () => {
  await assert.rejects(fixture('MERGED', false, scenario).read(target, new AbortController().signal));
});
for (const scenario of ['empty', 'cancelled'] as const) test(`terminal ${scenario} CI is unknown with its original evidence retained`, async () => {
  const snapshot = await fixture('MERGED', false, scenario).read(target, new AbortController().signal);
  assert.equal(snapshot.terminalFacts?.ci?.status, 'unknown');
  if (scenario === 'cancelled') assert.equal(snapshot.terminalFacts?.ci?.checks[0]?.providerConclusion, 'CANCELLED');
});
test('terminal batch admission falls back to exact complete pagination before preserving CI', async () => {
  const provider = fixture('MERGED', false, 'pages'), signal = new AbortController().signal;
  const batch = await provider.forCiBatch([target], signal);
  const snapshot = await batch.read(target, signal);
  assert.deepEqual(snapshot.terminalFacts?.ci?.checks.map(check => check.name).sort(), ['gate', 'second-page']);
  assert.equal(snapshot.terminalFacts?.ci?.status, 'pass');
});
