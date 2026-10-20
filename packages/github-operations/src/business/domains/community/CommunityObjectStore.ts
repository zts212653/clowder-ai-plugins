import { createHash } from 'node:crypto';
import type { PluginStorageHost } from '@clowder-ai/plugin-sdk';
import { type CommunityObjectProjection, canonicalizeCommunitySubjectKey } from '../../model/index.js';

export interface ICommunityObjectStore {
  get(subjectKey: string): Promise<CommunityObjectProjection | null>;
  save(projection: CommunityObjectProjection): Promise<void>;
  listSubjectKeys(): Promise<string[]>;
  delete(subjectKey: string): Promise<void>;
}


const PREFIX = 'community.object.';
function key(subject: string): string {
  return PREFIX + createHash('sha256').update(canonicalizeCommunitySubjectKey(subject)).digest('hex');
}

/** Rebuildable package projections. Migration supplies copies; this store never
 * reads or rewrites Host Redis keys. Source facts remain in the immutable log. */
export class SdkCommunityObjectStore implements ICommunityObjectStore {
  constructor(private readonly storage: PluginStorageHost) {}
  async get(subjectKey: string): Promise<CommunityObjectProjection | null> {
    return (await this.storage.get(key(subjectKey)))?.value as CommunityObjectProjection ?? null;
  }
  async save(projection: CommunityObjectProjection): Promise<void> {
    const subjectKey = canonicalizeCommunitySubjectKey(projection.subjectKey);
    await this.storage.set(key(subjectKey), { ...projection, subjectKey });
  }
  async listSubjectKeys(): Promise<string[]> {
    return Object.entries(await this.storage.list()).filter(([name]) => name.startsWith(PREFIX))
      .map(([, entry]) => (entry.value as CommunityObjectProjection).subjectKey);
  }
  async delete(subjectKey: string): Promise<void> { await this.storage.delete(key(subjectKey)); }
}
