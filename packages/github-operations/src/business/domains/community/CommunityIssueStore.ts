import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { PluginStorageHost } from '@clowder-ai/plugin-sdk';
import type { CommunityIssueItem, CreateCommunityIssueInput } from '../../model/index.js';

/** Provider/private metadata only. This store never owns route acceptance,
 * guardian assignment, signoff, or owner-thread custody. */
export type CommunityIssueObservation = Pick<CommunityIssueItem,
  'id' | 'repo' | 'issueNumber' | 'issueType' | 'title' | 'linkedPrNumbers' | 'lastActivity' | 'createdAt' | 'updatedAt'>;
export type UpdateIssueObservation = Partial<Pick<CommunityIssueObservation, 'title' | 'issueType' | 'linkedPrNumbers' | 'lastActivity'>>;

export interface ICommunityIssueStore {
  create(input: CreateCommunityIssueInput): Promise<CommunityIssueObservation | null>;
  get(id: string): Promise<CommunityIssueObservation | null>;
  getByRepoAndNumber(repo: string, issueNumber: number): Promise<CommunityIssueObservation | null>;
  listByRepo(repo: string): Promise<CommunityIssueObservation[]>;
  listAll(): Promise<CommunityIssueObservation[]>;
  update(id: string, input: UpdateIssueObservation): Promise<CommunityIssueObservation | null>;
  delete(id: string): Promise<boolean>;
}
const prefix = 'community.issue.';
const idOf = (repo: string, number: number) => createHash('sha256').update(`${repo.toLowerCase()}#${number}`).digest('hex');
const fields = ['id', 'repo', 'issueNumber', 'issueType', 'title', 'linkedPrNumbers', 'lastActivity', 'createdAt', 'updatedAt'];
function observation(value: unknown): CommunityIssueObservation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('invalid issue observation');
  if (Object.keys(value).some(key => !fields.includes(key))) throw new TypeError('unsupported persisted issue observation field');
  const item = value as CommunityIssueObservation;
  if (typeof item.repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(item.repo) ||
      !Number.isSafeInteger(item.issueNumber) || item.issueNumber < 1 || item.id !== idOf(item.repo, item.issueNumber) ||
      !['bug', 'feature', 'enhancement', 'question'].includes(item.issueType) ||
      typeof item.title !== 'string' || !item.title.trim() || item.title.length > 8192 ||
      !Array.isArray(item.linkedPrNumbers) || item.linkedPrNumbers.length > 1000 ||
      item.linkedPrNumbers.some(number => !Number.isSafeInteger(number) || number < 1) ||
      !item.lastActivity || typeof item.lastActivity.event !== 'string' || !item.lastActivity.event ||
      Object.keys(item.lastActivity).some(key => !['at', 'event'].includes(key)) ||
      ![item.lastActivity.at, item.createdAt, item.updatedAt].every(time => Number.isSafeInteger(time) && time >= 0)) {
    throw new TypeError('invalid issue observation metadata');
  }
  return item;
}

/** Private issue metadata, backed by SDK CAS. Host governance is not copied.
 * A subject-derived ID makes create/dedup a single durable operation. */
export class SdkCommunityIssueStore implements ICommunityIssueStore {
  constructor(private readonly storage: PluginStorageHost) {}
  /** Insert a fully validated provider-only copy. Never replace existing data,
   * including owner edits and another concurrent import. No legacy ID is trusted. */
  async copyObservation(value: CommunityIssueObservation): Promise<'imported' | 'identical' | 'preserved'> {
    const item = observation(value);
    if ((await this.storage.compareAndSet(prefix + item.id, null, item)).applied) return 'imported';
    const current = await this.get(item.id);
    if (!current) throw new Error('issue observation removed concurrently; retry copy');
    return isDeepStrictEqual(current, item) ? 'identical' : 'preserved';
  }
  async create(input: CreateCommunityIssueInput): Promise<CommunityIssueObservation | null> {
    if (Object.keys(input).some(key => !['repo', 'issueNumber', 'issueType', 'title'].includes(key))) throw new TypeError('unsupported issue observation field');
    const now = Date.now(), id = idOf(input.repo, input.issueNumber);
    const item: CommunityIssueObservation = {
      id, repo: input.repo.toLowerCase(), issueNumber: input.issueNumber, issueType: input.issueType, title: input.title,
      linkedPrNumbers: [],
      lastActivity: { at: now, event: 'created' }, createdAt: now, updatedAt: now,
    };
    observation(item);
    return (await this.storage.compareAndSet(prefix + id, null, item)).applied ? item : null;
  }
  async get(id: string): Promise<CommunityIssueObservation | null> {
    const entry = await this.storage.get(prefix + id);
    if (!entry) return null;
    const item = observation(entry.value);
    if (item.id !== id) throw new TypeError('invalid issue observation identity');
    return item;
  }
  getByRepoAndNumber(repo: string, number: number): Promise<CommunityIssueObservation | null> { return this.get(idOf(repo, number)); }
  async listByRepo(repo: string): Promise<CommunityIssueObservation[]> { return (await this.listAll()).filter(item => item.repo === repo.toLowerCase()); }
  async listAll(): Promise<CommunityIssueObservation[]> {
    return Object.entries(await this.storage.list()).filter(([key]) => key.startsWith(prefix))
      .map(([key, entry]) => {
        const item = observation(entry.value);
        if (key !== prefix + item.id) throw new TypeError('invalid issue observation identity');
        return item;
      }).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async update(id: string, input: UpdateIssueObservation): Promise<CommunityIssueObservation | null> {
    if (Object.keys(input).some(key => !['title', 'issueType', 'linkedPrNumbers', 'lastActivity'].includes(key))) {
      throw new TypeError('unsupported issue observation field');
    }
    for (let attempt = 0; attempt < 64; attempt++) {
      const entry = await this.storage.get(prefix + id);
      if (!entry) return null;
      const existing = observation(entry.value);
      if (existing.id !== id) throw new TypeError('invalid issue observation identity');
      const updated = { ...existing, ...input, linkedPrNumbers: input.linkedPrNumbers ? [...input.linkedPrNumbers] : existing.linkedPrNumbers, updatedAt: Date.now() };
      observation(updated);
      if ((await this.storage.compareAndSet(prefix + id, entry.revision, updated)).applied) return updated;
    }
    throw new Error('community issue update contention');
  }
  async delete(id: string): Promise<boolean> { return (await this.storage.delete(prefix + id)).deleted; }
}

/** Decode the frozen RedisCommunityIssueStore hash into non-governance metadata.
 * Deliberately do not hydrate its assignment, state, tokens, direction card or
 * activity prose. Old records remain owned by the Host and are not modified. */
export function decodeLegacyIssueObservation(raw: Record<string, string>): CommunityIssueObservation {
  const number = (field: string) => {
    if (!/^(0|[1-9][0-9]*)$/.test(raw[field] ?? '')) throw new TypeError(`invalid legacy ${field}`);
    const value = Number(raw[field]);
    if (!Number.isSafeInteger(value)) throw new TypeError(`invalid legacy ${field}`);
    return value;
  };
  if (typeof raw.repo !== 'string') throw new TypeError('invalid legacy repo');
  const repo = raw.repo.toLowerCase(), issueNumber = number('issueNumber'), updatedAt = number('updatedAt');
  return observation({
    id: idOf(repo, issueNumber), repo, issueNumber, issueType: raw.issueType, title: raw.title,
    linkedPrNumbers: raw.linkedPrNumbers ? JSON.parse(raw.linkedPrNumbers) : [],
    createdAt: number('createdAt'), updatedAt,
    // Old lastActivityEvent may contain governance or private actor details.
    lastActivity: { at: updatedAt, event: 'legacy-metadata-copy' },
  });
}
