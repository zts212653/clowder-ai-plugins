// @ts-check
import assert from 'node:assert';
import { describe, it } from 'node:test';
import { fetchPrCiStatuses } from '../src/business/infrastructure/email/ci-status-batch-fetcher.js';
import { enrichPrCiStatus, fetchPrCiStatus } from '../src/business/infrastructure/email/ci-status-fetcher.js';

function graphQlPr({ sha, contexts, hasNextPage = false }) {
  return {
    headRefOid: sha,
    state: 'OPEN',
    mergedAt: null,
    mergedBy: null,
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              contexts: { nodes: contexts, pageInfo: { hasNextPage } },
            },
          },
        },
      ],
    },
  };
}

function checkRun(name, conclusion) {
  return {
    __typename: 'CheckRun',
    name,
    status: 'COMPLETED',
    conclusion,
    detailsUrl: `https://example.test/${name}`,
    checkSuite: { workflowRun: { workflow: { name: 'CI' } } },
  };
}

describe('fetchPrCiStatuses batch failure isolation', () => {
  it('binds each rollup and HEAD to its own repo-plus-PR key', async () => {
    const results = await fetchPrCiStatuses(
      [
        { repoFullName: 'owner/repo', prNumber: 7 },
        { repoFullName: 'owner/repo', prNumber: 8 },
      ],
      { warn() {} },
      {
        async execFileAsync(file, args) {
          assert.equal(file, 'gh');
          assert.equal(args[0], 'api');
          return {
            stdout: JSON.stringify({
              data: {
                r0: {
                  p0: graphQlPr({ sha: '7'.repeat(40), contexts: [checkRun('pr-7-gate', 'SUCCESS')] }),
                  p1: graphQlPr({ sha: '8'.repeat(40), contexts: [checkRun('pr-8-gate', null)] }),
                },
              },
            }),
          };
        },
      },
    );

    assert.deepEqual(
      {
        headSha: results.get('owner/repo#7')?.headSha,
        bucket: results.get('owner/repo#7')?.aggregateBucket,
        checks: results.get('owner/repo#7')?.checks.map((check) => check.name),
      },
      { headSha: '7'.repeat(40), bucket: 'pass', checks: ['pr-7-gate'] },
    );
    assert.deepEqual(
      {
        headSha: results.get('owner/repo#8')?.headSha,
        bucket: results.get('owner/repo#8')?.aggregateBucket,
        checks: results.get('owner/repo#8')?.checks.map((check) => check.name),
      },
      { headSha: '8'.repeat(40), bucket: 'pending', checks: ['pr-8-gate'] },
    );
  });

  it('passes cancellation to gh and does not swallow an abort as an empty poll', async () => {
    const controller = new AbortController();
    let commandCount = 0;

    const pending = fetchPrCiStatuses(
      [{ repoFullName: 'owner/repo', prNumber: 7 }],
      { warn() {} },
      {
        signal: controller.signal,
        async execFileAsync(_file, _args, options) {
          commandCount++;
          assert(options.signal instanceof AbortSignal);
          controller.abort(new Error('scheduler timeout'));
          assert.equal(options.signal.aborted, true);
          throw controller.signal.reason;
        },
      },
    );

    await assert.rejects(pending, /scheduler timeout/);
    assert.equal(commandCount, 1, 'abort must not start fallback or enrichment gh commands');
  });

  it('keeps healthy PR data when gh exits 1 with partial GraphQL data on stdout', async () => {
    const warnings = [];
    const partial = {
      data: {
        r0: {
          p0: graphQlPr({ sha: 'a'.repeat(40), contexts: [checkRun('gate', 'SUCCESS')] }),
          p1: null,
        },
      },
      errors: [{ type: 'NOT_FOUND', path: ['r0', 'p1'] }],
    };
    const ghError = Object.assign(new Error('gh exited with code 1'), { stdout: JSON.stringify(partial) });

    const results = await fetchPrCiStatuses(
      [
        { repoFullName: 'owner/repo', prNumber: 7 },
        { repoFullName: 'owner/repo', prNumber: 999_999 },
      ],
      { warn: (message) => warnings.push(String(message)) },
      {
        async execFileAsync() {
          throw ghError;
        },
      },
    );

    assert.equal(results.get('owner/repo#7')?.aggregateBucket, 'pass');
    assert.equal(results.get('owner/repo#999999'), null);
    assert.ok(warnings.some((message) => message.includes('partial errors')));
  });

  it('returns pass and fail facts without waiting for unrelated failure diagnostics', async () => {
    const commands = [];
    const results = await fetchPrCiStatuses(
      [
        { repoFullName: 'owner/repo', prNumber: 7 },
        { repoFullName: 'owner/repo', prNumber: 8 },
      ],
      { warn() {} },
      {
        async execFileAsync(_file, args) {
          commands.push([...args]);
          assert.equal(args[1], 'graphql', 'failure diagnostics must not run in batch admission');
          return {
            stdout: JSON.stringify({
              data: {
                r0: {
                  p0: graphQlPr({ sha: '7'.repeat(40), contexts: [checkRun('good', 'SUCCESS')] }),
                  p1: graphQlPr({ sha: '8'.repeat(40), contexts: [checkRun('bad', 'FAILURE')] }),
                },
              },
            }),
          };
        },
      },
    );
    assert.equal(commands.length, 1);
    assert.equal(results.get('owner/repo#7')?.aggregateBucket, 'pass');
    assert.equal(results.get('owner/repo#8')?.aggregateBucket, 'fail');
    assert.equal(results.get('owner/repo#8')?.checks[0].name, 'bad');
  });

  it('defers an incomplete rollup without blocking a sibling complete status', async () => {
    const controller = new AbortController();
    const results = await fetchPrCiStatuses(
      [
        { repoFullName: 'owner/repo', prNumber: 8 },
        { repoFullName: 'owner/repo', prNumber: 7 },
      ],
      { warn() {} },
      {
        signal: controller.signal,
        async execFileAsync(_file, args) {
          if (args[1] !== 'graphql') {
            controller.abort(new Error('unrelated full-rollup query timed out'));
            throw controller.signal.reason;
          }
          return {
            stdout: JSON.stringify({
              data: {
                r0: {
                  p0: graphQlPr({ sha: '8'.repeat(40), contexts: [checkRun('partial', 'SUCCESS')], hasNextPage: true }),
                  p1: graphQlPr({ sha: '7'.repeat(40), contexts: [checkRun('good', 'SUCCESS')] }),
                },
              },
            }),
          };
        },
      },
    );
    assert.equal(results.get('owner/repo#8'), null, 'partial data must never manufacture a pass');
    assert.equal(results.get('owner/repo#7')?.aggregateBucket, 'pass');
  });

  it('preserves required-check narrowing when a required check fails', async () => {
    const commands = [];
    const options = {
      async execFileAsync(file, args) {
        assert.equal(file, 'gh');
        commands.push([...args]);
        const command = args.join(' ');
        if (command.startsWith('api graphql ')) {
          return {
            stdout: JSON.stringify({
              data: {
                r0: {
                  p0: graphQlPr({
                    sha: 'b'.repeat(40),
                    contexts: [checkRun('required-gate', 'FAILURE'), checkRun('optional-lint', 'FAILURE')],
                  }),
                },
              },
            }),
          };
        }
        if (command.startsWith('pr checks ') && command.includes('--required')) {
          return {
            stdout: JSON.stringify([
              {
                name: 'required-gate',
                bucket: 'fail',
                link: 'https://example.test/required-gate',
                workflow: 'CI',
              },
            ]),
          };
        }
        if (command.includes('/check-runs?')) return { stdout: JSON.stringify({ check_runs: [] }) };
        if (command.includes('/actions/runs?')) return { stdout: JSON.stringify({ workflow_runs: [] }) };
        throw new Error(`unexpected gh command: ${command}`);
      },
    };
    const results = await fetchPrCiStatuses([{ repoFullName: 'owner/repo', prNumber: 7 }], { warn() {} }, options);
    assert.equal(commands.length, 1, 'batch publishes base facts before detail requests');
    const enriched = await enrichPrCiStatus(results.get('owner/repo#7'), { warn() {} }, options);

    assert.deepEqual(
      enriched.checks.map((check) => check.name),
      ['required-gate'],
    );
    assert.ok(commands.some((args) => args.includes('--required')));
  });

  it('leaves incomplete snapshots unknown until the exact PR-local reader completes', async () => {
    const commands = [];
    const options = {
      async execFileAsync(file, args) {
        assert.equal(file, 'gh');
        commands.push([...args]);
        const command = args.join(' ');
        if (command.startsWith('api graphql ')) {
          return {
            stdout: JSON.stringify({
              data: {
                r0: {
                  p0: graphQlPr({
                    sha: 'c'.repeat(40),
                    contexts: [
                      {
                        __typename: 'CheckRun',
                        name: 'gate',
                        status: 'IN_PROGRESS',
                        conclusion: null,
                      },
                    ],
                    hasNextPage: true,
                  }),
                },
              },
            }),
          };
        }
        if (command.startsWith('pr view ')) {
          return {
            stdout: JSON.stringify({
              headRefOid: 'c'.repeat(40),
              state: 'OPEN',
              mergedAt: null,
              mergedBy: null,
              statusCheckRollup: [{ name: 'gate', status: 'IN_PROGRESS', conclusion: '', __typename: 'CheckRun' }],
            }),
          };
        }
        throw new Error(`unexpected gh command: ${command}`);
      },
    };
    const results = await fetchPrCiStatuses([{ repoFullName: 'owner/repo', prNumber: 7 }], { warn() {} }, options);
    assert.equal(results.get('owner/repo#7'), null);
    assert.equal(commands.length, 1);
    const exact = await fetchPrCiStatus('owner/repo', 7, { warn() {} }, options);
    assert.equal(exact.aggregateBucket, 'pending');
    assert.ok(commands.some((args) => args[0] === 'pr' && args[1] === 'view'));
  });
});

it('shared batch never starts per-PR diagnostics or truncated exact reads', async () => {
  for (const truncated of [false, true]) {
    const controller = new AbortController(); let calls = 0;
    const results = await fetchPrCiStatuses([
      { repoFullName: 'owner/repo', prNumber: 7 }, { repoFullName: 'owner/repo', prNumber: 8 },
    ], { warn() {} }, { signal: controller.signal, execFileAsync: async (_file, args) => {
      calls++;
      if (args[1] !== 'graphql') { controller.abort(new Error('PR-local IO reached shared batch')); throw controller.signal.reason; }
      return { stdout: JSON.stringify({ data: { r0: {
        p0: graphQlPr({ sha: 'a'.repeat(40), contexts: [checkRun('bad', 'FAILURE')], hasNextPage: truncated }),
        p1: graphQlPr({ sha: 'b'.repeat(40), contexts: [checkRun('good', 'SUCCESS')] }),
      } } }) };
    } });
    assert.equal(calls, 1);
    assert.equal(results.get('owner/repo#8')?.aggregateBucket, 'pass');
    assert.equal(results.get('owner/repo#7')?.aggregateBucket ?? null, truncated ? null : 'fail');
  }
});
