import type { OperationActionResult } from '@clowder-ai/plugin-contract';
import type { PluginActionHandler, PluginOwnerHttpContext } from '@clowder-ai/plugin-sdk';

const record = (x: unknown): Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : {};
const syncCodes = ['HELPER_UPDATE_REQUIRED', 'HELPER_NOT_INSTALLED', 'EXTENSION_RELOAD_REQUIRED', 'PAGE_RELOAD_REQUIRED',
  'STALE_HELPER', 'STALE_HELPER_PROTOCOL', 'CHROME_DISCONNECTED', 'TITLE_SYNC_TIMEOUT', 'AUTHORIZATION_INVALID', 'UNSUPPORTED_PLATFORM'];
function safeTitle(value: unknown): string {
  if (typeof value !== 'string' || value.length > 160 || /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(value)) return '';
  const title = value.trim().replace(/\s+/g, ' ');
  return /^(ChatGPT|New chat|新聊天)$/iu.test(title) ? '' : title;
}
function stamp(value: unknown): string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value ? value : '';
}
function candidates(rows: unknown) {
  const seen = new Set<string>();
  return (Array.isArray(rows) ? rows : []).flatMap(value => {
    const row = record(value), key = row.key;
    if (typeof key !== 'string' || !/^[a-zA-Z0-9-]+$/.test(key) || seen.has(key)) return [];
    const authorized = stamp(row.authorizedAt), updated = stamp(row.updatedAt);
    if (authorized && updated && updated < authorized) return [];
    seen.add(key);
    return [{ chatUrl: 'https://chatgpt.com/c/' + key, displayTitle: row.label === key ? '' : safeTitle(row.label) }];
  });
}
function connectionIssue(value: unknown) {
  const status = record(value), helper = record(status.helper).state, delivery = record(status.delivery);
  if (helper === 'not_installed') return 'HELPER_NOT_INSTALLED';
  if (helper === 'invalid_installation' || ['INVALID_INSTALLATION', 'PERMISSION_DENIED', 'DELIVERY_IO'].includes(String(delivery.failure))) return 'HELPER_UPDATE_REQUIRED';
  if (delivery.reloadRequired === true) return 'EXTENSION_RELOAD_REQUIRED';
  if (delivery.pageReloadRequired === true) return 'PAGE_RELOAD_REQUIRED';
  return helper === 'unreachable' ? 'CHROME_DISCONNECTED' : '';
}
function titleSyncOf(value: unknown) {
  if (!value) return null;
  const sync = record(value);
  if (sync.status === 'unavailable') return { kind: syncCodes.includes(String(sync.errorCode)) ? sync.errorCode : 'failed' };
  const n = sync.updatedCount, of = sync.requestedCount;
  if (sync.status !== 'synced' || typeof n !== 'number' || typeof of !== 'number' || !Number.isInteger(n) || !Number.isInteger(of) || n < 0 || n > of || of > 32) return null;
  return { kind: n === 0 ? 'none' : n < of ? 'partial' : 'all', n };
}

export function personalChromeRecovery(item: Record<string, unknown>, rows: unknown, status: unknown, sync: unknown, picked?: string) {
  const list = candidates(rows), authorized = (url: unknown) => list.some(c => c.chatUrl === url);
  const bound = !!item.bindOnly && authorized(item.boundChatUrl);
  const value = authorized(picked) ? picked : authorized(item.boundChatUrl) ? item.boundChatUrl : list.length === 1 ? list[0]!.chatUrl : '';
  const issue = connectionIssue(status), args = record(item.args);
  return {
    key: item.key, selectId: 'pc-recovery-' + item.key, candidates: list, value,
    only: list.length === 1 && !bound ? list[0] : null,
    canChoose: list.length > 1 && !bound && !!item.canSubmit, bound, bindOnly: !!item.bindOnly,
    connectionIssue: issue, titleSync: titleSyncOf(sync), settings: { page: 'extItem-official.companion.personal-chrome' },
    canSubmit: !!item.canSubmit && !bound && !!value && !(args.attemptId && issue),
    submit: { ...args, chatUrl: value },
  };
}

/** Recovery card state belongs to this active plugin generation, partitioned by authenticated owner. */
export function createPersonalChromeConsole(options: {
  pluginInstanceId: string;
  list(): Promise<OperationActionResult>;
  status(): Promise<OperationActionResult>;
  refreshTitles(): Promise<unknown>;
}): PluginActionHandler {
  const owners = new Map<string, { picks: Map<string, string>; titleSync: unknown }>();
  return async (input, native, caller) => {
    if (native || caller?.kind !== 'owner-http-request' || caller.pluginInstanceId !== options.pluginInstanceId)
      throw new Error('Personal Chrome owner HTTP context required');
    const context = caller as PluginOwnerHttpContext;
    const current = async () => { context.signal.throwIfAborted(); await context.assertCurrent(); };
    await current();
    const request = record(record(input).request), body = record(request.body);
    const json = (status: number, value: unknown) => ({ status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: value });
    if (request.method !== 'POST') return json(405, { error: 'Console routes require POST' });
    const paths = ['recovery', 'pick', 'refresh', 'refresh-titles'].map(p => 'personal-chrome/' + p);
    if (!paths.includes(String(request.path))) return json(404, { error: 'Undeclared console route' });
    if (context.operation !== 'write') throw new Error('Personal Chrome owner write context required');
    const owner = owners.get(context.userId) ?? { picks: new Map<string, string>(), titleSync: null };
    owners.set(context.userId, owner);
    if (request.path === 'personal-chrome/recovery') {
      if (typeof body.key !== 'string' || !body.key) return json(400, { error: 'Card key required' });
      const list = await options.list();
      // A failed health read cannot revoke a readable authorization list.
      const status = await options.status().catch(() => null);
      await current();
      return json(200, personalChromeRecovery(body, record(list.data).rows, status?.data, owner.titleSync, owner.picks.get(body.key)));
    }
    if (request.path === 'personal-chrome/pick') {
      if (typeof body.key !== 'string' || !body.key || typeof body.value !== 'string') return json(400, { error: 'Card selection required' });
      await current();
      owner.picks.set(body.key, body.value);
    } else if (request.path === 'personal-chrome/refresh') owner.titleSync = null;
    else {
      let sync: unknown;
      try { sync = await options.refreshTitles(); }
      catch { sync = { status: 'unavailable', errorCode: 'AMBIGUOUS_EFFECT' }; }
      await current();
      owner.titleSync = sync;
    }
    return json(200, { ok: true });
  };
}
