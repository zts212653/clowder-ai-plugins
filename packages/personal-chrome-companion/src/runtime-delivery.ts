import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { republishNativeHost } from '../native-host/install-host.mjs';
import { digestNativeHostArtifactDirectory } from '../native-host/native-host-artifact.mjs';
import { acquireProcessLease } from '../native-host/native-socket-lease.mjs';
import { extensionDigest, extensionFiles, replaceExtension } from './extension-delivery.js';
import { isPersonalChromeNotInstalled, readPersonalChromeAdapterOptions } from './pairing-record.js';
import { PERSONAL_CHROME_EXTENSION_REVISION, PERSONAL_CHROME_PAGE_ADAPTER_REVISION, type PersonalChromeRevisions } from './protocol.js';

export interface RuntimeDeliveryStatus {
  readonly extensionPath: string;
  readonly reloadRequired: boolean;
  readonly failure?: 'INSTALLATION_BUSY' | 'PERMISSION_DENIED' | 'INVALID_INSTALLATION' | 'DELIVERY_IO';
}
interface DeliveryRecord {
  generation: string;
  extensionDigest: string;
  helperDigest: string;
  reloadRequired: boolean;
}
export interface RuntimeDelivery {
  status(): RuntimeDeliveryStatus;
  label(): string;
  observe(revisions: PersonalChromeRevisions | undefined, errorCode?: string): Promise<void>;
  dispose(): Promise<void>;
}

function failureClass(error: unknown): NonNullable<RuntimeDeliveryStatus['failure']> {
  const { code, message } = error as { code?: string; message?: string };
  if (message?.includes('already has a live owner')) return 'INSTALLATION_BUSY';
  if (code === 'EACCES' || code === 'EPERM') return 'PERMISSION_DENIED';
  if (code === 'INVALID_CONFIGURATION') return 'INVALID_INSTALLATION';
  return 'DELIVERY_IO';
}

async function readRecord(path: string): Promise<DeliveryRecord | undefined> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.size > 4096) throw new Error('invalid delivery record');
    const value = JSON.parse(await readFile(path, 'utf8')) as DeliveryRecord;
    if (typeof value.generation !== 'string' || !/^[a-f0-9]{64}$/.test(value.extensionDigest) ||
        !/^sha512:[a-f0-9]{128}$/.test(value.helperDigest) || typeof value.reloadRequired !== 'boolean') {
      throw new Error('invalid delivery record');
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function writeRecord(path: string, value: DeliveryRecord): Promise<void> {
  const temporary = `${path}.${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

/** Only the Host-granted directory is writable. Package locations are read-only sources. */
export async function prepareRuntimeDelivery(dataDirectory: string, sources: {
  extensionDirectory?: string;
  nativeHostDirectory?: string;
} = {}): Promise<RuntimeDelivery> {
  const extensionPath = join(dataDirectory, 'extension');
  const recordPath = join(dataDirectory, 'delivery-reload.json');
  let record: DeliveryRecord | undefined;
  let failure: RuntimeDeliveryStatus['failure'];
  let disposed = false;
  let observationWork = Promise.resolve();
  try {
    await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    if (!(await lstat(dataDirectory)).isDirectory()) throw new Error('data directory must not be a symlink');
    await republishNativeHost({ dataDirectory, sourceDirectory: sources.nativeHostDirectory, activate: async (publish) => {
      const files = await extensionFiles(sources.extensionDirectory ?? fileURLToPath(new URL('../extension/', import.meta.url)));
      const digest = extensionDigest(files);
      let previousDigest: string | undefined;
      try { previousDigest = extensionDigest(await extensionFiles(extensionPath)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const helperDigest = await digestNativeHostArtifactDirectory(
        sources.nativeHostDirectory ?? fileURLToPath(new URL('../native-host/', import.meta.url)),
      );
      let installedDigest: string | undefined;
      try { installedDigest = (await readPersonalChromeAdapterOptions(dataDirectory)).helperArtifactRevision; }
      catch (error) { if (!isPersonalChromeNotInstalled(error)) failure = failureClass(error); }
      record = await readRecord(recordPath);
      const changed = previousDigest !== digest || (installedDigest !== undefined && installedDigest !== helperDigest);
      if (!record || record.extensionDigest !== digest || record.helperDigest !== helperDigest || changed) {
        record = { generation: randomUUID(), extensionDigest: digest, helperDigest,
          reloadRequired: changed || (record?.reloadRequired ?? false) };
        // Persist before changing bytes: a restart must not forget a pending owner action.
        await writeRecord(recordPath, record);
      }
      return previousDigest !== digest ? replaceExtension(dataDirectory, files, publish) : publish();
    } });
  } catch (error) { failure ??= failureClass(error); }

  let reloadRequired = record?.reloadRequired ?? false;
  const recordContact = async (revisions: PersonalChromeRevisions | undefined, errorCode?: string): Promise<void> => {
    const stale = errorCode?.startsWith('STALE_') === true;
    if (stale) reloadRequired = true;
    if (!record) return;
    const matched = revisions?.helper === record.helperDigest &&
      revisions.extension === PERSONAL_CHROME_EXTENSION_REVISION && revisions.pageAdapter === PERSONAL_CHROME_PAGE_ADAPTER_REVISION;
    if (!stale && (!matched || failure)) return;
    if (record.reloadRequired === stale) return;
    try {
      const lease = await acquireProcessLease(join(dataDirectory, 'install'), { label: 'native host installation' });
      try {
        const current = await readRecord(recordPath);
        if (current?.generation !== record.generation) return;
        const next = { ...record, reloadRequired: stale };
        await writeRecord(recordPath, next);
        record = next; reloadRequired = next.reloadRequired;
      } finally { await lease.release(); }
    } catch (error) {
      // Bookkeeping cannot change the result of an already-sent append.
      reloadRequired = true; failure = failureClass(error);
    }
  };
  const status = (): RuntimeDeliveryStatus => ({ extensionPath, reloadRequired,
    ...(failure ? { failure } : {}) });
  return {
    status,
    label: () => [
      failure ? `Delivery failed (${failure}); use Settings > Personal Chrome > Chrome connection to repair, then reactivate the plugin.` : '',
      reloadRequired ? 'Reload the extension once in chrome://extensions, then run Test.' : '',
    ].filter(Boolean).join(' '),
    observe: (revisions, errorCode) => {
      if (disposed) return Promise.resolve();
      // Preserve reply order across async disk writes; a later STALE reply must not be lost.
      observationWork = observationWork.then(() => recordContact(revisions, errorCode));
      return observationWork;
    },
    dispose: async () => { disposed = true; await observationWork; },
  };
}
