import type { PluginStorageEntry, PluginStorageHost, PluginStorageProjection } from '@clowder-ai/plugin-sdk';
import { assertWaitStorage } from './typed-wait-record.js';

/** Preserve optional capability discovery and the caller's existing authorization fence. */
export function fencedIndexedStorage(storage: PluginStorageHost, check: () => Promise<void>):
  Pick<PluginStorageHost, 'compareAndSetIndexed' | 'readDue' | 'rebuildIndex'> {
  return {
    ...(storage.compareAndSetIndexed ? { compareAndSetIndexed: async (key: string, revision: number | null, value: unknown, projection: PluginStorageProjection) => {
      await check(); const result = await storage.compareAndSetIndexed!(key, revision, value, projection); await check(); return result;
    } } : {}),
    ...(storage.readDue ? { readDue: async (input: Parameters<NonNullable<PluginStorageHost['readDue']>>[0]) => {
      await check(); const result = await storage.readDue!(input); await check(); return result;
    } } : {}),
    ...(storage.rebuildIndex ? { rebuildIndex: async (index: string) => {
      await check(); const result = await storage.rebuildIndex!(index); await check(); return result;
    } } : {}),
  };
}

interface Census { v: 1; status: 'backfill' | 'building' | 'ready'; cursor: string }

/** Storage mechanics only. Each caller supplies its original record facts and projection rule. */
export class OwnerIndexedStorage {
  private preparing?: Promise<void>;
  constructor(private readonly storage: PluginStorageHost, private readonly options: {
    prefix: string; census: string; indexes: readonly string[];
    materialize(value: unknown): unknown;
    projection(value: unknown): PluginStorageProjection;
  }) {}

  async publish(key: string, revision: number | null, value: unknown) {
    assertWaitStorage(this.storage);
    if (!key.startsWith(this.options.prefix)) throw new Error('Owner storage key mismatch');
    const record = this.options.materialize(value);
    return this.storage.compareAndSetIndexed(key, revision, record, this.options.projection(record));
  }

  initialize(rebuild = false): Promise<void> {
    if (this.preparing) return this.preparing;
    const work = this.prepare(rebuild); this.preparing = work;
    void work.finally(() => { if (this.preparing === work) this.preparing = undefined; }).catch(() => {});
    return work;
  }

  private async prepare(rebuild: boolean): Promise<void> {
    assertWaitStorage(this.storage);
    const previous = await this.storage.get(this.options.census);
    let revision = previous?.revision ?? null;
    let progress = previous?.value as Census | undefined;
    if (progress?.status === 'ready' && !rebuild) return;
    if (progress && (progress.v !== 1 || !['backfill', 'building', 'ready'].includes(progress.status)))
      throw new Error('Invalid owner census; source records retained');
    progress ??= { v: 1, status: 'backfill', cursor: '0' };
    if (rebuild) {
      progress = { ...progress, status: 'building' };
      const started = await this.storage.compareAndSet(this.options.census, revision, progress);
      if (!started.applied) throw new Error('Owner census changed before rebuild');
      revision = started.revision!;
    }
    while (progress.status === 'backfill') {
      const page = await this.storage.scan({ prefix: this.options.prefix, cursor: progress.cursor, count: 50 });
      for (const [key, entry] of Object.entries(page.entries)) {
        if (!key.startsWith(this.options.prefix)) continue;
        if (!(await this.publish(key, entry.revision, entry.value)).applied)
          throw new Error('Owner record changed during census; resume the uncommitted page');
      }
      progress = { v: 1, status: page.cursor === '0' ? 'building' : 'backfill', cursor: page.cursor };
      const saved = await this.storage.compareAndSet(this.options.census, revision, progress);
      if (!saved.applied) throw new Error('Owner census changed concurrently');
      revision = saved.revision!;
    }
    for (const index of this.options.indexes) await this.storage.rebuildIndex(index);
    if (!(await this.storage.compareAndSet(this.options.census, revision, { ...progress, status: 'ready' })).applied)
      throw new Error('Owner census readiness changed concurrently');
  }

  async due(index: string, before: number, limit = 20): Promise<Readonly<Record<string, PluginStorageEntry>>> {
    if (!this.options.indexes.includes(index)) throw new Error('Owner index mismatch');
    await this.initialize(); assertWaitStorage(this.storage);
    const page = await this.storage.readDue({ index, before, limit });
    if (page.status !== 'ready') throw new Error('Owner recovery index is not_ready; explicit rebuild required');
    return page.entries;
  }
}
