import type { CoordinationStorage } from '../source/IssueCoordinationStore.js';
import { CoordinationConflict } from '../source/IssueCoordinationStore.js';
import { IssueCoordinationService } from '../source/IssueCoordinationService.js';
import { issueRefKey, type IssueInvestigation, type SourcePreference, type Versioned } from '../model/issue-coordination.js';
import type { TeamContext, TeamIssue } from './types.js';
import type { CoordinationDetail, IssueRef } from '../model/issue-coordination.js';
import { hash, issueVersion } from './schema.js';

const prefix = 'issue-workbench.coordination.v1.';
interface Stored<T> { partition: string; key: string; versions: Versioned<T>[] }

/** Authored work and its history live in one CAS record in the installation's
 * existing durable store. UI and automation read it; neither maintains a copy. */
export class PluginCoordinationStore implements CoordinationStorage {
  constructor(private readonly context: TeamContext, private readonly authorized: () => Promise<void>) {}
  private id(partition: string, key: string) { return prefix + hash([partition, key]); }
  async history<T>(partition: string, key: string) {
    await this.authorized();
    const entry = await this.context.storage.get(this.id(partition, key));
    return (entry?.value as Stored<T> | undefined)?.versions ?? [];
  }
  async read<T>(partition: string, key: string) { return (await this.history<T>(partition, key)).at(-1) ?? null; }
  async list<T>(partition: string) {
    await this.authorized();
    return Object.entries(await this.context.storage.list()).flatMap(([key, entry]) => {
      if (!key.startsWith(prefix)) return [];
      const value = entry.value as Stored<T>;
      return value.partition === partition ? value.versions.slice(-1) : [];
    });
  }
  async put<T>(partition: string, key: string, value: T, expectedRevision: number) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('Invalid revision');
    const id = this.id(partition, key), previous = await this.context.storage.get(id);
    const versions = (previous?.value as Stored<T> | undefined)?.versions ?? [];
    if ((versions.at(-1)?.revision ?? 0) !== expectedRevision) throw new CoordinationConflict('记录已改变，请刷新后保存');
    const next = { revision: expectedRevision + 1, value };
    await this.authorized();
    const result = await this.context.storage.compareAndSet(id, previous?.revision ?? null, { partition, key, versions: [...versions, next] });
    if (!result.applied) throw new CoordinationConflict('记录已改变，请刷新后保存');
    return next;
  }
}

export const sourceId = (repo: string) => 'github:' + repo;
export const issueFact = (issue: TeamIssue) => ({ id: issue.id, number: issue.number, title: issue.title,
  state: issue.state === 'open' ? 'OPEN' as const : 'CLOSED' as const, labels: issue.labels, body: issue.body,
  author: issue.author ?? undefined, assignees: [...issue.assignees], updatedAt: issue.updatedAt ?? '', url: issue.url,
  contentVersion: issueVersion(issue), reviewVersion: issueVersion(issue) });

export async function readLocalWork(store: PluginCoordinationStore, issue: TeamIssue) {
  const id = sourceId(issue.repo);
  const preference = await store.read<SourcePreference>('preferences', id);
  if (preference?.value.enabled === false) throw new Error('来源已停用，请先重新接入');
  return store.read<IssueInvestigation>('work:' + id, issueRefKey({ sourceId: id, issueId: issue.id, number: issue.number }));
}

export function coordinationService(store: PluginCoordinationStore, repos: string[], driver: {
  allowed(repo: string): Promise<void>; catalog(repo: string): Promise<TeamIssue[]>;
  detail(repo: string, ref: IssueRef, offset?: number, version?: string): Promise<CoordinationDetail>;
}, actor: string) {
  return new IssueCoordinationService(store, repos.map(repo => ({
    profile: { id: sourceId(repo), provider: 'github', instance: 'https://github.com', repositoryId: repo,
      repository: repo, name: 'GitHub · ' + repo, visibility: 'internal' as const },
    authorize: async () => { await driver.allowed(repo); return true; },
    catalog: async () => {
      const issues = await driver.catalog(repo);
      return { repo, revision: 1, issues: issues.map(issueFact), fetchedAt: new Date().toISOString(),
        lastCompleteAt: new Date().toISOString(), failures: [], summary: { added: 0, changed: 0, closed: 0, reopened: 0 } };
    },
    detail: (ref, offset, version) => driver.detail(repo, ref, offset, version),
  })), actor);
}
