import { assertPluginOwnerThread, type PluginOwnerThread,
  type PluginOwnerThreadCreateInput, type PluginOwnerThreadAddParticipantsInput } from '@clowder-ai/plugin-contract';

export type { PluginOwnerThread, PluginOwnerThreadCreateInput, PluginOwnerThreadAddParticipantsInput } from '@clowder-ai/plugin-contract';

/** Host requires current authenticated owner webhook authority for every call.
 * Plugin binding, native context and generic accessible threads cannot substitute for ownership. */
export interface PluginOwnerThreadHost {
  get(threadId: string): Promise<PluginOwnerThread | null>;
  /** Ordinary create, not an idempotent ensure. Never automatically retry failed writes. */
  create(input: PluginOwnerThreadCreateInput): Promise<PluginOwnerThread>;
  addParticipants(input: PluginOwnerThreadAddParticipantsInput): Promise<PluginOwnerThread>;
}

function snapshot(value: unknown): PluginOwnerThread {
  assertPluginOwnerThread(value);
  return Object.freeze({ id: value.id, createdBy: value.createdBy, participants: Object.freeze([...value.participants]) });
}

/** Feature grant/lifecycle guard only; the Host port retains authentication and storage authority. */
export function createOwnerThreadClient(host: PluginOwnerThreadHost, assertActive: (capability: 'thread.listMetadata' | 'thread.write') => void): PluginOwnerThreadHost {
  if (!host || ['get', 'create', 'addParticipants'].some(method => typeof host[method as keyof PluginOwnerThreadHost] !== 'function')) {
    throw new TypeError('Host owner thread port requires all three methods');
  }
  return Object.freeze({
    async get(threadId: string) {
      assertActive('thread.listMetadata');
      const result = await host.get(threadId);
      assertActive('thread.listMetadata');
      return result === null ? null : snapshot(result);
    },
    async create(input: PluginOwnerThreadCreateInput) {
      assertActive('thread.write');
      const result = await host.create(input);
      assertActive('thread.write');
      return snapshot(result);
    },
    async addParticipants(input: PluginOwnerThreadAddParticipantsInput) {
      assertActive('thread.write');
      const result = await host.addParticipants(input);
      assertActive('thread.write');
      return snapshot(result);
    },
  });
}
