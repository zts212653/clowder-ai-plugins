import type { PluginStorageHost } from './module-host.js';
import { createConnectorPermissionStore } from './connector-permissions.js';

function inputOf(params: unknown): Record<string, unknown> {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) throw new TypeError('permission action requires input');
  const input = (params as Record<string, unknown>).input;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('permission action requires input');
  return input as Record<string, unknown>;
}

/** The Host's existing owner-local operation carries merged stored config in
 * params.input. This wrapper selects the protocol envelope; the closed helper
 * still rejects malformed snapshots and never trusts an input owner claim. */
export function createConnectorPermissionActions(storage: PluginStorageHost) {
  const store = createConnectorPermissionStore(storage);
  type OwnerFormState = { revision: number; value: Awaited<ReturnType<typeof store.get>>; recoveryRequired?: boolean };
  const form = (current: OwnerFormState | undefined) => {
    // This is an uncommitted form template, not an activation policy. Only the
    // owner-confirmed configure action may publish it through insert-only CAS.
    if (current === undefined) return { permissionRevision: 'new', permissionWhitelistEnabled: 'false',
      permissionCommandAdminOnly: 'false', permissionAdminIdsJson: '[]', permissionGroupsJson: '[]' };
    return { permissionRevision: String(current.revision), permissionWhitelistEnabled: String(current.value.whitelistEnabled),
      permissionCommandAdminOnly: String(current.value.commandAdminOnly), permissionAdminIdsJson: JSON.stringify(current.value.adminOpenIds),
      // A blank field is deliberately invalid, not an empty whitelist default.
      // Recovery requires the owner to explicitly choose a bounded replacement.
      permissionGroupsJson: current.recoveryRequired ? '' : JSON.stringify(current.value.allowedGroups.map(({ externalChatId, label }) =>
        ({ externalChatId, ...(label === undefined ? {} : { label }) }))) };
  };
  return {
    'permissions.read': async (_params: unknown) => {
      const current = await store.readForOwner();
      return { render: 'status' as const,
        data: { status: current === undefined ? 'uninitialized' : current.recoveryRequired ? 'recovery_required' : 'configured',
          adminCount: current?.value.adminOpenIds.length ?? 0, groupCount: current?.value.allowedGroups.length ?? 0 },
        label: current === undefined ? '尚未初始化；读取不会启用权限。请明确确认并应用设置。' : current.recoveryRequired
          ? '旧白名单超过 5000 群，路由已拒绝；未截断或重置。请明确填写至多 5000 群的替代白名单，再确认应用。'
          : '已读取当前权限；应用前请检查管理员和群白名单。',
        targetValues: form(current) };
    },
    'permissions.configure': async (params: unknown) => {
      const input = inputOf(params);
      const names = ['permissionRevision', 'permissionWhitelistEnabled', 'permissionCommandAdminOnly', 'permissionAdminIdsJson', 'permissionGroupsJson'] as const;
      const selected = Object.fromEntries(names.map(name => [name, input[name]]));
      if (names.some(name => typeof selected[name] !== 'string') || Buffer.byteLength(JSON.stringify(selected), 'utf8') > 256 * 1024) {
        throw new TypeError('complete bounded permission form required; read current permissions first');
      }
      const flag = (name: string) => {
        if (selected[name] !== 'true' && selected[name] !== 'false') throw new TypeError('invalid permission flag');
        return selected[name] === 'true';
      };
      const revision = selected.permissionRevision as string;
      if (revision !== 'new' && !/^[1-9][0-9]*$/.test(revision)) throw new TypeError('invalid permission revision');
      const current = await store.configure({ expectedRevision: revision === 'new' ? null : Number(revision),
        whitelistEnabled: flag('permissionWhitelistEnabled'), commandAdminOnly: flag('permissionCommandAdminOnly'),
        adminOpenIds: JSON.parse(selected.permissionAdminIdsJson as string), allowedGroups: JSON.parse(selected.permissionGroupsJson as string) });
      return { render: 'status' as const, data: { status: 'configured', stateRevision: current.revision,
        adminCount: current.value.adminOpenIds.length, groupCount: current.value.allowedGroups.length },
        label: '权限已应用；后续旧权限导入不会覆盖。', targetValues: form(current) };
    },
    'permissions.importLegacy': async (params: unknown) => {
      const source = inputOf(params);
      return store.importLegacy({ protocolVersion: source.protocolVersion, sourceDigest: source.sourceDigest, snapshot: source.snapshot });
    },
  };
}
