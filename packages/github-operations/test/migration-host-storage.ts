import type { PluginStorageHost, PluginStorageEntry } from '@clowder-ai/plugin-sdk';

// Independent in-memory Host fixture; production import never receives this class.
export class IsolatedStorage implements PluginStorageHost {
  private readonly rows = new Map<string, PluginStorageEntry>();
  private revision = 0;
  async get(k: string) { return structuredClone(this.rows.get(k)); }
  async list() { return structuredClone(Object.fromEntries(this.rows)); }
  async set(k: string, value: unknown) {
    this.rows.set(k, { revision: ++this.revision, value: structuredClone(value) });
    return { revision: this.revision };
  }
  async compareAndSet(k: string, expected: number | null, value: unknown) {
    if ((this.rows.get(k)?.revision ?? null) !== expected) return { applied: false };
    return { applied: true, ...await this.set(k, value) };
  }
  async delete(k: string, expected?: number) {
    const row = this.rows.get(k);
    if (!row || (expected !== undefined && expected !== row.revision)) return { deleted: false };
    this.rows.delete(k); return { deleted: true, revision: ++this.revision };
  }
}
