import { createHash } from 'node:crypto';
import type { PluginStorageEntry, PluginStorageHost } from '@clowder-ai/plugin-sdk';
import { assertWaitRecovery } from './typed-wait-recovery.js';
import { IndexedWaitStorageUnavailableError } from './typed-wait-record.js';

/** Preserve the invalid business bytes and remove only its automatic recovery projection. */
export async function parkMalformedWait(storage: PluginStorageHost, key: string,
  selected: PluginStorageEntry, index: string): Promise<void> {
  if (!storage.compareAndSetIndexed) throw new IndexedWaitStorageUnavailableError();
  let entry: PluginStorageEntry | undefined = selected;
  for (let attempt = 0; entry && attempt < 5; attempt++) {
    const raw = entry.value;
    const record = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? structuredClone(raw) as Record<string, unknown> : { malformedOriginal: structuredClone(raw) };
    const previous = record.recovery;
    let valid = false;
    try { assertWaitRecovery(previous); valid = true; } catch { /* Retained below, never reset into live work. */ }
    if (!valid && previous !== undefined && record.malformedRecovery === undefined) record.malformedRecovery = previous;
    record.recovery = { ...(valid ? previous as object : {}), v: 1,
      scope: valid ? (previous as { scope: string }).scope : `invalid:${createHash('sha256').update(key).digest('hex')}`,
      index, revision: valid ? (previous as { revision: number }).revision + 1 : 1,
      nextPollAt: 0, failures: 5, disposition: 'needs_attention', reasonCode: 'invalid_wait_record',
      notices: valid ? (previous as { notices: unknown }).notices : {} };
    if ((await storage.compareAndSetIndexed(key, entry.revision, record, { index, score: null })).applied) return;
    entry = await storage.get(key);
    // A concurrent repair owns the new version. Let its next due read validate it.
    if (entry?.revision !== selected.revision) return;
  }
  if (entry) throw new Error('Malformed wait quarantine raced; original record retained');
}
