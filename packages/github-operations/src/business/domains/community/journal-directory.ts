import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { PluginStorageEntry, PluginStorageHost } from '@clowder-ai/plugin-sdk';
import type { CommunityEvent } from '../../model/index.js';
import { assertWaitStorage } from '../../../typed-wait-record.js';
import { advanceRecoveryNotice, recoveryOwnerNotice, recoveryNoticeScore,
  type RecoveryOwnerNotice, type RecoveryNoticeSender } from '../../../recovery-owner-notice.js';

export const JOURNAL_HEAD = 'community.journal.v1';
export const JOURNAL_EVENTS = 'community.event.';
export const SUBJECTS = 'community.journal.subject.v2.';
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const eventKey = (id: string) => JOURNAL_EVENTS + hash(id);
export const globalRef = (sequence: number) => `community.journal.global-ref.v2.${sequence}`;
const subjectKey = (subject: string) => SUBJECTS + hash(subject);
const subjectRef = (subject: string, sequence: number) => `community.journal.subject-ref.v2.${hash(subject)}.${sequence}`;
export const journalIndex = (kind: 'pr' | 'issue') => `github-journal-${kind}`;
export const subjectKind = (subject: string): 'pr' | 'issue' => {
  if (!/^(pr|issue):[a-z0-9_.-]+\/[a-z0-9_.-]+#[1-9]\d*$/.test(subject)) throw new Error('Invalid journal subject');
  return subject.startsWith('pr:') ? 'pr' : 'issue';
};
export interface StoredEvent { sequence: number; event: CommunityEvent; subjectSequence?: number }
export interface JournalSubject {
  v: 1; subject: string; next: number; lastGlobal: number; lastSource: string;
  route?: { sequence: number; sourceEventId: string };
  terminal?: { sequence: number; sourceEventId: string };
  ownerThread?: string; notice?: RecoveryOwnerNotice;
  recovery: { scope: string; revision: number; pending: boolean; failures: number; nextAt: number;
    disposition?: 'needs_attention'; reasonCode?: string; lastNoticeKey?: string };
}

function pendingSubject(key: string, value: unknown, kind: 'pr' | 'issue'): JournalSubject {
  const row = value as JournalSubject | null, facts = row?.recovery;
  const natural = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  if (!row || row.v !== 1 || subjectKind(row.subject) !== kind || key !== subjectKey(row.subject)
    || !natural(row.next) || !natural(row.lastGlobal) || typeof row.lastSource !== 'string'
    || !facts || typeof facts.scope !== 'string' || typeof facts.pending !== 'boolean'
    || !natural(facts.revision) || !natural(facts.failures) || !natural(facts.nextAt)
    || facts.disposition !== undefined && facts.disposition !== 'needs_attention')
    throw new Error('Journal pending source identity/recovery mismatch');
  return row;
}

export function storedEvent(value: unknown): StoredEvent {
  const row = value as StoredEvent;
  if (!row || !Number.isSafeInteger(row.sequence) || row.sequence < 0 || !row.event?.sourceEventId)
    throw new Error('Invalid immutable journal event');
  subjectKind(row.event.subjectKey);
  return row;
}
export async function immutableRef(storage: PluginStorageHost, key: string, value: unknown): Promise<void> {
  const old = await storage.get(key);
  if (old) { if (!isDeepStrictEqual(old.value, value)) throw new Error('Journal reference identity conflict'); return; }
  if (!(await storage.compareAndSet(key, null, value)).applied) {
    if (!isDeepStrictEqual((await storage.get(key))?.value, value)) throw new Error('Journal reference changed concurrently');
  }
}

/** Original journal metadata owns its cursor and pending route debt. References only address immutable events. */
export class JournalDirectory {
  constructor(private readonly storage: PluginStorageHost) {}
  async subject(subject: string): Promise<PluginStorageEntry | undefined> {
    const kind = subjectKind(subject), key = subjectKey(subject), entry = await this.storage.get(key);
    if (entry) pendingSubject(key, entry.value, kind);
    return entry;
  }
  private async publish(entry: PluginStorageEntry | undefined, value: JournalSubject) {
    assertWaitStorage(this.storage);
    const intent = recoveryOwnerNotice('journal', hash(JSON.stringify([value.subject, value.recovery.scope])), value.ownerThread, value.subject);
    const notice = value.notice ?? (value.recovery.disposition && intent?.key !== value.recovery.lastNoticeKey ? intent : undefined);
    const liveAt = value.recovery.pending && !value.recovery.disposition ? value.recovery.nextAt : null;
    const noticeAt = recoveryNoticeScore(notice);
    return this.storage.compareAndSetIndexed(subjectKey(value.subject), entry?.revision ?? null, { ...value, notice },
      { index: journalIndex(subjectKind(value.subject)), score: liveAt === null ? noticeAt : noticeAt === null ? liveAt : Math.min(liveAt, noticeAt) });
  }
  async materialize(input: PluginStorageEntry): Promise<void> {
    let source = input;
    for (let attempt = 0; attempt < 64; attempt++) {
      const row = storedEvent(source.value), event = row.event;
      const before = await this.subject(event.subjectKey), prior = before?.value as JournalSubject | undefined;
      if (prior && (prior.v !== 1 || prior.subject !== event.subjectKey)) throw new Error('Journal subject identity mismatch');
      const applied = !!prior && prior.lastGlobal >= row.sequence;
      const sequence = row.subjectSequence ?? (applied ? undefined : prior?.next ?? 0);
      if (sequence === undefined && applied) {
        const current = await this.storage.get(eventKey(event.sourceEventId));
        if (current && current.revision !== source.revision) { source = current; continue; }
      }
      if (sequence === undefined) throw new Error('Journal local sequence is unknown; retain census obligation');
      if (row.subjectSequence === undefined) {
        const updated = await this.storage.compareAndSet(eventKey(event.sourceEventId), source.revision, { ...row, subjectSequence: sequence });
        if (!updated.applied) { source = (await this.storage.get(eventKey(event.sourceEventId)))!; continue; }
      }
      await immutableRef(this.storage, globalRef(row.sequence), { key: eventKey(event.sourceEventId) });
      await immutableRef(this.storage, subjectRef(event.subjectKey, sequence), { key: eventKey(event.sourceEventId) });
      if (applied) return;
      const routeChanged = event.kind === 'case.routed';
      const terminal = ['case.declined', 'pr.closed', 'pr.merged', 'issue.closed'].includes(event.kind);
      const recovery = prior?.recovery ?? { scope: '', revision: 0, pending: false, failures: 0, nextAt: 0 };
      const next: JournalSubject = { v: 1, subject: event.subjectKey, next: sequence + 1,
        lastGlobal: row.sequence, lastSource: event.sourceEventId,
        ...(prior?.route ? { route: prior.route } : {}), ...(prior?.terminal ? { terminal: prior.terminal } : {}),
        ownerThread: prior?.ownerThread, notice: prior?.notice,
        recovery: routeChanged || terminal ? { scope: event.sourceEventId, revision: recovery.revision + 1,
          pending: true, nextAt: 0, failures: 0 } : recovery };
      if (routeChanged) {
        next.route = { sequence, sourceEventId: event.sourceEventId }; delete next.terminal;
        next.ownerThread = typeof event.payload.ownerThreadId === 'string' ? event.payload.ownerThreadId : undefined;
      }
      else if (terminal) next.terminal = { sequence, sourceEventId: event.sourceEventId };
      if ((await this.publish(before, next)).applied) return;
    }
    throw new Error('Journal subject changed concurrently');
  }
  async read(subject: string, from = 0): Promise<CommunityEvent[]> {
    const head = (await this.subject(subject))?.value as JournalSubject | undefined;
    const events: CommunityEvent[] = [];
    for (let sequence = from; sequence < (head?.next ?? 0); sequence++) {
      const ref = (await this.storage.get(subjectRef(subject, sequence)))?.value as { key: string } | undefined;
      if (!ref) throw new Error('Journal subject reference is unavailable');
      const entry = await this.storage.get(ref.key);
      if (!entry) throw new Error('Referenced journal event is unavailable');
      const row = storedEvent(entry.value);
      if (row.event.subjectKey !== subject || row.subjectSequence !== sequence) throw new Error('Journal subject sequence mismatch');
      events.push(row.event);
    }
    return events;
  }
  async routing(subject: string) {
    const head = (await this.subject(subject))?.value as JournalSubject | undefined;
    if (!head?.route) return null;
    const source = await this.storage.get(eventKey(head.route.sourceEventId));
    if (!source) throw new Error('Canonical route event is unavailable');
    const row = storedEvent(source.value);
    if (row.event.subjectKey !== subject || row.event.kind !== 'case.routed' || row.subjectSequence !== head.route.sequence)
      throw new Error('Canonical route reference mismatch');
    return { event: row.event, sequence: head.route.sequence,
      terminal: !!head.terminal && head.terminal.sequence > head.route.sequence };
  }
  async due(kind: 'pr' | 'issue', now: number, limit = 20) {
    assertWaitStorage(this.storage);
    const page = await this.storage.readDue({ index: journalIndex(kind), before: now, limit });
    if (page.status !== 'ready') throw new Error('Journal reconciliation index is not_ready');
    const candidates: Array<{ entry: PluginStorageEntry; subject: string }> = [];
    for (const [key, entry] of Object.entries(page.entries)) {
      try {
        const row = pendingSubject(key, entry.value, kind);
        candidates.push({ entry, subject: row.subject });
      } catch {
        await this.storage.compareAndSetIndexed(key, entry.revision,
          { _journalRecoveryCorruption: entry.value, disposition: 'needs_attention', reasonCode: 'invalid_journal_source' },
          { index: journalIndex(kind), score: null });
      }
    }
    return candidates;
  }
  async finish(selected: PluginStorageEntry, failed: boolean, now: number): Promise<void> {
    const old = selected.value as JournalSubject;
    for (let attempt = 0; attempt < 8; attempt++) {
      const entry = await this.subject(old.subject); if (!entry) throw new Error('Journal obligation disappeared');
      const current = entry.value as JournalSubject;
      if (current.recovery.revision !== old.recovery.revision || !current.recovery.pending) return;
      const failures = current.recovery.failures + (failed ? 1 : 0);
      const next = { ...current, recovery: { ...current.recovery, revision: current.recovery.revision + 1,
        pending: failed, failures, nextAt: now + 60_000,
        ...(failures >= 5 ? { disposition: 'needs_attention' as const, reasonCode: 'journal_route_reconciliation_failed' } : {}) } };
      if ((await this.publish(entry, next)).applied) return;
    }
    throw new Error('Journal reconciliation acknowledgment changed concurrently');
  }
  async deliverNotice(selected: PluginStorageEntry, send: RecoveryNoticeSender | undefined, now: number): Promise<void> {
    const row = selected.value as JournalSubject; if (!row.notice) return;
    const notice = await advanceRecoveryNotice(this.storage, row.notice, send, now);
    const current = await this.subject(row.subject); if (!current) return;
    const value = current.value as JournalSubject;
    if (JSON.stringify(value.notice) !== JSON.stringify(row.notice)) return;
    const currentScope = hash(JSON.stringify([value.subject, value.recovery.scope]));
    await this.publish(current, { ...value, notice, recovery: { ...value.recovery,
      ...(!notice && currentScope === row.notice.scope ? { lastNoticeKey: row.notice.key } : {}) } });
  }
}
