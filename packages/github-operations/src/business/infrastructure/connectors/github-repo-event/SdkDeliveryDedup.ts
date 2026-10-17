import { createHash, randomUUID } from 'node:crypto';
import type { PluginStorageHost } from '@clowder-ai/plugin-sdk';

interface DeliveryClaim { state: 'pending' | 'confirmed'; owner: string; expiresAt: number }
const keyFor = (id: string) => `github.webhook.delivery.${createHash('sha256').update(id).digest('hex')}`;
/** Technical replay window, matching the old 24h Redis dedup. This never
 * expires messages, community events or user-visible tracking records. */
export class SdkDeliveryDedup {
  private readonly owner = randomUUID();
  constructor(private readonly storage: PluginStorageHost, private readonly now = Date.now) {}
  async claim(id: string): Promise<boolean> {
    const key = keyFor(id);
    for (let attempt = 0; attempt < 64; attempt++) {
      const current = await this.storage.get(key);
      if (current && (current.value as DeliveryClaim).expiresAt > this.now()) return false;
      const result = await this.storage.compareAndSet(key, current?.revision ?? null, {
        state: 'pending', owner: this.owner, expiresAt: this.now() + 86_400_000,
      });
      if (result.applied) return true;
    }
    throw new Error('webhook claim contention');
  }
  async confirm(id: string): Promise<void> {
    const key = keyFor(id), current = await this.storage.get(key);
    if (!current || (current.value as DeliveryClaim).owner !== this.owner) throw new Error('webhook claim ownership changed');
    const applied = await this.storage.compareAndSet(key, current.revision, {
      state: 'confirmed', owner: this.owner, expiresAt: this.now() + 86_400_000,
    });
    if (!applied.applied) throw new Error('webhook claim ownership changed');
  }
  async rollback(id: string): Promise<void> {
    const key = keyFor(id), current = await this.storage.get(key);
    if (current && (current.value as DeliveryClaim).owner === this.owner) await this.storage.delete(key, current.revision);
  }
}
