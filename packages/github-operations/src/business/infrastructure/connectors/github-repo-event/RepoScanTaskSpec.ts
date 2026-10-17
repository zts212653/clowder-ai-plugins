/**
 * Repository reconciliation business copied from Host 496e2408.
 * Admission selection, first-run baseline, filtering and five-item round-robin
 * budget remain package-owned. Host thread-kind stamping and task/wake plumbing
 * are replaced by the SDK notification callback supplied by this installation.
 */
import { formatProviderBriefing } from '../../../../provider-briefing.js';
import type { CommunityEvent } from '../../../model/index.js';
import type { ICommunityEventLog } from '../../../domains/community/CommunityEventLog.js';
import { gitHubAdmissionCanContinue, gitHubPollBudget, readGitHubObject, type GitHubPollOptions } from '../../github/admission-budget.js';
import { GitHubRateLimitError } from '../../github/request-budget.js';
import type { ReconciliationDedup } from './ReconciliationDedup.js';
import type { RepoInboxSignal } from './types.js';

interface WorkItem<T> { signal: T; subjectKey: string }
interface ScanAdmission { run: boolean; reason?: string; workItems?: WorkItem<RepoInboxSignal>[] }
const DEFAULT_MAX_WORK_ITEMS_PER_RUN = 5;
const SKIP_AUTHOR_ASSOCIATIONS = new Set(['OWNER']);
export interface GhPrItem {
  number: number; title: string; html_url: string; user: string; author_association: string; draft: boolean;
}
export interface GhIssueItem {
  number: number; title: string; html_url: string; user: string; author_association: string;
}
export interface RepoScannerOptions extends GitHubPollOptions {
  repoAllowlist: string[];
  reconciliationDedup: Pick<ReconciliationDedup, 'isNotified' | 'markNotified' | 'isBaselineEstablished' | 'markBaselineEstablished'>;
  fetchOpenPRs: (repo: string, signal?: AbortSignal) => Promise<GhPrItem[]>;
  fetchOpenIssues: (repo: string, signal?: AbortSignal) => Promise<GhIssueItem[]>;
  deliver: (signal: RepoInboxSignal, content: string) => Promise<void>;
  log: { info(...args: unknown[]): void; warn(...args: unknown[]): void };
  maxWorkItemsPerRun?: number;
  skipHistoricalOnFirstRun?: boolean;
  eventLog?: ICommunityEventLog;
  projector?: { apply(event: CommunityEvent): Promise<void>; rebuild(subjectKey: string): Promise<void> };
}


export function createRepoScanner(opts: RepoScannerOptions): (signal: AbortSignal) => Promise<void> {
  const maxWorkItemsPerRun = Math.max(1, opts.maxWorkItemsPerRun ?? DEFAULT_MAX_WORK_ITEMS_PER_RUN);
  const skipHistoricalOnFirstRun = opts.skipHistoricalOnFirstRun ?? true;
  let nextWorkItemOffset = 0;
  let nextRepoIndex = 0;
  function selectWorkItems(workItems: WorkItem<RepoInboxSignal>[]): WorkItem<RepoInboxSignal>[] {
    if (workItems.length <= maxWorkItemsPerRun) {
      nextWorkItemOffset = 0;
      return workItems;
    }

    const start = nextWorkItemOffset % workItems.length;
    const selected: WorkItem<RepoInboxSignal>[] = [];
    for (let i = 0; i < maxWorkItemsPerRun; i += 1) {
      selected.push(workItems[(start + i) % workItems.length]!);
    }
    nextWorkItemOffset = (start + maxWorkItemsPerRun) % workItems.length;
    return selected;
  }

  async function collect(abortSignal: AbortSignal): Promise<ScanAdmission> {
        const signal = abortSignal;
        const budget = gitHubPollBudget(signal, opts);
        signal?.throwIfAborted();
        if (opts.repoAllowlist.length === 0) {
          return { run: false, reason: 'no repos in allowlist' };
        }

        const workItems: WorkItem<RepoInboxSignal>[] = [];
        let baselinedItemCount = 0;
        let baselinedRepoCount = 0;

        const progress = await opts.readProgress?.();
        const priorIndex = progress === undefined ? -1 : opts.repoAllowlist.indexOf(progress);
        const startIndex = (priorIndex < 0 ? nextRepoIndex : priorIndex + 1) % opts.repoAllowlist.length;
        for (let step = 0; step < opts.repoAllowlist.length; step++) {
          signal?.throwIfAborted();
          if (step > 0 && !gitHubAdmissionCanContinue(budget)) break;
          const index = (startIndex + step) % opts.repoAllowlist.length;
          const repo = opts.repoAllowlist[index]!;
          nextRepoIndex = (index + 1) % opts.repoAllowlist.length;
          try {
            const repoWorkItems: WorkItem<RepoInboxSignal>[] = [];
            const baselineEstablished =
              !skipHistoricalOnFirstRun || (await opts.reconciliationDedup.isBaselineEstablished(repo));

            signal?.throwIfAborted();
            const prs = await readGitHubObject(budget, objectSignal => opts.fetchOpenPRs(repo, objectSignal));
            signal?.throwIfAborted();
            for (const pr of prs) {
              signal?.throwIfAborted();
              if (pr.draft) continue;
              if (SKIP_AUTHOR_ASSOCIATIONS.has(pr.author_association)) continue;
              if (await opts.reconciliationDedup.isNotified(repo, 'pr', pr.number)) continue;
              repoWorkItems.push({
                signal: {
                  eventType: 'pull_request.opened',
                  repoFullName: repo,
                  subjectType: 'pr',
                  number: pr.number,
                  title: pr.title,
                  url: pr.html_url,
                  authorLogin: pr.user,
                  authorAssociation: pr.author_association,
                  deliveryId: `reconciliation-pr-${repo}#${pr.number}`,
                  action: 'opened',
                },
                subjectKey: `repo-${repo}#pr-${pr.number}`,
              });
            }

            signal?.throwIfAborted();
            const issues = await readGitHubObject(budget, objectSignal => opts.fetchOpenIssues(repo, objectSignal));
            signal?.throwIfAborted();
            for (const issue of issues) {
              signal?.throwIfAborted();
              if (SKIP_AUTHOR_ASSOCIATIONS.has(issue.author_association)) continue;
              if (await opts.reconciliationDedup.isNotified(repo, 'issue', issue.number)) continue;
              repoWorkItems.push({
                signal: {
                  eventType: 'issues.opened',
                  repoFullName: repo,
                  subjectType: 'issue',
                  number: issue.number,
                  title: issue.title,
                  url: issue.html_url,
                  authorLogin: issue.user,
                  authorAssociation: issue.author_association,
                  deliveryId: `reconciliation-issue-${repo}#${issue.number}`,
                  action: 'opened',
                },
                subjectKey: `repo-${repo}#issue-${issue.number}`,
              });
            }

            signal?.throwIfAborted();
            if (!baselineEstablished) {
              await Promise.all(
                repoWorkItems.map((item) =>
                  opts.reconciliationDedup.markNotified(
                    item.signal.repoFullName,
                    item.signal.subjectType,
                    item.signal.number,
                  ),
                ),
              );
              await opts.reconciliationDedup.markBaselineEstablished(repo);
              baselinedItemCount += repoWorkItems.length;
              baselinedRepoCount += 1;
              continue;
            }

            workItems.push(...repoWorkItems);
          } catch (error) {
            signal?.throwIfAborted();
            if (error instanceof GitHubRateLimitError) continue;
            opts.log.warn(`[repo-scan] Failed to scan ${repo}, skipping`);
          } finally {
            await opts.writeProgress?.(repo);
          }
        }

        signal?.throwIfAborted();
        if (workItems.length === 0) {
          if (baselinedRepoCount > 0) {
            return {
              run: false,
              reason: `baseline established for ${baselinedItemCount} existing repo items across ${baselinedRepoCount} repo(s)`,
            };
          }
          return { run: false, reason: 'no unnotified items' };
        }

        return { run: true, workItems: selectWorkItems(workItems) };
  }
  return async abortSignal => {
    const admission = await collect(abortSignal);
    for (const item of admission.workItems ?? []) {
      abortSignal.throwIfAborted();
      const signal = item.signal;
      // Journal and projection precede delivery. The stable SDK message key
      // makes retry safe if delivery succeeded but marking the scan failed.
      if (opts.eventLog) {
        const kindMap: Record<string, CommunityEvent['kind']> = {
          pr: 'pr.opened',
          issue: 'issue.opened',
        };
        const eventKind = kindMap[signal.subjectType];
        if (eventKind) {
          const subjectKey = `${signal.subjectType}:${signal.repoFullName}#${signal.number}`;
          const sourceEventId = `scan:${signal.repoFullName}:${signal.number}:${eventKind}`;
          const communityEvent: CommunityEvent = {
            sourceEventId,
            subjectKey,
            kind: eventKind,
            classification: 'state-changing',
            payload: { title: signal.title, authorLogin: signal.authorLogin },
            at: Date.now(),
          };
          const { appended } = await opts.eventLog.append(communityEvent);
          if (appended && opts.projector) {
            await opts.projector.apply(communityEvent);
          } else if (opts.projector) {
            await opts.projector.rebuild(communityEvent.subjectKey);
          }
        }
      }
      await opts.deliver(signal, formatProviderBriefing(signal, true));
      await opts.reconciliationDedup.markNotified(signal.repoFullName, signal.subjectType, signal.number);
    }
  };
}
