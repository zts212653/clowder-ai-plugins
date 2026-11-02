import type { PluginStorageEntry, PluginStorageHost } from '@clowder-ai/plugin-sdk';
import { gitHubAdmissionCanContinue, gitHubObjectSignal } from './business/infrastructure/github/admission-budget.js';
import type { GitHubTarget, GitHubTrackingProvider } from './tracking-runtime.js';

export type TrackingChannel = 'cicd-check' | 'conflict-check' | 'review-feedback' | 'issue-tracking';
type Progress = { v: 1; cursor: string; pending: string[] };

function readProgress(value: unknown, prefix: string): Progress {
  if (value === undefined) return { v: 1, cursor: '0', pending: [] };
  const row = value as Partial<Progress> | null;
  if (!row || row.v !== 1 || typeof row.cursor !== 'string' || !/^\d+$/.test(row.cursor)
    || !Array.isArray(row.pending) || row.pending.some(key => typeof key !== 'string' || !key.startsWith(prefix))) {
    throw new TypeError('invalid persisted GitHub page cursor');
  }
  return { v: 1, cursor: row.cursor, pending: [...row.pending] };
}

/** Retain only one page of keys. Every operation rereads its current record before taking effect. */
export async function pollTrackingPages(input: {
  readonly storage: PluginStorageHost;
  readonly prefix: string;
  readonly channel: TrackingChannel;
  readonly signal: AbortSignal;
  readonly provider: GitHubTrackingProvider;
  readonly now: () => number;
  readonly pollBudgetMs: number;
  readonly objectTimeoutMs: number;
  readonly record: (value: unknown) => { active: boolean; target: GitHubTarget };
  readonly pollTarget: (key: string, deadline: number, provider: GitHubTrackingProvider) => Promise<void>;
}): Promise<void> {
  const { storage, channel, prefix, signal, now } = input;
  if (!storage.scan) throw new Error('Host plugin storage pagination is unavailable; update the Host before using this plugin');
  signal.throwIfAborted();
  const deadline = now() + input.pollBudgetMs;
  const progressKey = `github.poll-page.${channel}`;
  const legacyKey = `github.poll-cursor.${channel}`;
  const state = readProgress((await storage.get(progressKey))?.value, prefix);
  let started = state.cursor !== '0' || state.pending.length > 0;
  let entries: Readonly<Record<string, PluginStorageEntry>> = {};
  let attempts = 0;
  const seen = new Set<string>();
  const failures: unknown[] = [];
  const save = () => storage.set(progressKey, state);
  const advance = async (keys: readonly string[]) => {
    const done = new Set(keys);
    state.pending = state.pending.filter(key => !done.has(key));
    await save();
    // Keep the previous version's read cursor valid for a code rollback.
    if (keys.length) await storage.set(legacyKey, keys.at(-1)!);
  };
  const canContinue = () => now() < deadline && (attempts === 0 || gitHubAdmissionCanContinue({ deadlineMs: deadline, now }));

  while (canContinue()) {
    signal.throwIfAborted();
    if (!state.pending.length) {
      if (started && state.cursor === '0') break;
      const page = await storage.scan({ prefix, cursor: state.cursor, count: 50 });
      signal.throwIfAborted();
      started = true;
      state.cursor = page.cursor;
      state.pending = Object.keys(page.entries).filter(key => key.startsWith(prefix)).sort();
      entries = page.entries;
      await save();
      if (!state.pending.length) continue;
    }

    const cohort: { key: string; target: GitHubTarget }[] = [];
    const ignored: string[] = [];
    for (const key of state.pending) {
      signal.throwIfAborted();
      if (!canContinue()) break;
      if (seen.has(key)) { ignored.push(key); continue; }
      const entry = entries[key] ?? await storage.get(key);
      if (!entry) { ignored.push(key); continue; }
      const record = input.record(entry.value);
      if (!record.active || (channel === 'issue-tracking') !== (record.target.kind === 'issue')) {
        ignored.push(key); continue;
      }
      cohort.push({ key, target: record.target });
      if (channel === 'cicd-check' && input.provider.forCiBatch && cohort.length === 20) break;
    }
    if (ignored.length) await advance(ignored);
    if (!cohort.length) continue;

    let provider = input.provider;
    if (channel === 'cicd-check' && provider.forCiBatch) {
      const objectSignal = gitHubObjectSignal({ signal, deadlineMs: deadline, now, objectTimeoutMs: input.objectTimeoutMs })!;
      try {
        provider = await provider.forCiBatch(cohort.map(row => row.target), objectSignal);
        objectSignal.throwIfAborted();
      } catch (error) {
        signal.throwIfAborted();
        await advance(cohort.map(row => row.key));
        throw error;
      }
    }
    for (const { key } of cohort) {
      signal.throwIfAborted();
      if (!canContinue()) break;
      seen.add(key);
      attempts++;
      try { await input.pollTarget(key, deadline, provider); }
      catch (error) { signal.throwIfAborted(); failures.push(error); }
      // Failed remote targets also advance fairness; their original record/outbox remains retryable.
      await advance([key]);
    }
    if (channel === 'cicd-check' && input.provider.forCiBatch) break;
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'GitHub poll failed for multiple targets');
}
