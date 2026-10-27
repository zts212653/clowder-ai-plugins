import { randomUUID } from 'node:crypto';
import { lstat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { republishNativeHost } from '../native-host/install-host.mjs';
import { digestNativeHostArtifactDirectory } from '../native-host/native-host-artifact.mjs';
import { extensionDigest, extensionFiles, replaceExtension } from './extension-delivery.js';
import { isPersonalChromeNotInstalled, readPersonalChromeAdapterOptions } from './pairing-record.js';
import { failureClass, monitorRuntimeDelivery, readDeliveryRecord, writeDeliveryRecord, type DeliveryRecord, type RuntimeDelivery, type RuntimeDeliveryStatus } from './runtime-delivery-state.js';
export type { RuntimeDelivery, RuntimeDeliveryStatus } from './runtime-delivery-state.js';

/** Only the Host-granted directory is writable. Package locations are read-only sources. */
export async function prepareRuntimeDelivery(dataDirectory: string, sources: {
  extensionDirectory?: string;
  nativeHostDirectory?: string;
} = {}): Promise<RuntimeDelivery> {
  const extensionPath = join(dataDirectory, 'extension');
  const recordPath = join(dataDirectory, 'delivery-reload.json');
  let record: DeliveryRecord | undefined;
  let failure: RuntimeDeliveryStatus['failure'];
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
      record = await readDeliveryRecord(recordPath);
      const changed = previousDigest !== digest || (installedDigest !== undefined && installedDigest !== helperDigest);
      if (!record || record.extensionDigest !== digest || record.helperDigest !== helperDigest || changed) {
        record = { generation: randomUUID(), extensionDigest: digest, helperDigest,
          reloadRequired: changed || (record?.reloadRequired ?? false),
          ...(record?.pageReloadConversationIds?.length ? { pageReloadConversationIds: record.pageReloadConversationIds } : {}) };
        // Persist before changing bytes: a restart must not forget a pending owner action.
        await writeDeliveryRecord(recordPath, record);
      }
      return previousDigest !== digest ? replaceExtension(dataDirectory, files, publish) : publish();
    } });
  } catch (error) { failure ??= failureClass(error); }

  return monitorRuntimeDelivery(dataDirectory, { record, failure });
}
