/** Package-owned scheduling of the unchanged pure Community reconciler.
 * Each subject is independent in reconcile(). Bound admission and persist the
 * last attempt so a large installation makes progress across runtime restarts.
 * First successful observation stays quiet per subject; a failed read cannot
 * establish its baseline, clear findings, or prevent other subjects progressing.
 */
import type { CommunityObjectProjection } from '../../../model/index.js';
import { gitHubAdmissionCanContinue, gitHubPollBudget, readGitHubObject, type GitHubPollOptions } from '../../../infrastructure/github/admission-budget.js';
import type { ICommunityEventLog } from '../CommunityEventLog.js';
import type { ICommunityObjectStore } from '../CommunityObjectStore.js';
import type { SlaPolicy } from '../community-sla-policy.js';
import { type GitHubSnapshot, reconcile } from './CommunityReconciler.js';
import type { CommunityReconciliationFindingStore } from './CommunityReconciliationFindingStore.js';

export interface CommunityReconcilerTaskSpecOptions extends GitHubPollOptions {
  objectStore: Pick<ICommunityObjectStore, 'get' | 'listSubjectKeys'>;
  eventLog: ICommunityEventLog;
  projector: { apply(event: Parameters<ICommunityEventLog['append']>[0]): Promise<void>; rebuild(subjectKey: string): Promise<void> };
  findingStore: CommunityReconciliationFindingStore;
  fetchIssueState: (repo: string, number: number, signal?: AbortSignal) => Promise<GitHubSnapshot | null>;
  fetchPrState: (repo: string, number: number, signal?: AbortSignal) => Promise<GitHubSnapshot | null>;
  slaPolicy?: SlaPolicy;
  log: { info(...args: unknown[]): void; warn(...args: unknown[]): void };
  isBaselineEstablished: (subjectKey: string) => Promise<boolean>;
  markBaselineEstablished: (subjectKey: string) => Promise<void>;
}

export async function runCommunityReconciliation(opts: CommunityReconcilerTaskSpecOptions, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const budget = gitHubPollBudget(signal, opts);
  const subjects = [...await opts.objectStore.listSubjectKeys()].sort();
  if (!subjects.length) return;
  const progress = await opts.readProgress?.();
  const previous = progress === undefined ? -1 : subjects.indexOf(progress);
  const start = (previous + 1) % subjects.length;
  for (let step = 0; step < subjects.length; step++) {
    signal.throwIfAborted();
    if (step > 0 && !gitHubAdmissionCanContinue(budget)) break;
    const subject = subjects[(start + step) % subjects.length]!;
    try {
      const projection = await opts.objectStore.get(subject);
      signal.throwIfAborted();
      if (!projection) continue;
      const parsed = subject.match(/^(issue|pr):([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9][0-9]*)$/);
      if (!parsed || !Number.isSafeInteger(Number(parsed[3]))) {
        opts.log.warn(`[reconciler] Cannot parse subjectKey: ${subject}`);
        continue;
      }
      const baselineEstablished = await opts.isBaselineEstablished(subject);
      let snapshot: GitHubSnapshot | null = null, fetched = false;
      try {
        const read = parsed[1] === 'issue' ? opts.fetchIssueState : opts.fetchPrState;
        snapshot = await readGitHubObject(budget, childSignal => read(parsed[2]!, Number(parsed[3]), childSignal));
        fetched = true;
      } catch (error) {
        signal.throwIfAborted();
        opts.log.warn(`[reconciler] Failed to fetch GitHub state for ${subject}; findings retained`, error);
      }
      signal.throwIfAborted();
      if (!baselineEstablished) {
        if (fetched) await opts.markBaselineEstablished(subject);
        continue;
      }
      await applySubject(opts, projection, snapshot, fetched, signal);
    } finally {
      await opts.writeProgress?.(subject);
    }
  }
  signal.throwIfAborted();
}

async function applySubject(opts: CommunityReconcilerTaskSpecOptions, projection: CommunityObjectProjection,
  snapshot: GitHubSnapshot | null, fetched: boolean, signal: AbortSignal): Promise<void> {
  const subject = projection.subjectKey;
  const result = reconcile({ projections: [projection],
    githubSnapshots: snapshot ? new Map([[subject, snapshot]]) : new Map(),
    baselineEstablished: true, now: (opts.now ?? Date.now)(), slaPolicy: opts.slaPolicy,
  });
  for (const warning of result.warnings) opts.log.warn(`[reconciler] ${warning}`);
  for (const event of result.events) {
    signal.throwIfAborted();
    const { appended } = await opts.eventLog.append(event);
    // Never interrupt between durable append and its projection.
    if (appended) await opts.projector.apply(event);
    else await opts.projector.rebuild(event.subjectKey);
  }
  for (const finding of result.findings) {
    signal.throwIfAborted();
    await opts.findingStore.upsert(finding);
  }
  // Local SLA evaluation remains useful on fetch failure, but only a successful
  // remote read (including an explicit not-found) may resolve absent findings.
  if (fetched) {
    signal.throwIfAborted();
    await opts.findingStore.resolveAbsent(subject, result.findings.map(finding => finding.findingId));
  }
}
