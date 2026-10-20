import assert from 'node:assert/strict';
import test from 'node:test';
import { createRepoScanner } from './business/infrastructure/connectors/github-repo-event/RepoScanTaskSpec.js';
import { createRepoCommentPoller } from './business/infrastructure/connectors/github-repo-event/RepoCommentPollTaskSpec.js';
import { runCommunityReconciliation } from './business/domains/community/reconciliation/CommunityReconcilerTaskSpec.js';
import { CommunityReconciliationFindingStore } from './business/domains/community/reconciliation/CommunityReconciliationFindingStore.js';
import { SdkCommunityEventLog } from './business/domains/community/CommunityEventLog.js';
import { SdkCommunityObjectStore } from './business/domains/community/CommunityObjectStore.js';
import { CommunityProjector } from './business/domains/community/community-projector.js';
import { memoryStorage } from '../test/memory-storage.js';
import { gitHubAdmissionCanContinue } from './business/infrastructure/github/admission-budget.js';
import { readFile } from 'node:fs/promises';
import YAML from 'yaml';

const log = { info() {}, warn() {}, error() {} };
const dedup = { isNotified: async () => false, markNotified: async () => {},
  isBaselineEstablished: async () => true, markBaselineEstablished: async () => {} };

test('admission reserves canonical child-process cleanup and scan grants one snapshot budget', async () => {
  assert.equal(gitHubAdmissionCanContinue({now: () => 0, deadlineMs: 1_200}), false);
  const seen: (AbortSignal | undefined)[] = [];
  const scan = createRepoScanner({repoAllowlist: ['example/one'], log, reconciliationDedup: dedup,
    fetchOpenPRs: async (_repo, signal) => {seen.push(signal);return [];},
    fetchOpenIssues: async (_repo, signal) => {seen.push(signal);return [];}, deliver: async () => {}});
  await scan(new AbortController().signal);
  assert.equal(seen.length, 2);
  assert.equal(seen[0], seen[1], 'PR and issue pages form one repository observation');
  const manifest = YAML.parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8'));
  assert.equal(manifest.contributions.find((row: {id: string}) => row.id === 'repo-scan').policy.timeoutMs, 90_000);
});

function delayedRead(trace: string[], signal?: AbortSignal): Promise<[]> {
  return new Promise(resolve => {
    // This guard makes the old unbounded implementation finish and fail an
    // assertion rather than hanging the test. It is not the product deadline.
    const guard = setTimeout(() => { trace.push('unbounded'); resolve([]); }, 150);
    const aborted = () => {
      clearTimeout(guard); trace.push('aborted');
      setTimeout(() => { trace.push('closed'); resolve([]); }, 15);
    };
    if (signal?.aborted) aborted();
    else signal?.addEventListener('abort', aborted, { once: true });
  });
}

test('repository scan times out a remote read, awaits close, then serves the next repository', async () => {
  const trace: string[] = [], baseline: string[] = [];
  const scan = createRepoScanner({ repoAllowlist: ['example/slow', 'example/ready'], log,
    objectTimeoutMs: 5,
    reconciliationDedup: { ...dedup, isBaselineEstablished: async () => false,
      markBaselineEstablished: async repo => { baseline.push(repo); } },
    fetchOpenPRs: async (repo, signal) => repo.endsWith('/slow') ? delayedRead(trace, signal) : (trace.push('ready'), []),
    fetchOpenIssues: async () => [], deliver: async () => {},
  });
  await scan(new AbortController().signal);
  assert.deepEqual(trace, ['aborted', 'closed', 'ready']);
  assert.deepEqual(baseline, ['example/ready'], 'a timed-out partial scan must never establish its baseline');
});

test('comment polling timeout preserves its observation cursor and waits for cleanup before the next repository', async () => {
  const trace: string[] = [], writes: string[] = [];
  const poll = createRepoCommentPoller({ repoAllowlist: ['example/slow', 'example/ready'], log,
    objectTimeoutMs: 5, eventLog: new SdkCommunityEventLog(memoryStorage()),
    readCursor: async () => '2026-10-08T00:00:00.000Z',
    writeCursor: async repo => { writes.push(repo); },
    fetchRepoComments: async (repo, _since, signal) => repo.endsWith('/slow') ? delayedRead(trace, signal)
      : (trace.push('ready'), [{ issueNumber: 1, commentId: 1, author: 'reader', authorAssociation: 'NONE',
        body: 'hello', updatedAt: '2026-10-08T00:00:01.000Z', isPullRequest: false }]),
  });
  await poll(new AbortController().signal);
  assert.deepEqual(trace, ['aborted', 'closed', 'ready']);
  assert.deepEqual(writes, ['example/ready']);
});

test('scan admission has a real deadline and resumes fairly after runtime recreation', async () => {
  let now = 0, cursor: string | undefined;
  const reads: string[] = [];
  const options = { repoAllowlist: ['example/a', 'example/b', 'example/c'], log, reconciliationDedup: dedup,
    now: () => now, pollBudgetMs: 2_000,
    readProgress: async () => cursor, writeProgress: async (repo: string) => { cursor = repo; },
    fetchOpenPRs: async (repo: string) => { reads.push(repo); return []; },
    fetchOpenIssues: async () => { now += 2_000; return []; }, deliver: async () => {},
  };
  await createRepoScanner(options)(new AbortController().signal);
  assert.deepEqual(reads, ['example/a']);
  await createRepoScanner(options)(new AbortController().signal);
  assert.deepEqual(reads, ['example/a', 'example/b']);
});

test('comment admission retains a failed-repository fairness cursor across runtime recreation', async () => {
  let now = 0, cursor: string | undefined;
  const reads: string[] = [];
  const options = { repoAllowlist: ['example/a', 'example/b'], log, eventLog: new SdkCommunityEventLog(memoryStorage()),
    now: () => now, pollBudgetMs: 2_000,
    readProgress: async () => cursor, writeProgress: async (repo: string) => { cursor = repo; },
    readCursor: async () => '2026-10-08T00:00:00.000Z', writeCursor: async () => {},
    fetchRepoComments: async (repo: string) => { reads.push(repo); now += 2_000; throw new Error('provider unavailable'); },
  };
  await createRepoCommentPoller(options)(new AbortController().signal);
  assert.deepEqual(reads, ['example/a']);
  await createRepoCommentPoller(options)(new AbortController().signal);
  assert.deepEqual(reads, ['example/a', 'example/b']);
});

test('plugin lifetime cancellation awaits the remote close and never admits another repository', async () => {
  const trace: string[] = [], controller = new AbortController();
  const scan = createRepoScanner({ repoAllowlist: ['example/slow', 'example/ready'], log,
    objectTimeoutMs: 100, reconciliationDedup: dedup,
    fetchOpenPRs: async (_repo, signal) => {
      const pending = delayedRead(trace, signal);
      controller.abort(new Error('plugin disabled'));
      return pending;
    },
    fetchOpenIssues: async () => { trace.push('unexpected'); return []; }, deliver: async () => {},
  });
  await assert.rejects(scan(controller.signal), /plugin disabled/);
  assert.deepEqual(trace, ['aborted', 'closed']);
});

test('reconciler timeout cannot resolve existing findings or establish a partial baseline', async () => {
  const storage = memoryStorage(), events = new SdkCommunityEventLog(storage), objects = new SdkCommunityObjectStore(storage);
  const projector = new CommunityProjector(events, objects), findings = new CommunityReconciliationFindingStore(storage);
  const subjectKey = 'issue:example/slow#1', trace: string[] = [];
  const event = { sourceEventId: 'opened', subjectKey, kind: 'issue.opened' as const,
    classification: 'state-changing' as const, payload: {}, at: 1 };
  await events.append(event); await projector.apply(event);
  await findings.upsert({ findingId: 'existing', subjectKey, findingKind: 'drift', severity: 'warning',
    message: 'existing evidence', evidenceFingerprint: 'evidence' });
  let baselines = 0;
  const options = { objectStore: objects, eventLog: events, projector, findingStore: findings, log,
    objectTimeoutMs: 5, isBaselineEstablished: async () => false, markBaselineEstablished: async () => { baselines++; },
    fetchIssueState: async (_repo: string, _number: number, signal?: AbortSignal) => { await delayedRead(trace, signal); return null; },
    fetchPrState: async () => null,
  };
  await runCommunityReconciliation(options, new AbortController().signal);
  assert.deepEqual(trace, ['aborted', 'closed']);
  assert.equal(baselines, 0);
  await runCommunityReconciliation({ ...options, isBaselineEstablished: async () => true }, new AbortController().signal);
  assert.equal((await findings.get('existing'))?.status, 'open');
});

test('bounded reconciliation baselines each visited subject quietly and resumes after restart', async () => {
  const storage = memoryStorage(), events = new SdkCommunityEventLog(storage), objects = new SdkCommunityObjectStore(storage);
  const projector = new CommunityProjector(events, objects), findings = new CommunityReconciliationFindingStore(storage);
  const subjects = ['issue:example/a#1', 'issue:example/b#1'];
  for (const subjectKey of subjects) {
    const event = { sourceEventId: `opened:${subjectKey}`, subjectKey, kind: 'issue.opened' as const,
      classification: 'state-changing' as const, payload: {}, at: 1 };
    await events.append(event); await projector.apply(event);
  }
  let now = 0, cursor: string | undefined;
  const baselines = new Set<string>(), reads: string[] = [];
  const options = { objectStore: objects, eventLog: events, projector, findingStore: findings, log,
    now: () => now, pollBudgetMs: 2_000,
    readProgress: async () => cursor, writeProgress: async (subject: string) => { cursor = subject; },
    isBaselineEstablished: async (subject: string) => baselines.has(subject),
    markBaselineEstablished: async (subject: string) => { baselines.add(subject); },
    fetchIssueState: async (repo: string) => { reads.push(repo); now += 2_000; return {
      state: 'closed' as const, closedAt: '2026-10-08T00:00:00.000Z', mergedAt: null,
    }; }, fetchPrState: async () => null,
  };
  await runCommunityReconciliation(options, new AbortController().signal);
  assert.deepEqual(reads, ['example/a']);
  assert.deepEqual([...baselines], [subjects[0]]);
  await runCommunityReconciliation({ ...options }, new AbortController().signal);
  assert.deepEqual(reads, ['example/a', 'example/b']);
  assert.deepEqual([...baselines], subjects);
  for (const subject of subjects) assert.equal((await events.read(subject)).length, 1, 'initial baseline stays quiet');
  await runCommunityReconciliation({ ...options }, new AbortController().signal);
  assert.deepEqual(reads, ['example/a', 'example/b', 'example/a']);
  assert.equal((await events.read(subjects[0])).at(-1)?.kind, 'issue.closed');
  assert.equal((await events.read(subjects[1])).length, 1, 'deferred subject is not changed by this slice');
});

test('reconciler repairs a journaled close after projection storage failure instead of losing it on dedup', async () => {
  const storage = memoryStorage(), events = new SdkCommunityEventLog(storage), objects = new SdkCommunityObjectStore(storage);
  const projector = new CommunityProjector(events, objects), findings = new CommunityReconciliationFindingStore(storage);
  const subjectKey = 'issue:example/retry#1';
  const opened = { sourceEventId: 'opened', subjectKey, kind: 'issue.opened' as const,
    classification: 'state-changing' as const, payload: {}, at: 1 };
  await events.append(opened); await projector.apply(opened);
  const options = { objectStore: objects, eventLog: events, projector, findingStore: findings, log,
    isBaselineEstablished: async () => true, markBaselineEstablished: async () => {},
    fetchIssueState: async () => ({ state: 'closed' as const, closedAt: '2026-10-08T00:00:00Z', mergedAt: null }),
    fetchPrState: async () => null,
  };
  const save = objects.save.bind(objects);
  objects.save = async () => { throw new Error('projection unavailable'); };
  await assert.rejects(runCommunityReconciliation(options, new AbortController().signal), /projection unavailable/);
  assert.equal((await events.read(subjectKey)).length, 2);
  objects.save = save;
  await runCommunityReconciliation(options, new AbortController().signal);
  assert.equal((await objects.get(subjectKey))?.appliedEventCount, 2);
  assert.equal((await events.read(subjectKey)).length, 2);
});
