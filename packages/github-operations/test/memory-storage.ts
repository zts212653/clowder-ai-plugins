import type { PluginStorageEntry, PluginStorageHost, PluginStorageScanInput } from '@clowder-ai/plugin-sdk';

/** In-memory paging for test adapters; production callers never use a full-list shim. */
export function scanMemory(entries: ReadonlyMap<string, PluginStorageEntry>, input: PluginStorageScanInput) {
  const selected = [...entries].filter(([key]) => key.startsWith(input.prefix)
    && (input.suffix === undefined || key.endsWith(input.suffix)));
  const start = Number(input.cursor ?? '0');
  const stop = Math.min(selected.length, start + (input.count ?? 50));
  return { cursor: stop === selected.length ? '0' : String(stop),
    entries: structuredClone(Object.fromEntries(selected.slice(start, stop))) };
}

export function memoryStorage(): PluginStorageHost {
  const entries = new Map<string, { revision: number; value: unknown }>();
  let revision = 0;
  return {
    get: async key => structuredClone(entries.get(key)),
    list: async () => structuredClone(Object.fromEntries(entries)),
    scan: async input => scanMemory(entries, input),
    set: async (key, value) => { entries.set(key, { revision: ++revision, value: structuredClone(value) }); return { revision }; },
    compareAndSet: async (key, expected, value) => {
      if ((entries.get(key)?.revision ?? null) !== expected) return { applied: false };
      entries.set(key, { revision: ++revision, value: structuredClone(value) }); return { applied: true, revision };
    },
    delete: async (key, expected) => {
      if (expected !== undefined && entries.get(key)?.revision !== expected) return { deleted: false };
      return { deleted: entries.delete(key) };
    },
  };
}
