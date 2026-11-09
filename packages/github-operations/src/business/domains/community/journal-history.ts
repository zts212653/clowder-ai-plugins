import type { PluginStorageHost } from '@clowder-ai/plugin-sdk';
import { storageEntries } from '../../../storage-pages.js';
import { JOURNAL_EVENTS, eventKey, storedEvent } from './journal-directory.js';

/** Explicit historical inspection on older Hosts without indexed capabilities.
 * This never reserves an append, initializes metadata or runs from a due path. */
export async function readRetainedJournal(storage: PluginStorageHost) {
  return (await storageEntries(storage, JOURNAL_EVENTS)).map(([key, entry]) => {
    const row = storedEvent(entry.value);
    if (key !== eventKey(row.event.sourceEventId)) throw new Error('Retained journal event identity mismatch');
    return row;
  }).sort((left, right) => left.sequence - right.sequence);
}
