import type { PluginStorageEntry, PluginStorageHost } from '@clowder-ai/plugin-sdk';
import type { CommunityEvent } from '../../model/index.js';
import { storageEntries } from '../../../storage-pages.js';
import { initializeJournal, publishJournalHead, type JournalHead } from './journal-census.js';
import { JournalDirectory, JOURNAL_HEAD, SUBJECTS, eventKey, hash, storedEvent, subjectKind, type JournalSubject } from './journal-directory.js';
import type { RecoveryNoticeSender } from '../../../recovery-owner-notice.js';
import { readRetainedJournal } from './journal-history.js';
import { hasWaitStorage } from '../../../typed-wait-record.js';

export interface ICommunityEventLog {
  /** Idempotent append. Duplicates return sequence=-1; new events retain their 0-based subject position. */
  append(event: CommunityEvent): Promise<{ appended: boolean; sequence: number }>;
  /** Read this subject's immutable events in insertion order, from its 0-based position. */
  read(subjectKey: string, fromSequence?: number): Promise<CommunityEvent[]>;
  /** Explicit inspection; periodic recovery uses the original owner's pending projection. */
  listSubjects(): Promise<string[]>;
}

/** Original journal/control reservation and immutable event identities remain authoritative. */
export class SdkCommunityEventLog implements ICommunityEventLog {
  private readonly directory: JournalDirectory;
  constructor(private readonly storage: PluginStorageHost) { this.directory = new JournalDirectory(storage); }
  initialize(): Promise<void> { return initializeJournal(this.storage); }
  private async ready(): Promise<PluginStorageEntry> {
    await this.initialize();
    for (let attempt = 0; attempt < 256; attempt++) {
      const entry = (await this.storage.get(JOURNAL_HEAD))!;
      const head = entry.value as JournalHead;
      if (!head.pending) return entry;
      const key = eventKey(head.pending.sourceEventId);
      const source = await this.storage.get(key);
      if (!source) {
        if (!(await this.storage.compareAndSet(key, null, { sequence: head.next, event: head.pending })).applied) continue;
      }
      const canonical = (await this.storage.get(key))!;
      const row = storedEvent(canonical.value);
      if (row.sequence !== head.next || row.event.subjectKey !== head.pending.subjectKey)
        throw new Error('Journal reservation conflicts with its immutable event');
      await this.directory.materialize(canonical);
      await publishJournalHead(this.storage, entry.revision, { ...head, next: head.next + 1, pending: null });
    }
    throw new Error('Community journal contention; retry append');
  }
  async append(event: CommunityEvent): Promise<{ appended: boolean; sequence: number }> {
    if (!event.sourceEventId || !event.subjectKey) throw new TypeError('Community event requires source and subject');
    const imported = await this.storage.get('community.imported-comment.' + hash(event.sourceEventId));
    if (imported && (imported.value as { sourceEventId?: string }).sourceEventId === event.sourceEventId)
      return { appended: false, sequence: -1 };
    for (let attempt = 0; attempt < 256; attempt++) {
      const entry = await this.ready(), head = entry.value as JournalHead;
      if (await this.storage.get(eventKey(event.sourceEventId))) return { appended: false, sequence: -1 };
      if (!(await publishJournalHead(this.storage, entry.revision, { ...head, pending: event })).applied) continue;
      await this.ready();
      const canonical = await this.storage.get(eventKey(event.sourceEventId));
      if (!canonical) throw new Error('Committed journal event is unavailable');
      const sequence = storedEvent(canonical.value).subjectSequence;
      if (sequence === undefined) throw new Error('Committed journal subject position is unavailable');
      return { appended: true, sequence };
    }
    throw new Error('Community journal contention; retry append');
  }
  async read(subject: string, from = 0): Promise<CommunityEvent[]> {
    if (!Number.isSafeInteger(from) || from < 0) throw new TypeError('Invalid journal subject cursor');
    if (hasWaitStorage(this.storage)) { await this.ready(); return this.directory.read(subject, from); }
    return (await readRetainedJournal(this.storage)).filter(row => row.event.subjectKey === subject)
      .slice(from).map(row => row.event);
  }
  async listSubjects(): Promise<string[]> {
    if (!hasWaitStorage(this.storage))
      return [...new Set((await readRetainedJournal(this.storage)).map(row => row.event.subjectKey))];
    await this.ready();
    return (await storageEntries(this.storage, SUBJECTS)).flatMap(([key, entry]) => {
      const row = entry.value as Partial<JournalSubject> | null;
      try {
        if (!row?.subject || key !== SUBJECTS + hash(row.subject)) return [];
        subjectKind(row.subject); return [row.subject];
      } catch { return []; } // Retained invalid directory rows remain in recoveryDiagnostics.
    });
  }
  async recoveryDiagnostics() {
    const control = (await this.storage.get(JOURNAL_HEAD))?.value as JournalHead | undefined;
    const entries = (await storageEntries(this.storage, SUBJECTS)).map(([sourceKey, entry]) => {
      const row = entry.value as (Partial<JournalSubject> & { disposition?: string; reasonCode?: string }) | null;
      return { sourceKey, sourceRevision: entry.revision, subjectKey: row?.subject,
        recovery: row?.recovery ?? { disposition: row?.disposition ?? 'unknown', reasonCode: row?.reasonCode ?? 'recovery_not_prepared' }, noticeState: row?.notice?.state };
    });
    return { readiness: control?.directory?.status === 'ready' ? 'ready' : 'not_ready', entries };
  }
  async routing(subject: string) { await this.ready(); return this.directory.routing(subject); }
  async pendingRoutes(kind: 'pr' | 'issue', now: number, limit = 20) {
    await this.ready(); return this.directory.due(kind, now, limit);
  }
  finishRoute(entry: PluginStorageEntry, failed: boolean, now: number) { return this.directory.finish(entry, failed, now); }
  deliverRouteNotice(entry: PluginStorageEntry, send: RecoveryNoticeSender | undefined, now: number) {
    return this.directory.deliverNotice(entry, send, now);
  }
}
