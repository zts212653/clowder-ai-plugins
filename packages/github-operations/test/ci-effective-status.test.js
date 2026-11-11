import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fetchPrCiStatuses } from '../src/business/infrastructure/email/ci-status-batch-fetcher.js';
import { fetchPrCiStatus, enrichPrCiStatus } from '../src/business/infrastructure/email/ci-status-fetcher.js';
import { classifyCiWaitBucket } from '../src/business/infrastructure/email/CiCdRouter.js';
import { GitHubProvider } from '../src/github-provider.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/ci-pr1784-773.json', import.meta.url), 'utf8'));
const sha = fixture.pr.headRefOid;
const repo = 'zts212653/clowder-ai';
const contextsOf = pr => pr.commits.nodes[0].commit.statusCheckRollup.contexts;
const sample = () => structuredClone(fixture.pr);
const current = pr => contextsOf(pr).nodes.find(x => x.name === 'Test (Public)' && x.conclusion === 'SUCCESS');
const old = pr => contextsOf(pr).nodes.find(x => x.name === 'Test (Public)' && x.conclusion === 'FAILURE');

function boundary(pr, checks = fixture.checks) {
  return { async execFileAsync(_file, args) {
    if (args[0] === 'pr' && args[1] === 'view') {
      return { stdout: JSON.stringify({ ...pr, statusCheckRollup: contextsOf(pr).nodes }) };
    }
    if (args[0] === 'pr' && args[1] === 'checks') return { stdout: JSON.stringify(checks) };
    if (args[1] === 'graphql') return { stdout: JSON.stringify({ data: { r0: { p0: pr } } }) };
    if (args[1].includes('/check-runs?')) return { stdout: '{"check_runs":[]}' };
    if (args[1].includes('/actions/runs?')) return { stdout: '{"workflow_runs":[]}' };
    throw Error(`Unexpected request: ${args.join(' ')}`);
  } };
}

async function both(pr, expected, failingLinks = []) {
  const options = boundary(pr);
  const log = { warn() {} };
  const single = await fetchPrCiStatus(repo, 1784, log, options);
  const batch = (await fetchPrCiStatuses([{ repoFullName: repo, prNumber: 1784 }], log, options)).get(`${repo}#1784`);
  for (const poll of [single, batch, await enrichPrCiStatus(batch, log, options)]) {
    assert.equal(poll.headSha, sha);
    assert.equal(poll.aggregateBucket, expected);
    assert.equal(classifyCiWaitBucket(poll), expected);
    assert.deepEqual(poll.checks.filter(x => x.bucket === 'fail').map(x => x.link).sort(), failingLinks.sort());
  }
  assert.deepEqual(single.checks, batch.checks, 'both readers must publish the same effective checks');
  return batch;
}

test('real 1784 rollup: superseded failure cannot mask current successful runs', async () => {
  assert.equal(contextsOf(fixture.pr).nodes.length, 34);
  assert.equal(contextsOf(fixture.pr).nodes.filter(x => x.conclusion === 'FAILURE').length, 1);
  const poll = await both(sample(), 'pass');
  assert.ok(poll.checks.some(x => x.link === current(fixture.pr).detailsUrl));
  assert.ok(!poll.checks.some(x => x.link === old(fixture.pr).detailsUrl));
});

test('a replacement still running remains pending', async () => {
  const pr = sample(); const check = current(pr);
  check.status = 'IN_PROGRESS'; check.conclusion = null;
  await both(pr, 'pending');
});

test('a replacement real failure remains blocking', async () => {
  const pr = sample(); const check = current(pr);
  check.conclusion = 'FAILURE';
  await both(pr, 'fail', [check.detailsUrl]);
});

for (const generation of ['new-run', 'rerun-attempt']) {
  test(`a cancelled ${generation} cannot erase a previous real failure`, async () => {
    const pr = sample(); const failed = old(pr); const replacement = current(pr);
    if (generation === 'rerun-attempt') {
      failed.checkSuite.workflowRun = { ...replacement.checkSuite.workflowRun, runAttempt: 1 };
      replacement.checkSuite.workflowRun.runAttempt = 2;
    }
    replacement.conclusion = 'CANCELLED';
    await both(pr, 'fail', [failed.detailsUrl]);
  });
}

for (const separate of ['app', 'workflow', 'head', 'missing-identity', 'missing-replacement']) {
  test(`a failure without a verified replacement is kept: ${separate}`, async () => {
    const pr = sample(); const failed = old(pr); const link = failed.detailsUrl;
    if (separate === 'app') failed.checkSuite.app.id += '-other';
    if (separate === 'workflow') failed.checkSuite.workflowRun.workflow.id += '-other';
    if (separate === 'head') failed.checkSuite.commit.oid = 'b'.repeat(40);
    if (separate === 'missing-identity') failed.checkSuite.app = null;
    if (separate === 'missing-replacement') contextsOf(pr).nodes = contextsOf(pr).nodes.filter(x => x !== current(pr));
    await both(pr, 'fail', [link]);
  });
}

test('a rerun of the same workflow run uses its newer check attempt', async () => {
  const pr = sample(); const failed = old(pr); const replacement = current(pr);
  failed.checkSuite.workflowRun = { ...replacement.checkSuite.workflowRun, runAttempt: 1 };
  replacement.checkSuite.workflowRun.runAttempt = 2;
  await both(pr, 'pass');
});

test('same-run same-attempt name collisions do not prove supersession', async () => {
  const pr = sample(); const failed = old(pr); const replacement = current(pr);
  failed.checkSuite.workflowRun = { ...replacement.checkSuite.workflowRun, runAttempt: 2 };
  replacement.checkSuite.workflowRun.runAttempt = 2;
  await both(pr, 'fail', [failed.detailsUrl]);
});

test('an independent legacy status context remains blocking', async () => {
  const pr = sample();
  contextsOf(pr).nodes.push({ __typename: 'StatusContext', context: 'Test (Public)', state: 'FAILURE', targetUrl: 'https://ci.example/failed' });
  await both(pr, 'fail', ['https://ci.example/failed']);
});

test('stale required-check details cannot replace current canonical failures', async () => {
  const pr = sample(); const replacement = current(pr); replacement.conclusion = 'FAILURE';
  const poll = (await fetchPrCiStatuses([{ repoFullName: repo, prNumber: 1784 }], { warn() {} }, boundary(pr))).get(`${repo}#1784`);
  const obsolete = old(fixture.pr);
  const enriched = await enrichPrCiStatus(poll, { warn() {} }, boundary(pr, [{ name: obsolete.name, bucket: 'fail', link: obsolete.detailsUrl }]));
  assert.deepEqual(enriched.checks.filter(x => x.bucket === 'fail').map(x => x.link), [replacement.detailsUrl]);
});

test('real provider single and batch snapshots consume effective CI, including blockers', async () => {
  for (const state of ['pass', 'pending', 'fail']) {
    const pr = sample(); const check = current(pr);
    if (state !== 'pass') check.conclusion = state === 'pending' ? null : 'FAILURE';
    if (state === 'pending') check.status = 'IN_PROGRESS';
    const ci = boundary(pr);
    const provider = new GitHubProvider({ token: async () => undefined, log: { warn() {} },
      execFileAsync: async (file, args, options) => {
        const path = args[1];
        if (path === 'user') return { stdout: 'reviewer' };
        if (path === `/repos/${repo}/pulls/1784`) return { stdout: JSON.stringify({ number: 1784, html_url: `https://github.com/${repo}/pull/1784`, state: 'open', head: { sha }, mergeable_state: 'clean' }) };
        if (path.includes('/comments?') || path.includes('/reviews?')) return { stdout: '' };
        return ci.execFileAsync(file, args, options);
      } });
    const target = { kind: 'pr', repoFullName: repo, number: 1784, threadId: 'offline', catId: 'offline' };
    const signal = new AbortController().signal;
    const batch = await provider.forCiBatch([target], signal);
    for (const snapshot of [await provider.read(target, signal), await batch.read(target, signal)]) {
      assert.equal(snapshot.headSha, sha);
      assert.equal(snapshot.ci, state);
      assert.equal(snapshot.ciBlockerCount, state === 'fail' ? 1 : 0);
    }
  }
});

test('exact pagination selects across page boundaries without promoting the truncated batch', async () => {
  const all = contextsOf(sample()).nodes;
  let calls = 0;
  const options = { async execFileAsync(_file, args) {
    calls++;
    const pr = sample(); const after = args.some(arg => arg.includes('after: "next"'));
    contextsOf(pr).nodes = after ? all.filter(x => x.conclusion !== 'FAILURE') : all.filter(x => x.conclusion === 'FAILURE');
    contextsOf(pr).pageInfo = { hasNextPage: !after, endCursor: after ? null : 'next' };
    return { stdout: JSON.stringify({ data: { r0: { p0: pr } } }) };
  } };
  const batch = await fetchPrCiStatuses([{ repoFullName: repo, prNumber: 1784 }], { warn() {} }, options);
  assert.equal(batch.get(`${repo}#1784`), null);
  assert.equal(calls, 1);
  assert.equal((await fetchPrCiStatus(repo, 1784, { warn() {} }, options)).aggregateBucket, 'pass');
  assert.equal(calls, 3);
});

for (const incomplete of ['head-drift', 'missing-cursor', 'repeated-cursor', 'null-context', 'partial-errors']) {
  test(`incoherent or incomplete input cannot yield a pass: ${incomplete}`, async () => {
    let calls = 0;
    const result = await fetchPrCiStatus(repo, 1784, { warn() {} }, { async execFileAsync() {
      const pr = sample(); calls++;
      if (incomplete === 'null-context') contextsOf(pr).nodes = [null];
      else if (incomplete !== 'partial-errors') {
        contextsOf(pr).pageInfo = { hasNextPage: true, endCursor: incomplete === 'missing-cursor' ? null : 'same' };
        if (incomplete === 'head-drift' && calls > 1) pr.headRefOid = 'c'.repeat(40);
      }
      return { stdout: JSON.stringify({ data: { r0: { p0: pr } },
        ...(incomplete === 'partial-errors' ? { errors: [{ path: ['r0', 'p0', 'commits'] }] } : {}) }) };
    } });
    assert.equal(result, null);
    assert.ok(calls <= 2);
  });
}
