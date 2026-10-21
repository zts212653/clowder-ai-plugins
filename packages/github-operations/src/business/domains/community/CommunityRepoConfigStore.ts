/**
 * CommunityRepoConfigStore — Per-repo routing configuration (F168 Phase F — SO-0)
 *
 * operator defines guard thread + guard cat per repo. Static config, not a state machine.
 * Both InMemory (for unit tests) and SDK storage (for production) implementations.
 *
 * INV-F0: No repo config = fail-closed (no backfill, no autoRoute).
 *
 * Production state uses the SDK's private installation namespace.
 * Existing Host data is copied by explicit migration, never renamed or deleted.
 * TTL=0 — persistent (铁律 #5 / LL-048).
 */

import type { CommunityRepoConfig } from '../../model/index.js';
import { createHash } from 'node:crypto';
import type { PluginStorageHost } from '@clowder-ai/plugin-sdk';

// ---------------------------------------------------------------------------
// Upsert input (repo + guard thread + guard cat)
// ---------------------------------------------------------------------------

export interface UpsertRepoConfigInput {
  readonly repo: string;
  readonly guardThreadId: string;
  readonly guardCatId: string;
  readonly reviewMode?: CommunityRepoConfig['reviewMode'];
  readonly cloudReviewPolicy?: CommunityRepoConfig['cloudReviewPolicy'];
}

// ---------------------------------------------------------------------------
// Port interface
// ---------------------------------------------------------------------------

export interface ICommunityRepoConfigStore {
  upsert(input: UpsertRepoConfigInput): Promise<CommunityRepoConfig>;
  getByRepo(repo: string): Promise<CommunityRepoConfig | null>;
  listAll(): Promise<CommunityRepoConfig[]>;
  deleteByRepo(repo: string): Promise<boolean>;
}

function canonicalRepoName(repo: string): string {
  return repo.toLowerCase();
}

// ---------------------------------------------------------------------------
// InMemory implementation (unit tests)
// ---------------------------------------------------------------------------

export class InMemoryCommunityRepoConfigStore implements ICommunityRepoConfigStore {
  private readonly configs = new Map<string, CommunityRepoConfig>();

  async upsert(input: UpsertRepoConfigInput): Promise<CommunityRepoConfig> {
    const repo = canonicalRepoName(input.repo);
    const existing = this.configs.get(repo);
    const now = Date.now();
    const config: CommunityRepoConfig = {
      repo,
      guardThreadId: input.guardThreadId,
      guardCatId: input.guardCatId,
      ...(existing?.notificationThreadId && input.guardThreadId === existing.guardThreadId
        ? { notificationThreadId: existing.notificationThreadId } : {}),
      reviewMode: input.reviewMode ?? existing?.reviewMode ?? 'observe_only',
      cloudReviewPolicy: input.cloudReviewPolicy ?? existing?.cloudReviewPolicy ?? 'optional',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.configs.set(repo, config);
    return config;
  }

  async getByRepo(repo: string): Promise<CommunityRepoConfig | null> {
    return this.configs.get(canonicalRepoName(repo)) ?? null;
  }

  async listAll(): Promise<CommunityRepoConfig[]> {
    return [...this.configs.values()];
  }

  async deleteByRepo(repo: string): Promise<boolean> {
    return this.configs.delete(canonicalRepoName(repo));
  }
}

const PREFIX = 'community.repo.';
const keyOf = (repo: string) => PREFIX + createHash('sha256').update(canonicalRepoName(repo)).digest('hex');

export class SdkCommunityRepoConfigStore implements ICommunityRepoConfigStore {
  constructor(private readonly storage: PluginStorageHost) {}
  async upsert(input: UpsertRepoConfigInput): Promise<CommunityRepoConfig> {
    const repo = canonicalRepoName(input.repo);
    for (let attempt = 0; attempt < 64; attempt++) {
      const entry = await this.storage.get(keyOf(repo));
      const existing = entry?.value as CommunityRepoConfig | undefined;
      const now = Date.now();
      const config: CommunityRepoConfig = {
        repo, guardThreadId: input.guardThreadId, guardCatId: input.guardCatId,
        ...(existing?.notificationThreadId && input.guardThreadId === existing.guardThreadId
          ? { notificationThreadId: existing.notificationThreadId } : {}),
        reviewMode: input.reviewMode ?? existing?.reviewMode ?? 'observe_only',
        cloudReviewPolicy: input.cloudReviewPolicy ?? existing?.cloudReviewPolicy ?? 'optional',
        createdAt: existing?.createdAt ?? now, updatedAt: now,
      };
      if ((await this.storage.compareAndSet(keyOf(repo), entry?.revision ?? null, config)).applied) return config;
    }
    throw new Error('Repository configuration changed concurrently');
  }
  async getByRepo(repo: string): Promise<CommunityRepoConfig | null> {
    return (await this.storage.get(keyOf(repo)))?.value as CommunityRepoConfig ?? null;
  }
  async listAll(): Promise<CommunityRepoConfig[]> {
    return Object.entries(await this.storage.list()).filter(([key]) => key.startsWith(PREFIX))
      .map(([, entry]) => entry.value as CommunityRepoConfig);
  }
  async deleteByRepo(repo: string): Promise<boolean> { return (await this.storage.delete(keyOf(repo))).deleted; }
}

export function createCommunityRepoConfigStore(storage: PluginStorageHost): ICommunityRepoConfigStore {
  return new SdkCommunityRepoConfigStore(storage);
}
