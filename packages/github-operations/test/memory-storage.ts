import type { PluginStorageHost } from '@clowder-ai/plugin-sdk';

export function memoryStorage(): PluginStorageHost {
  const entries = new Map<string, { revision: number; value: unknown }>();
  let revision = 0;
  return {
    get: async key => structuredClone(entries.get(key)),
    list: async () => structuredClone(Object.fromEntries(entries)),
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
