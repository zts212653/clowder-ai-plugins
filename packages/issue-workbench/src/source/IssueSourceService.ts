import { createHash } from 'node:crypto';
import {
  issueSourceContent as content,
  type IssueDetailResult,
  type IssueSourceFact,
  type IssueSourceReadResult,
  type IssueSourceSnapshot,
  issueReviewContent,
} from '../model/issue-source.js';

export interface IssueSourceStore {
  read(repo: string): Promise<IssueSourceSnapshot | null>;
  readDetail(repo: string, number: number, version?: string): Promise<IssueSourceFact | null>;
  write(snapshot: IssueSourceSnapshot): Promise<void>;
}
export type IssueSourceReader = (
  repo: string,
  since?: string,
  priorityNumber?: number,
  scope?: 'catalog' | 'detail' | 'full',
) => Promise<IssueSourceReadResult>;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export class IssueSourceService {
  private readonly operations = new Map<string, Promise<unknown>>();
  private readonly detailFlights = new Map<string, Promise<IssueDetailResult>>();
  private readonly flights = new Map<string, Promise<IssueSourceSnapshot>>();
  constructor(
    private readonly store: IssueSourceStore,
    private readonly reader: IssueSourceReader,
    private readonly now: () => number = Date.now,
  ) {}
  async read(repo: string) {
    return this.store.read(repo);
  }
  refresh(repo: string, _priorityNumber?: number): Promise<IssueSourceSnapshot> {
    const active = this.flights.get(repo);
    if (active) return active;
    const next = this.serial(repo, () => this.performRefresh(repo)).finally(() => this.flights.delete(repo));
    this.flights.set(repo, next);
    return next;
  }
  private async performRefresh(repo: string): Promise<IssueSourceSnapshot> {
    const previous = await this.store.read(repo);
    const start = this.now();
    if (previous?.retryAt && Date.parse(previous.retryAt) > start) return previous;
    // Periodic complete catalogs reconcile presence/state; discussion freshness is checked separately.
    const full = !previous?.lastFullAt || start - Date.parse(previous.lastFullAt) >= 30 * 60_000
      || previous.issues.some(fact => !fact.unavailable && fact.assignees === undefined);
    const since =
      !full && previous?.lastCompleteAt
        ? new Date(Date.parse(previous.lastCompleteAt) - 60_000).toISOString()
        : undefined;
    let observed: IssueSourceReadResult;
    try {
      observed = await this.reader(repo, since, undefined, 'catalog');
    } catch {
      observed = {
        issues: [],
        complete: false,
        failures: [{ kind: 'network', message: 'GitHub 读取失败，请稍后重试。' }],
      };
    }
    const issues = new Map(previous?.issues.map((i) => [i.number, i]) ?? []);
    const summary = { added: 0, changed: 0, closed: 0, reopened: 0 };
    for (const fact of observed.issues) {
      const old = issues.get(fact.number);
      if (old && Date.parse(fact.updatedAt) < Date.parse(old.updatedAt)) continue;
      if (!old) summary.added++;
      else if (content(old) !== content(fact)) {
        summary.changed++;
        if (old.state !== fact.state) {
          if (fact.state === 'CLOSED') summary.closed++;
          else summary.reopened++;
        }
      }
      issues.set(fact.number, {
        ...old,
        ...fact,
        unavailable: false,
        contentVersion: hash(content(fact)),
        reviewVersion: old?.reviewVersion,
        fetchedAt: new Date(start).toISOString(),
      });
    }
    // A successful full inventory proves only absence from the readable scope, never deletion.
    if (full && observed.complete && observed.failures.length === 0) {
      const present = new Set(observed.issues.map((f) => f.number));
      for (const [number, fact] of issues) {
        if (present.has(number) || fact.unavailable) continue;
        const unavailable = { ...fact, unavailable: true };
        issues.set(number, { ...unavailable, contentVersion: hash(content(unavailable)) });
        summary.changed++;
      }
    }
    const complete = observed.complete && observed.failures.length === 0;
    const snapshot: IssueSourceSnapshot = {
      repo,
      revision: (previous?.revision ?? 0) + 1,
      fetchedAt: observed.issues.length
        ? new Date(start).toISOString()
        : (previous?.fetchedAt ?? new Date(start).toISOString()),
      lastCheckedAt: new Date(start).toISOString(),
      lastCompleteAt: complete ? new Date(start).toISOString() : previous?.lastCompleteAt,
      lastFullAt: complete && full ? new Date(start).toISOString() : previous?.lastFullAt,
      retryAt: observed.retryAt,
      issues: [...issues.values()].sort((a, b) => b.number - a.number),
      failures: observed.failures,
      summary,
    };
    await this.store.write(snapshot);
    return snapshot;
  }
  private serial<T>(repo: string, run: () => Promise<T>): Promise<T> {
    const prior = this.operations.get(repo) ?? Promise.resolve();
    const next = prior.then(run, run);
    this.operations.set(repo, next);
    void next
      .finally(() => {
        if (this.operations.get(repo) === next) this.operations.delete(repo);
      })
      .catch(() => {});
    return next;
  }
  readDetail(repo: string, number: number, version?: string) {
    return this.store.readDetail(repo, number, version);
  }
  refreshDetail(repo: string, number: number): Promise<IssueDetailResult> {
    const key = `${repo}#${number}`;
    const active = this.detailFlights.get(key);
    if (active) return active;
    const next = this.serial(repo, async () => {
      const previous = await this.store.read(repo);
      const old = await this.store.readDetail(repo, number);
      if (previous?.retryAt && Date.parse(previous.retryAt) > this.now())
        return {
          detail: old,
          failures: [{ kind: 'rate_limit' as const, issueNumber: number, message: 'GitHub 限流，请稍后重试。' }],
          retryAt: previous.retryAt,
        };
      const started = new Date(this.now()).toISOString();
      let result: IssueSourceReadResult;
      try {
        result = await this.reader(repo, undefined, number, 'detail');
      } catch {
        result = {
          issues: [],
          complete: false,
          failures: [{ kind: 'network', issueNumber: number, message: '来源读取失败，上次内容仍保留。' }],
        };
      }
      const fresh = result.issues.find((i) => i.number === number);
      if (
        !result.complete ||
        result.failures.length ||
        !fresh ||
        typeof fresh.body !== 'string' ||
        !fresh.comments ||
        fresh.comments.length !== fresh.commentCount
      ) {
        if (previous && result.retryAt) await this.store.write({ ...previous, retryAt: result.retryAt });
        return {
          detail: old,
          failures: result.failures.length
            ? result.failures
            : [{ kind: 'incomplete' as const, issueNumber: number, message: '正文与评论尚未完整核对。' }],
          retryAt: result.retryAt,
        };
      }
      const indexed = previous?.issues.find((i) => i.number === number);
      if (indexed && Date.parse(fresh.updatedAt) < Date.parse(indexed.updatedAt))
        return {
          detail: old,
          failures: [{ kind: 'incomplete' as const, issueNumber: number, message: '来源版本较旧，保留当前内容。' }],
        };
      const detail = {
        ...fresh,
        fetchedAt: started,
        unavailable: false,
        contentVersion: hash(content(fresh)),
        reviewVersion: hash(issueReviewContent(fresh)),
      };
      await this.store.write({
        ...(previous ?? {
          repo,
          revision: 0,
          fetchedAt: started,
          failures: [],
          summary: { added: 0, changed: 0, closed: 0, reopened: 0 },
        }),
        revision: (previous?.revision ?? 0) + 1,
        issues: [...(previous?.issues.filter((i) => i.number !== number) ?? []), detail].sort(
          (a, b) => b.number - a.number,
        ),
      });
      return { detail: await this.store.readDetail(repo, number), failures: [] };
    }).finally(() => this.detailFlights.delete(key));
    this.detailFlights.set(key, next);
    return next;
  }
}
