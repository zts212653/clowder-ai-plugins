import type { PluginStorageHost } from './module-host.js';
import { CONNECTOR_COMMAND_DECLARATIONS } from './connector-command-format.js';
import { createHash } from 'node:crypto';
import { canonicalJson } from './feature-context.js';

const KEY = 'connector.permissions.v1';
const ATTEMPTS = 8;
const GROUP_LIMIT = 5000;
export type ConnectorCommandName = 'where' | 'new' | 'threads' | 'use' | 'thread' | 'commands' | 'cats' | 'status' |
  'history' | 'unbind' | 'allow-group' | 'deny-group' | 'focus' | 'ask';
export interface ConnectorPermissions {
  readonly v: 1;
  readonly whitelistEnabled: boolean;
  readonly commandAdminOnly: boolean;
  /** An explicitly empty persisted admin list must not be reseeded. */
  readonly adminConfigured: boolean;
  readonly adminOpenIds: readonly string[];
  readonly allowedGroups: readonly { readonly externalChatId: string; readonly label?: string; readonly addedAt: number }[];
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('permissions must be an object');
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new TypeError('unknown permission field');
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 500) throw new TypeError('invalid permission identity');
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new TypeError('invalid permission flag');
  return value;
}
function admins(value: unknown): string[] {
  if (!Array.isArray(value)) throw new TypeError('adminOpenIds must be an array');
  const result = value.map(id);
  if (new Set(result).size !== result.length) throw new TypeError('duplicate admin identity');
  return result;
}
function group(value: unknown) {
  const data = record(value);
  keys(data, ['externalChatId', 'label', 'addedAt']);
  if (typeof data.addedAt !== 'number' || !Number.isSafeInteger(data.addedAt) || data.addedAt < 0) throw new TypeError('invalid group timestamp');
  if (data.label !== undefined && typeof data.label !== 'string') throw new TypeError('invalid group label');
  return { externalChatId: id(data.externalChatId), ...(data.label === undefined ? {} : { label: data.label }), addedAt: data.addedAt };
}
// Only the explicit owner recovery path may inspect a structurally valid old
// oversized policy. Runtime reads and every published replacement stay bounded.
function validateShape(value: unknown): ConnectorPermissions {
  const data = record(value);
  if (data.v !== 1 || !Array.isArray(data.allowedGroups)) throw new TypeError('invalid permission state');
  const allowedGroups = data.allowedGroups.map(group);
  if (new Set(allowedGroups.map(g => g.externalChatId)).size !== allowedGroups.length) throw new TypeError('duplicate allowed group');
  const adminOpenIds = admins(data.adminOpenIds);
  const adminConfigured = boolean(data.adminConfigured);
  if (!adminConfigured && adminOpenIds.length) throw new TypeError('unconfigured admins must be empty');
  return { v: 1, whitelistEnabled: boolean(data.whitelistEnabled), commandAdminOnly: boolean(data.commandAdminOnly),
    adminConfigured, adminOpenIds, allowedGroups };
}

function validate(value: unknown): ConnectorPermissions {
  const data = record(value);
  if (Array.isArray(data.allowedGroups) && data.allowedGroups.length > GROUP_LIMIT) {
    throw new TypeError('permission state exceeds group bound; owner recovery required');
  }
  return validateShape(value);
}

/** Decode an offline export of the two legacy Redis hashes; never connects to Redis. */
export function decodeLegacyConnectorPermissions(value: unknown): ConnectorPermissions {
  const snapshot = record(value);
  const config = record(snapshot.config);
  const groups = record(snapshot.groups);
  keys(snapshot, ['config', 'groups']);
  keys(config, ['whitelistEnabled', 'commandAdminOnly', 'adminOpenIds']);
  const flag = (key: string): boolean => {
    if (config[key] === undefined) return false; // Legacy store's absent-field semantics.
    if (config[key] !== 'true' && config[key] !== 'false') throw new TypeError(`invalid legacy ${key}`);
    return config[key] === 'true';
  };
  const adminConfigured = Object.hasOwn(config, 'adminOpenIds');
  if (adminConfigured && typeof config.adminOpenIds !== 'string') throw new TypeError('invalid legacy admins');
  return validate({ v: 1, whitelistEnabled: flag('whitelistEnabled'), commandAdminOnly: flag('commandAdminOnly'),
    adminConfigured, adminOpenIds: adminConfigured ? JSON.parse(config.adminOpenIds as string) : [],
    allowedGroups: Object.entries(groups).map(([externalChatId, serialized]) => {
      if (typeof serialized !== 'string') throw new TypeError('invalid legacy group');
      const stored = record(JSON.parse(serialized));
      keys(stored, ['label', 'addedAt']);
      return { ...stored, externalChatId };
    }),
  });
}

function legacyImport(value: unknown) {
  const input = record(value);
  keys(input, ['protocolVersion', 'sourceDigest', 'snapshot']);
  if (input.protocolVersion !== 1 || typeof input.sourceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(input.sourceDigest)) {
    throw new TypeError('invalid permission import protocol');
  }
  if (Buffer.byteLength(JSON.stringify(input), 'utf8') > 256 * 1024) throw new TypeError('permission import exceeds size bound');
  const snapshot = record(input.snapshot);
  const config = record(snapshot.config);
  const groups = record(snapshot.groups);
  if (Object.keys(groups).length > GROUP_LIMIT) throw new TypeError('permission import exceeds group bound');
  for (const hash of [config, groups]) {
    if (Object.values(hash).some(entry => typeof entry !== 'string')) throw new TypeError('legacy hash values must be strings');
  }
  const permissions = decodeLegacyConnectorPermissions(snapshot);
  const digest = createHash('sha256').update(canonicalJson(snapshot), 'utf8').digest('hex');
  if (digest !== input.sourceDigest) throw new TypeError('permission snapshot digest mismatch');
  return { permissions, sourceDigest: digest, settingsFieldCount: Object.keys(config).length, groupCount: Object.keys(groups).length };
}

/** Storage is already scoped to this plugin instance by the Host. No global connector keys. */
export function createConnectorPermissionStore(storage: PluginStorageHost) {
  const get = async (): Promise<ConnectorPermissions> => {
    const entry = await storage.get(KEY);
    if (entry === undefined) throw new Error('connector permissions not initialized');
    return validate(entry.value);
  };
  const change = async (update: (value: ConnectorPermissions) => ConnectorPermissions) => {
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const entry = await storage.get(KEY);
      if (entry === undefined) throw new Error('connector permissions not initialized');
      const next = validate(update(validate(entry.value)));
      if ((await storage.compareAndSet(KEY, entry.revision, next)).applied) return next;
    }
    throw new Error('connector permission storage contention');
  };
  return {
    get,
    async readForOwner() {
      const entry = await storage.get(KEY);
      if (entry === undefined) return undefined;
      const value = validateShape(entry.value);
      return { revision: entry.revision, value, recoveryRequired: value.allowedGroups.length > GROUP_LIMIT };
    },
    /** Explicit owner-local replacement, fenced to the revision displayed on
     * the card. Concurrent command mutations require a reload, never a retry
     * that silently overwrites a newer policy. */
    async configure(value: unknown, now = Date.now()) {
      const data = record(value);
      keys(data, ['expectedRevision', 'whitelistEnabled', 'commandAdminOnly', 'adminOpenIds', 'allowedGroups']);
      const expected = data.expectedRevision;
      if (expected !== null && (typeof expected !== 'number' || !Number.isSafeInteger(expected) || expected < 1)) {
        throw new TypeError('invalid permission revision');
      }
      if (!Array.isArray(data.allowedGroups) || data.allowedGroups.length > GROUP_LIMIT) throw new TypeError('invalid owner groups');
      const groups = data.allowedGroups.map(value => {
        const item = record(value); keys(item, ['externalChatId', 'label']);
        if (item.label !== undefined && typeof item.label !== 'string') throw new TypeError('invalid group label');
        return { externalChatId: id(item.externalChatId), ...(item.label === undefined ? {} : { label: item.label }) };
      });
      const current = await storage.get(KEY);
      // Validate corrupt state even when the caller presents a stale revision.
      // An explicit revision-fenced owner replacement is the sole recovery for
      // oversized old state. Keep existing timestamps; never truncate on read,
      // reset during activation, or let command mutations bypass the bound.
      const previous = current === undefined ? undefined : validateShape(current.value);
      if ((current?.revision ?? null) !== expected) throw new Error('permissions changed; reload current permissions');
      const initial = validate({ v: 1, whitelistEnabled: data.whitelistEnabled, commandAdminOnly: data.commandAdminOnly,
        adminConfigured: true, adminOpenIds: data.adminOpenIds,
        allowedGroups: groups.map(item => ({ ...item,
          addedAt: previous?.allowedGroups.find(g => g.externalChatId === item.externalChatId)?.addedAt ?? now })) });
      const result = await storage.compareAndSet(KEY, expected as number | null, initial);
      if (!result.applied) throw new Error('permissions changed; reload current permissions');
      if (result.revision === undefined) throw new Error('configured permission receipt is missing storage revision');
      return { revision: result.revision, value: initial };
    },
    /** Invoked only by the declared owner-local operation. No payload identity authorizes this call. */
    async importLegacy(value: unknown) {
      const input = legacyImport(value);
      const receipt = (status: 'imported' | 'already_applied' | 'preserved_existing', stateRevision: number) => ({
        render: 'status' as const,
        data: { status, protocolVersion: 1 as const, sourceDigest: input.sourceDigest, stateRevision,
          settingsFieldCount: input.settingsFieldCount, groupCount: input.groupCount },
      });
      for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
        const current = await storage.get(KEY);
        if (current !== undefined) {
          validate(current.value); // Corruption is not a successful preservation receipt.
          const same = record(current.value).legacySourceDigest === input.sourceDigest;
          return receipt(same ? 'already_applied' : 'preserved_existing', current.revision);
        }
        // The marker and initial permissions share a single CAS. Owner changes strip
        // the marker via validate(), so later imports cannot overwrite or mislabel them.
        const result = await storage.compareAndSet(KEY, null, { ...input.permissions, legacySourceDigest: input.sourceDigest });
        if (result.applied) {
          if (result.revision === undefined) throw new Error('permission import receipt is missing storage revision');
          return receipt('imported', result.revision);
        }
      }
      throw new Error('connector permission storage contention');
    },
    async initialize(value: ConnectorPermissions): Promise<ConnectorPermissions> {
      const initial = validate(value);
      for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
        const current = await storage.get(KEY);
        if (current !== undefined) return validate(current.value); // Never overwrite owner changes on re-import.
        if ((await storage.compareAndSet(KEY, null, initial)).applied) return initial;
      }
      throw new Error('connector permission storage contention');
    },
    async allowGroup(externalChatId: string, label?: string, addedAt = Date.now()) {
      const item = group({ externalChatId, label, addedAt });
      return change(value => ({ ...value, allowedGroups: [...value.allowedGroups.filter(g => g.externalChatId !== item.externalChatId), item] }));
    },
    async denyGroup(externalChatId: string) {
      const key = id(externalChatId);
      let removed = false;
      await change(value => {
        removed = value.allowedGroups.some(g => g.externalChatId === key);
        return { ...value, allowedGroups: value.allowedGroups.filter(g => g.externalChatId !== key) };
      });
      return removed;
    },
  };
}

export function parseConnectorCommand(text: string): { name: ConnectorCommandName; args: string } | null {
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  const name = match[1]!.toLowerCase();
  return CONNECTOR_COMMAND_DECLARATIONS.some(command => command.name === name) ? { name: name as ConnectorCommandName, args: match[2] ?? '' } : null;
}

/** Must run before thread creation, media retention, or ordinary messaging.send. */
export function evaluateConnectorPermission(
  value: ConnectorPermissions,
  input: { readonly chatId: string; readonly group: boolean; readonly senderId?: string | undefined; readonly text: string },
): 'allowed' | 'group_not_allowed' | 'command_admin_only' {
  const config = validate(value);
  if (!input.group) return 'allowed';
  const admin = input.senderId !== undefined && config.adminOpenIds.includes(input.senderId);
  const allowBypass = parseConnectorCommand(input.text)?.name === 'allow-group' && admin;
  if (config.whitelistEnabled && !allowBypass && !config.allowedGroups.some(g => g.externalChatId === input.chatId)) return 'group_not_allowed';
  if (config.commandAdminOnly && input.text.trim().startsWith('/') && !admin) return 'command_admin_only';
  return 'allowed';
}
