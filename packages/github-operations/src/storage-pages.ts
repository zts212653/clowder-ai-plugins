import type { PluginStorageEntry, PluginStorageHost } from '@clowder-ai/plugin-sdk';

type ReadOptions = { readonly signal?: AbortSignal; readonly suffix?: string };

/** Package-owned reads over one namespace; never fall back to the complete private database. */
export async function* storagePages(
  storage: PluginStorageHost,
  prefix: string,
  options: ReadOptions = {},
): AsyncGenerator<Readonly<Record<string, PluginStorageEntry>>> {
  if (!storage.scan) throw new Error('Host plugin storage pagination is unavailable; update the Host before using this plugin');
  let cursor = '0';
  do {
    options.signal?.throwIfAborted();
    const page = await storage.scan({ prefix, cursor, count: 50,
      ...(options.suffix === undefined ? {} : { suffix: options.suffix }) });
    options.signal?.throwIfAborted();
    yield page.entries;
    cursor = page.cursor;
  } while (cursor !== '0');
}

/** Complete-result APIs collect only their requested namespace, never all plugin state. */
export async function storageEntries(storage: PluginStorageHost, prefix: string, options: ReadOptions = {}) {
  const result = new Map<string, PluginStorageEntry>();
  for await (const page of storagePages(storage, prefix, options)) {
    for (const [key, entry] of Object.entries(page)) {
      if (key.startsWith(prefix) && (options.suffix === undefined || key.endsWith(options.suffix))
        && entry.revision >= (result.get(key)?.revision ?? 0)) result.set(key, entry);
    }
  }
  return [...result];
}
