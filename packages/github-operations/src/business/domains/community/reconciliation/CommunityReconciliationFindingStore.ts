import { createHash } from 'node:crypto';
import type { PluginStorageHost } from '@clowder-ai/plugin-sdk';

export type FindingStatus = 'open' | 'acknowledged' | 'resolved' | 'waived';

export interface FindingWaiver {
  reason: string;
  actor: string;
  evidence: string;
}

export interface ReconciliationFinding {
  findingId: string;
  subjectKey: string;
  findingKind: string;
  severity: string;
  message: string;
  status: FindingStatus;
  waiver: FindingWaiver | null;
  /** Optional fingerprint to detect evidence changes for waiver reopening. */
  evidenceFingerprint: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface FindingInput {
  findingId: string;
  subjectKey: string;
  findingKind: string;
  severity: string;
  message: string;
  evidenceFingerprint?: string;
}

const PREFIX = 'community.finding.';
const keyOf = (id: string) => PREFIX + createHash('sha256').update(id).digest('hex');

/** Persistent package-private finding state. Original reopening/waiver rules
 * remain unchanged; the storage edge uses SDK CAS instead of Redis hashes. */
export class CommunityReconciliationFindingStore {
  constructor(private readonly storage: PluginStorageHost) {}

  private async update(id: string, reducer: (old: ReconciliationFinding | null) => ReconciliationFinding | null): Promise<void> {
    for (let attempt = 0; attempt < 64; attempt++) {
      const entry = await this.storage.get(keyOf(id));
      const old = entry?.value as ReconciliationFinding ?? null;
      const next = reducer(old);
      if (next === old || next === null) return;
      if ((await this.storage.compareAndSet(keyOf(id), entry?.revision ?? null, next)).applied) return;
    }
    throw new Error('Finding changed concurrently; retry');
  }

  async upsert(input: FindingInput): Promise<void> {
    await this.update(input.findingId, old => {
      const now = Date.now();
      if (!old) return {
        ...input, status: 'open', waiver: null, evidenceFingerprint: input.evidenceFingerprint ?? null,
        createdAt: now, updatedAt: now,
      };
      if (old.status === 'waived') {
        if (!input.evidenceFingerprint || input.evidenceFingerprint === old.evidenceFingerprint) return old;
        return { ...old, status: 'open', message: input.message, evidenceFingerprint: input.evidenceFingerprint, waiver: null, updatedAt: now };
      }
      return {
        ...old, status: old.status === 'resolved' ? 'open' : old.status, message: input.message,
        evidenceFingerprint: input.evidenceFingerprint ?? null, updatedAt: now,
      };
    });
  }

  async acknowledge(id: string): Promise<void> {
    await this.update(id, old => old && { ...old, status: 'acknowledged', updatedAt: Date.now() });
  }
  async resolve(id: string): Promise<void> {
    await this.update(id, old => old && { ...old, status: 'resolved', updatedAt: Date.now() });
  }
  async waive(id: string, waiver: FindingWaiver): Promise<void> {
    if (!waiver.reason) throw new Error('Waiver requires non-empty reason');
    if (!waiver.actor) throw new Error('Waiver requires non-empty actor');
    if (!waiver.evidence) throw new Error('Waiver requires non-empty evidence');
    await this.update(id, old => old && { ...old, status: 'waived', waiver, updatedAt: Date.now() });
  }
  async resolveAbsent(subjectKey: string, stillPresent: string[]): Promise<void> {
    const present = new Set(stillPresent);
    for (const finding of await this.listBySubject(subjectKey)) {
      if (!present.has(finding.findingId)) await this.update(finding.findingId, old =>
        old && (old.status === 'open' || old.status === 'acknowledged')
          ? { ...old, status: 'resolved', updatedAt: Date.now() } : old);
    }
  }
  async get(id: string): Promise<ReconciliationFinding | null> {
    return (await this.storage.get(keyOf(id)))?.value as ReconciliationFinding ?? null;
  }
  async listBySubject(subjectKey: string): Promise<ReconciliationFinding[]> {
    return (await this.listAll()).filter(finding => finding.subjectKey === subjectKey);
  }
  async listOpen(): Promise<ReconciliationFinding[]> {
    return (await this.listAll()).filter(finding => finding.status === 'open' || finding.status === 'acknowledged');
  }
  async listAll(): Promise<ReconciliationFinding[]> {
    return Object.entries(await this.storage.list()).filter(([key]) => key.startsWith(PREFIX))
      .map(([, entry]) => entry.value as ReconciliationFinding);
  }
}
