import assert from 'node:assert/strict';
import test from 'node:test';
import { githubRepository, groupLandings } from '../src/github.mjs';
import { closureEvidence, issueReferences } from '../src/github-issues.mjs';
import { attachIssueRequirements } from '../src/requirements.mjs';

const pr = (id, sha, time = '') => ({
  node_id: id,
  merge_commit_sha: sha,
  merged_at: time || '2026-10-10',
  base: { ref: 'main' },
});
test('landing order follows main, even when PR timestamps disagree', () => {
  const groups = groupLandings(
    ['a', 'b'],
    { a: [pr('one', 'a', '2026-10-11')], b: [pr('two', 'b', '2026-10-10')] },
    'main',
  );
  assert.deepEqual(
    groups.map((group) => group.target),
    ['a', 'b'],
  );
});
test('rebase landings collect the actual contiguous main commits', () => {
  const source = pr('one', 'c');
  const groups = groupLandings(['a', 'b', 'c'], { a: [source], b: [source], c: [source] }, 'main');
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].boundaries, ['a', 'b', 'c']);
});
test('unknown commits, ambiguous PR ownership and a development head pause discovery', () => {
  for (const items of [[pr('one', 'a'), pr('two', 'a')], [pr('one', 'development-head')]]) {
    assert.throws(() => groupLandings(['a'], { a: items }, 'main'), { code: 'SOURCE_UNPROVEN' });
  }
});
test('GitHub coordinates are constrained to the configured source', () => {
  assert.equal(githubRepository('https://github.com/demo/core.git'), 'demo/core');
  assert.equal(githubRepository('git@github.com:demo/core.git'), 'demo/core');
  assert.equal(githubRepository('ssh://git@github.com/demo/core.git'), 'demo/core');
  assert.throws(() => githubRepository('https://example.com/demo/core.git'), { code: 'SOURCE_PLATFORM_UNSUPPORTED' });
});
test('commit-only and qualified Issue mentions are candidates, not closing proof', () => {
  assert.deepEqual(
    issueReferences(['Fixes #71', 'Related other/core#9', 'https://github.com/third/core/issues/10'], 'demo/core'),
    [
      { repo: 'demo/core', number: 71 },
      { repo: 'other/core', number: 9 },
      { repo: 'third/core', number: 10 },
    ],
  );
  const events = [
    { id: 'one', closer: { id: 'pr-1' } },
    { id: 'two', closer: { oid: 'landed' } },
    { id: 'three', closer: null },
    { id: 'four', closer: { id: 'other-pr' } },
  ];
  assert.deepEqual(
    closureEvidence(events, 'pr-1', ['landed']).map((event) => event.id),
    ['one', 'two'],
  );
  assert.deepEqual(closureEvidence([{ state: 'CLOSED' }], 'pr-1', ['landed']), []);
});
test('shared Issues wait for their actual closing delivery, not a later ordinary mention', () => {
  const plans = ['related', 'closes', 'related'].map((relation, index) => ({
    target: String(index + 1),
    issues: [{ sourceId: 'one', relation }],
  }));
  attachIssueRequirements(plans);
  assert.deepEqual(plans[0].issues[0].requiredTargets, ['1', '2']);
  assert.deepEqual(plans[1].issues[0].requiredTargets, ['1', '2']);
});
