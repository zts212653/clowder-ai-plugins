import type { PluginStorageEntry, PluginStorageHost } from '@clowder-ai/plugin-sdk';
import type { CommunityEvent } from '../../model/index.js';
import { assertWaitStorage } from '../../../typed-wait-record.js';
import { JournalDirectory, JOURNAL_HEAD, JOURNAL_EVENTS, eventKey, globalRef, immutableRef, journalIndex, storedEvent } from './journal-directory.js';

interface DirectoryProgress { v: 1; status: 'scan' | 'walk' | 'building' | 'ready'; cursor: string; through: number; next: number }
export interface JournalHead { next: number; pending: CommunityEvent | null; directory?: DirectoryProgress }
const initializing = new WeakMap<PluginStorageHost, Promise<void>>();

export function publishJournalHead(storage: PluginStorageHost, revision: number | null, value: JournalHead) {
  assertWaitStorage(storage);
  return storage.compareAndSetIndexed(JOURNAL_HEAD, revision, value, { index: journalIndex('pr'), score: null });
}
function head(entry: PluginStorageEntry): JournalHead {
  const value = entry.value as JournalHead;
  if (!Number.isSafeInteger(value.next) || value.next < 0) throw new Error('Invalid Community journal head');
  return value;
}
async function advance(storage: PluginStorageHost, entry: PluginStorageEntry, value: JournalHead) {
  if (!(await publishJournalHead(storage, entry.revision, value)).applied)
    throw new Error('Journal census source version changed; resume the original progress');
  return (await storage.get(JOURNAL_HEAD))!;
}

async function bootstrap(storage: PluginStorageHost): Promise<void> {
  const directory = new JournalDirectory(storage);
  let entry = await storage.get(JOURNAL_HEAD);
  if (!entry) {
    if (!(await publishJournalHead(storage, null, { next: 0, pending: null })).applied) throw new Error('Journal initialization changed concurrently');
    entry = (await storage.get(JOURNAL_HEAD))!;
  }
  let current = head(entry);
  if (current.directory?.status === 'ready') return;
  if (!current.directory) {
    // Finish only an old append reservation, with no business apply or delivery.
    if (current.pending) {
      await immutableRef(storage, eventKey(current.pending.sourceEventId), { sequence: current.next, event: current.pending });
      current = { ...current, next: current.next + 1, pending: null };
    }
    current = { ...current, directory: { v: 1, status: 'scan', cursor: '0', through: 0, next: current.next } };
    entry = await advance(storage, entry, current);
  }
  if (!current.directory || current.directory.v !== 1) throw new Error('Invalid journal census metadata');
  let progress = current.directory;
  while (progress.status === 'scan') {
    assertWaitStorage(storage);
    const page = await storage.scan({ prefix: JOURNAL_EVENTS, cursor: progress.cursor, count: 50 });
    for (const [key, source] of Object.entries(page.entries)) {
      if (!key.startsWith(JOURNAL_EVENTS)) continue;
      const row = storedEvent(source.value);
      if (key !== eventKey(row.event.sourceEventId) || row.sequence >= progress.next)
        throw new Error('Journal census event identity/order is unknown');
      await immutableRef(storage, globalRef(row.sequence), { key });
    }
    progress = { ...progress, cursor: page.cursor, status: page.cursor === '0' ? 'walk' : 'scan' };
    current = { ...current, directory: progress };
    entry = await advance(storage, entry, current);
  }
  while (progress.status === 'walk') {
    const stop = Math.min(progress.next, progress.through + 50);
    for (let sequence = progress.through; sequence < stop; sequence++) {
      const ref = (await storage.get(globalRef(sequence)))?.value as { key: string } | undefined;
      if (!ref) throw new Error('Journal census sequence is unavailable');
      const source = await storage.get(ref.key);
      if (!source || storedEvent(source.value).sequence !== sequence) throw new Error('Journal census reference mismatch');
      await directory.materialize(source);
    }
    progress = { ...progress, through: stop, status: stop === progress.next ? 'building' : 'walk' };
    current = { ...current, directory: progress };
    entry = await advance(storage, entry, current);
  }
  assertWaitStorage(storage);
  await storage.rebuildIndex(journalIndex('pr'));
  await storage.rebuildIndex(journalIndex('issue'));
  await advance(storage, entry, { ...current, directory: { ...progress, status: 'ready' } });
}

/** Explicit resumable census. Ready periodic callers use only control and due reads. */
export async function initializeJournal(storage: PluginStorageHost): Promise<void> {
  assertWaitStorage(storage);
  const existing = initializing.get(storage); if (existing) return existing;
  const entry = await storage.get(JOURNAL_HEAD);
  if (entry && head(entry).directory?.status === 'ready') return;
  const underway = initializing.get(storage); if (underway) return underway;
  const work = bootstrap(storage); initializing.set(storage, work);
  try { await work; } finally { if (initializing.get(storage) === work) initializing.delete(storage); }
}
