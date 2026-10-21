import { createHash } from 'node:crypto';
import type { PluginStorageHost, PluginStorageEntry } from '@clowder-ai/plugin-sdk';
import type { CommunityEvent } from '../../model/index.js';

export interface ICommunityEventLog {
  /**
   * Idempotent append.
   * If `sourceEventId` already exists → `{ appended: false, sequence: -1 }`.
   * Otherwise appends to the per-subject list and returns the new length as `sequence`.
   */
  append(event: CommunityEvent): Promise<{ appended: boolean; sequence: number }>;

  /**
   * Read events for a subject in insertion order.
   * @param subjectKey  Stable subject identifier.
   * @param fromSequence  0-based index to start from (default 0 = all).
   */
  read(subjectKey: string, fromSequence?: number): Promise<CommunityEvent[]>;

  /** Return all subjectKeys that have at least one event. */
  listSubjects(): Promise<string[]>;
}

interface JournalHead { next: number; pending: CommunityEvent | null }
interface StoredEvent { sequence: number; event: CommunityEvent }
const HEAD = 'community.journal.v1';
const EVENTS = 'community.event.';
const eventKey = (id: string) => EVENTS + createHash('sha256').update(id).digest('hex');

/** Package-private journal using existing SDK CAS. One bounded reservation
 * makes a crashed append recoverable; immutable event records never expire.
 * Revisions need not be globally ordered across storage keys. */
export class SdkCommunityEventLog implements ICommunityEventLog {
  constructor(private readonly storage: PluginStorageHost) {}

  private async settle(entry: PluginStorageEntry): Promise<void> {
    const head = entry.value as JournalHead;
    if (!head.pending) return;
    await this.storage.compareAndSet(eventKey(head.pending.sourceEventId), null, {
      sequence: head.next, event: head.pending,
    } satisfies StoredEvent);
    await this.storage.compareAndSet(HEAD, entry.revision, { next: head.next + 1, pending: null } satisfies JournalHead);
  }

  private async ready(): Promise<PluginStorageEntry> {
    for (let attempt = 0; attempt < 256; attempt++) {
      const entry = await this.storage.get(HEAD);
      if (!entry) {
        await this.storage.compareAndSet(HEAD, null, { next: 0, pending: null } satisfies JournalHead);
        continue;
      }
      const head = entry.value as JournalHead;
      if (!Number.isSafeInteger(head.next) || head.next < 0) throw new Error('Invalid Community journal head');
      if (!head.pending) return entry;
      await this.settle(entry);
    }
    throw new Error('Community journal contention; retry append');
  }

  async append(event: CommunityEvent): Promise<{ appended: boolean; sequence: number }> {
    if (!event.sourceEventId || !event.subjectKey) throw new TypeError('Community event requires source and subject');
    // A migrated cursor deliberately overlaps the previous second. These are
    // opaque original seen receipts, not fabricated historical journal events.
    const imported = await this.storage.get('community.imported-comment.' + createHash('sha256').update(event.sourceEventId).digest('hex'));
    if (imported && (imported.value as { sourceEventId?: string }).sourceEventId === event.sourceEventId)
      return { appended: false, sequence: -1 };
    for (let attempt = 0; attempt < 256; attempt++) {
      const head = await this.ready();
      if (await this.storage.get(eventKey(event.sourceEventId))) return { appended: false, sequence: -1 };
      const reservation = await this.storage.compareAndSet(HEAD, head.revision, { ...head.value as JournalHead, pending: event });
      if (!reservation.applied) continue;
      await this.ready();
      const events = await this.read(event.subjectKey);
      return { appended: true, sequence: events.findIndex(candidate => candidate.sourceEventId === event.sourceEventId) };
    }
    throw new Error('Community journal contention; retry append');
  }

  private async entries(): Promise<StoredEvent[]> {
    await this.ready();
    return Object.entries(await this.storage.list()).filter(([key]) => key.startsWith(EVENTS))
      .map(([, entry]) => entry.value as StoredEvent).sort((a, b) => a.sequence - b.sequence);
  }
  async read(subjectKey: string, fromSequence = 0): Promise<CommunityEvent[]> {
    return (await this.entries()).filter(entry => entry.event.subjectKey === subjectKey).slice(fromSequence).map(entry => entry.event);
  }
  async listSubjects(): Promise<string[]> {
    return [...new Set((await this.entries()).map(entry => entry.event.subjectKey))];
  }
}
