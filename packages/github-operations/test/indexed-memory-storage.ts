import type { PluginStorageHost, PluginStorageProjection } from '@clowder-ai/plugin-sdk';

/** Test-only storage projection model. Persistence, Lua atomicity and actual read cost are checked against the real Host. */
export function withIndexedMemoryStorage<T extends PluginStorageHost>(storage: T): T {
  if (storage.compareAndSetIndexed && storage.readDue && storage.rebuildIndex) return storage;
  const projections = new Map<string, PluginStorageProjection>();
  const ready = new Set<string>();
  const indices = new Map<string, Array<{ key: string; score: number }>>();
  const cas = storage.compareAndSet.bind(storage), remove = storage.delete?.bind(storage);
  const project = (key: string, projection: PluginStorageProjection) => {
    const rows = indices.get(projection.index) ?? [];
    const old = rows.findIndex(row => row.key === key); if (old >= 0) rows.splice(old, 1);
    if (projection.score !== null) rows.push({ key, score: projection.score });
    rows.sort((a, b) => a.score - b.score || a.key.localeCompare(b.key)); indices.set(projection.index, rows);
  };
  Object.assign(storage, {
    compareAndSetIndexed: async (key: string, revision: number | null, value: unknown, projection: PluginStorageProjection) => {
      if (projections.has(key) && projections.get(key)!.index !== projection.index) throw new Error('index identity changed');
      const result = await cas(key, revision, value);
      if (result.applied && (await storage.get(key))?.revision === result.revision) {
        projections.set(key, structuredClone(projection)); project(key, projection);
      }
      return result;
    },
    readDue: async ({ index, before, limit }: { index: string; before: number; limit: number }) => {
      if (!ready.has(index)) return { status: 'not_ready' as const };
      const entries: Array<[string, NonNullable<Awaited<ReturnType<PluginStorageHost['get']>>>]> = [];
      for (const row of indices.get(index) ?? []) {
        if (row.score > before || entries.length >= limit) break;
        const entry = await storage.get(row.key); if (entry) entries.push([row.key, entry]);
      }
      return { status: 'ready' as const, version: 'test-projection', entries: Object.fromEntries(entries) };
    },
    rebuildIndex: async (index: string) => {
      indices.set(index, []);
      for (const [key, projection] of projections) if (projection.index === index && await storage.get(key)) project(key, projection);
      ready.add(index); return { status: 'ready' as const, version: 'test-projection' };
    },
    compareAndSet: async (key: string, revision: number | null, value: unknown) => {
      if (projections.has(key)) throw new Error('indexed_storage_projection_required');
      return cas(key, revision, value);
    },
    ...(remove ? { delete: async (key: string, revision?: number) => {
      const result = await remove(key, revision);
      if (result.deleted && projections.has(key)) { project(key, { ...projections.get(key)!, score: null }); projections.delete(key); }
      return result;
    } } : {}),
  } satisfies Partial<PluginStorageHost>);
  return storage;
}
