import { assertPluginMember, type PluginMember } from '@clowder-ai/plugin-contract';
export type { PluginMember } from '@clowder-ai/plugin-contract';
/** One Host registry; packages keep their own business selection and bindings. */
export interface PluginMemberHost {
  list(): Promise<readonly PluginMember[]>;
  get(catId: string): Promise<PluginMember | null>;
}
export function createMemberClient(host: PluginMemberHost, assertActive: () => void): PluginMemberHost {
  if (!host || typeof host.list !== 'function' || typeof host.get !== 'function') throw new TypeError('Host members port requires list/get');
  const snapshot = (value: unknown): PluginMember => {
    assertPluginMember(value);
    return Object.freeze(structuredClone(value));
  };
  return Object.freeze({
    async list() {
      assertActive(); const rows = await host.list(); assertActive();
      if (!Array.isArray(rows)) throw new TypeError('Invalid Host members');
      return Object.freeze(rows.map(snapshot));
    },
    async get(catId: string) {
      assertActive();
      if (typeof catId !== 'string' || !catId || catId.trim() !== catId) throw new TypeError('Invalid member id');
      const value = await host.get(catId); assertActive();
      if (value === null) return null;
      const row = snapshot(value);
      if (row.catId !== catId) throw new TypeError('Host returned another member');
      return row;
    },
  });
}
