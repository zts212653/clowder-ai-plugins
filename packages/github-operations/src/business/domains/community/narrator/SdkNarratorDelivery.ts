import { createHash } from 'node:crypto';
import type { PluginMessagingHost, PluginStorageHost } from '@clowder-ai/plugin-sdk';
import { z } from 'zod';

export const narratorDeliverySchema = z.object({ sourceEventId: z.string().min(1), threadId: z.string().min(1), catId: z.string().min(1), briefing: z.string().min(1) }).strict();
export type NarratorDeliveryDraft = z.infer<typeof narratorDeliverySchema>;
export interface NarratorDelivery { send(draft: NarratorDeliveryDraft): Promise<void> }
const recordSchema = z.object({ draft: narratorDeliverySchema, messageId: z.string().min(1).nullable() }).strict();
const prefix = 'community.narrator.delivery.';
const keyOf = (sourceEventId: string) => prefix + createHash('sha256').update(sourceEventId).digest('hex');

/** One durable outbox record replaces claim-before-send. A retry always uses
 * the original target and briefing, and the Host's same idempotency key. No TTL,
 * private Redis client, or invented invocation accompanies a background wake. */
export class SdkNarratorDelivery implements NarratorDelivery {
  private stopped = false;
  private readonly pending = new Set<Promise<unknown>>();
  constructor(private readonly storage: PluginStorageHost, private readonly messaging: Pick<PluginMessagingHost, 'send'>,
    private readonly authorize: (draft: NarratorDeliveryDraft) => Promise<void> = async () => {}) {}
  private track<T>(run: () => Promise<T>): Promise<T> {
    this.assertActive(); const promise = run(); this.pending.add(promise);
    void promise.finally(() => this.pending.delete(promise)).catch(() => {}); return promise;
  }
  private async check(draft: NarratorDeliveryDraft) {
    this.assertActive(); await this.authorize(draft); this.assertActive();
  }
  send(input: NarratorDeliveryDraft): Promise<void> { return this.track(() => this.sendDraft(input)); }
  private async sendDraft(input: NarratorDeliveryDraft): Promise<void> {
    const draft = narratorDeliverySchema.parse(input); const key = keyOf(draft.sourceEventId);
    this.assertActive();
    const found = await this.storage.get(key);
    if (!found) {
      await this.check(draft);
      await this.storage.compareAndSet(key, null, { draft, messageId: null });
    }
    await this.flush(key, draft);
  }
  recover(): Promise<void> { return this.track(() => this.recoverAll()); }
  private async recoverAll(): Promise<void> {
    this.assertActive();
    for (const [key] of Object.entries(await this.storage.list())) {
      if (key.startsWith(prefix)) await this.flush(key);
    }
  }
  async status(sourceEventId: string): Promise<'pending' | 'delivered'> {
    this.assertActive(); const entry = await this.storage.get(keyOf(sourceEventId)); this.assertActive();
    return entry && recordSchema.parse(entry.value).messageId ? 'delivered' : 'pending';
  }
  async stop(): Promise<void> { this.stopped = true; await Promise.allSettled([...this.pending]); }
  private assertActive() { if (this.stopped) throw new Error('Narrator delivery stopped'); }
  private async flush(key: string, expected?: NarratorDeliveryDraft) {
    for (let attempt = 0; attempt < 64; attempt++) {
      this.assertActive();
      const entry = await this.storage.get(key);
      if (!entry) throw new Error('Narrator outbox record missing');
      const record = recordSchema.parse(entry.value);
      if (key !== keyOf(record.draft.sourceEventId)) throw new Error('Narrator outbox identity mismatch');
      if (expected && JSON.stringify(expected) !== JSON.stringify(record.draft)) throw new Error('Narrator source event already has a different delivery');
      if (record.messageId) return;
      await this.check(record.draft);
      const idempotencyKey = 'github:narrator:' + key.slice(prefix.length);
      const sent = await this.messaging.send({
        threadId: record.draft.threadId, identity: 'github-notification', idempotencyKey,
        wake: { catId: record.draft.catId },
        payload: { provenance: { epistemicStatus: 'observation' }, elements: [{ elementId: idempotencyKey, kind: 'text', payload: { text: record.draft.briefing } }] },
      });
      if (sent.threadId !== record.draft.threadId || !sent.messageId) throw new Error('Narrator delivery receipt mismatch');
      await this.check(record.draft);
      if ((await this.storage.compareAndSet(key, entry.revision, { ...record, messageId: sent.messageId })).applied) return;
    }
    throw new Error('Narrator outbox changed concurrently');
  }
}
