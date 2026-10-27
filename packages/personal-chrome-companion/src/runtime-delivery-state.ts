import { randomUUID } from 'node:crypto';
import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isPersonalChromeConversationId } from '../native-host/conversation-binding.mjs';
import { acquireProcessLease } from '../native-host/native-socket-lease.mjs';
import { PERSONAL_CHROME_EXTENSION_REVISION, PERSONAL_CHROME_PAGE_ADAPTER_REVISION, type PersonalChromeRevisions } from './protocol.js';

export interface RuntimeDeliveryStatus {
  readonly extensionPath: string;
  readonly reloadRequired: boolean;
  readonly pageReloadRequired?: boolean;
  readonly failure?: 'INSTALLATION_BUSY' | 'PERMISSION_DENIED' | 'INVALID_INSTALLATION' | 'DELIVERY_IO';
}
export interface DeliveryRecord {
  generation: string;
  extensionDigest: string;
  helperDigest: string;
  reloadRequired: boolean;
  pageReloadConversationIds?: readonly string[];
}
export interface RuntimeDelivery {
  status(): RuntimeDeliveryStatus;
  label(): string;
  observe(revisions: PersonalChromeRevisions | undefined, errorCode?: string, conversationId?: string): Promise<void>;
  forgetConversation(conversationId: string): Promise<void>;
  dispose(): Promise<void>;
}

export function failureClass(error: unknown): NonNullable<RuntimeDeliveryStatus['failure']> {
  const { code, message } = error as { code?: string; message?: string };
  if (message?.includes('already has a live owner')) return 'INSTALLATION_BUSY';
  if (code === 'EACCES' || code === 'EPERM') return 'PERMISSION_DENIED';
  if (code === 'INVALID_CONFIGURATION') return 'INVALID_INSTALLATION';
  return 'DELIVERY_IO';
}

export async function readDeliveryRecord(path: string): Promise<DeliveryRecord | undefined> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.size > 16384) throw new Error('invalid delivery record');
    const value = JSON.parse(await readFile(path, 'utf8')) as DeliveryRecord;
    const targets = value.pageReloadConversationIds;
    if (typeof value.generation !== 'string' || !/^[a-f0-9]{64}$/.test(value.extensionDigest) ||
        !/^sha512:[a-f0-9]{128}$/.test(value.helperDigest) || typeof value.reloadRequired !== 'boolean' ||
        (targets !== undefined && (!Array.isArray(targets) || targets.length > 32 ||
          !targets.every(isPersonalChromeConversationId) || new Set(targets).size !== targets.length))) {
      throw new Error('invalid delivery record');
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function writeDeliveryRecord(path: string, value: DeliveryRecord): Promise<void> {
  const temporary = `${path}.${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

/** Bookkeeping only: also used by loaded Settings without preparing or activating runtime resources. */
export function monitorRuntimeDelivery(dataDirectory: string, initial: {
  record?: DeliveryRecord; failure?: RuntimeDeliveryStatus['failure'];
}): RuntimeDelivery {
  const recordPath = join(dataDirectory, 'delivery-reload.json');
  let { record, failure } = initial;
  let disposed = false;
  let forceReload = false;
  let observationWork = Promise.resolve();
  const update = async (change: (current: DeliveryRecord) => DeliveryRecord): Promise<void> => {
    if (!record) return;
    try {
      const lease = await acquireProcessLease(join(dataDirectory, 'install'), { label: 'native host installation' });
      try {
        const current = await readDeliveryRecord(recordPath);
        if (current?.generation !== record.generation) return;
        const next = change(current);
        if (JSON.stringify(next) !== JSON.stringify(current)) await writeDeliveryRecord(recordPath, next);
        record = next;
      } finally { await lease.release(); }
    } catch (error) {
      // Bookkeeping cannot change the result of an already-sent append.
      forceReload = true; failure = failureClass(error);
    }
  };
  const enqueue = (work: () => Promise<void>) => {
    if (disposed) return Promise.resolve();
    observationWork = observationWork.then(work);
    return observationWork;
  };
  const status = (): RuntimeDeliveryStatus => ({
    extensionPath: join(dataDirectory, 'extension'), reloadRequired: forceReload || (record?.reloadRequired ?? false),
    ...(record?.pageReloadConversationIds?.length ? { pageReloadRequired: true } : {}),
    ...(failure ? { failure } : {}),
  });
  return {
    status,
    label: () => [
      failure ? `Delivery failed (${failure}); use Settings > Personal Chrome > Chrome connection to repair, then reactivate the plugin.` : '',
      status().reloadRequired ? 'Reload the extension once in chrome://extensions, then run Test.' : '',
      status().pageReloadRequired ? 'Reload the affected ChatGPT conversation page, then use its Check conversation page action. Global Test checks the connection only.' : '',
    ].filter(Boolean).join(' '),
    observe: (revisions, errorCode, conversationId) => enqueue(() => update((current) => {
      const stale = errorCode?.startsWith('STALE_') === true;
      const connected = revisions?.helper === current.helperDigest && revisions.extension === PERSONAL_CHROME_EXTENSION_REVISION;
      const matched = connected && revisions.pageAdapter === PERSONAL_CHROME_PAGE_ADAPTER_REVISION;
      const connectionOnly = connected && revisions.pageAdapter === 'unobserved' &&
        ['CONVERSATION_NOT_SELECTED', 'BOUND_TAB_NOT_FOUND', 'AMBIGUOUS_BOUND_TABS'].includes(errorCode ?? '');
      let reloadRequired = current.reloadRequired;
      const targets = new Set(current.pageReloadConversationIds);
      if (stale) {
        if (errorCode === 'STALE_PAGE_ADAPTER' && isPersonalChromeConversationId(conversationId)) {
          targets.add(conversationId);
          if (targets.size > 32) throw new Error('too many stale conversation pages');
        } else reloadRequired = true;
      } else if (!failure && (matched || connectionOnly)) {
        reloadRequired = false;
        if (matched && conversationId !== undefined) targets.delete(conversationId);
      }
      return { ...current, reloadRequired,
        pageReloadConversationIds: targets.size ? [...targets].sort() : undefined };
    })),
    forgetConversation: (conversationId) => enqueue(() => update((current) => {
      const targets = current.pageReloadConversationIds?.filter((id) => id !== conversationId);
      return { ...current, pageReloadConversationIds: targets?.length ? targets : undefined };
    })),
    dispose: async () => { disposed = true; await observationWork; },
  };
}

export async function readRuntimeDelivery(dataDirectory: string): Promise<RuntimeDelivery> {
  try { return monitorRuntimeDelivery(dataDirectory, { record: await readDeliveryRecord(join(dataDirectory, 'delivery-reload.json')) }); }
  catch (error) { return monitorRuntimeDelivery(dataDirectory, { failure: failureClass(error) }); }
}
