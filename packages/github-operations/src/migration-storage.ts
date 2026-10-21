import type { PluginStorageEntry, PluginStorageHost } from '@clowder-ai/plugin-sdk';

/** Local planning only. The planner validates the whole batch before any Host write. */
export class PlanningStorage implements PluginStorageHost {
  private readonly values = new Map<string, PluginStorageEntry>();
  private revision = 0;
  async get(key: string) { return structuredClone(this.values.get(key)); }
  async list() { return structuredClone(Object.fromEntries(this.values)); }
  async set(key: string, value: unknown) {
    this.values.set(key, { revision: ++this.revision, value: structuredClone(value) }); return { revision: this.revision };
  }
  async compareAndSet(key: string, expected: number | null, value: unknown) {
    if ((this.values.get(key)?.revision ?? null) !== expected) return { applied: false };
    return { applied: true, ...await this.set(key, value) };
  }
  async delete(key: string, revision?: number) {
    const row = this.values.get(key);
    if (!row || revision !== undefined && row.revision !== revision) return { deleted: false };
    this.values.delete(key); return { deleted: true };
  }
}
