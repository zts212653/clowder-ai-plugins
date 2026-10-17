import type { FeatureContext } from '@clowder-ai/plugin-sdk';
import type { CommunityIssueItem } from './business/model/index.js';
import { SdkCommunityWorkflowIssueStore } from './business/domains/community/CommunityWorkflowStores.js';
import { buildNarratorBriefing, type NarratorSpawnParams } from './business/domains/community/narrator/NarratorDriver.js';
import { SdkNarratorDelivery, narratorDeliverySchema, type NarratorDeliveryDraft } from './business/domains/community/narrator/SdkNarratorDelivery.js';

/** Owner dispatch is the intent. Recovery never invents a narrator binding from
 * a deployment default, an old invocation, or an imported historical event. */
export class CommunityNarratorRuntime {
  private stopped = false;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly delivery: SdkNarratorDelivery;
  private readonly issues: SdkCommunityWorkflowIssueStore;
  constructor(private readonly context: FeatureContext) {
    this.issues = new SdkCommunityWorkflowIssueStore(context.storage);
    this.delivery = new SdkNarratorDelivery(context.storage, { send: ({ threadId, ...options }) => context.messaging.send(threadId, options) },
      draft => this.authorizeDelivery(draft));
  }
  private current() { if (this.stopped) throw new Error('Community narrator stopped'); }
  private track<T>(run: () => Promise<T>): Promise<T> {
    this.current(); const promise = run(); this.pending.add(promise);
    void promise.finally(() => this.pending.delete(promise)).catch(() => {}); return promise;
  }
  private async target() {
    this.current();
    const catId = await this.context.config.get('narratorCatId');
    const threadId = await this.context.config.get('narratorThreadId'); this.current();
    if ((catId === undefined || catId === '') && (threadId === undefined || threadId === '')) return null;
    if (typeof catId !== 'string' || !catId.trim() || typeof threadId !== 'string' || !threadId.trim()) throw new Error('Configure both narrator cat and thread in plugin settings');
    return { catId, threadId };
  }
  private async authorize(draft: NarratorDeliveryDraft) {
    const target = await this.target();
    if (!target || target.catId !== draft.catId || target.threadId !== draft.threadId) throw new Error('Narrator configuration changed; original delivery remains pending');
    const catalog = await this.context.deployment.getCatalog(); this.current();
    if (!Object.hasOwn(catalog.roster, draft.catId) || !catalog.roster[draft.catId]?.available) throw new Error('Configured narrator is unavailable');
    const thread = await this.context.threads.get(draft.threadId); this.current();
    if (!thread || thread.id !== draft.threadId) throw new Error('Configured narrator thread is unavailable');
    const after = await this.target();
    if (!after || after.catId !== target.catId || after.threadId !== target.threadId) throw new Error('Narrator configuration changed during validation');
  }
  prepare(params: NarratorSpawnParams): Promise<NarratorDeliveryDraft | null> {
    return this.track(async () => {
      const target = await this.target(); if (!target) return null;
      const draft = { ...target, sourceEventId: params.sourceEventId, briefing: buildNarratorBriefing(params) };
      await this.authorize(draft); this.current(); return draft;
    });
  }
  private async authorizeDelivery(draft: NarratorDeliveryDraft) {
    await this.authorize(draft);
    const item = (await this.intents()).find(item => item.narratorDelivery!.sourceEventId === draft.sourceEventId);
    if (!item || item.state !== 'discussing' || JSON.stringify(narratorDeliverySchema.parse(item.narratorDelivery)) !== JSON.stringify(draft)) throw new Error('Narrator dispatch is no longer current');
    this.current();
  }
  private async intents(): Promise<CommunityIssueItem[]> {
    this.current(); const items = await this.issues.listAll(); this.current();
    return items.filter(item => item.narratorDelivery);
  }
  /** The workflow CAS commits state and intent together. Historical records
   * without an explicit intent never wake a cat when configuration is enabled. */
  reconcile() {
    return this.track(async () => {
      const results: Array<{ sourceEventId: string; status: string; reason?: string }> = [];
      for (const item of await this.intents()) {
        this.current();
        const draft = narratorDeliverySchema.parse(item.narratorDelivery);
        const sourceEventId = draft.sourceEventId;
        try {
          if (item.state !== 'discussing') {
            results.push({ sourceEventId, status: 'inactive' }); continue;
          }
          await this.delivery.send(draft);
          results.push({ sourceEventId, status: 'delivered' });
        } catch (error) {
          this.current();
          const reason = error instanceof Error ? error.message : 'Narrator delivery unavailable';
          this.context.log('warn', 'Narrator dispatch remains pending', { sourceEventId, reason });
          results.push({ sourceEventId, status: 'pending', reason });
        }
      }
      this.current(); return results;
    });
  }
  status() {
    return this.track(async () => {
      const rows = [];
      for (const item of await this.intents()) {
        const draft = narratorDeliverySchema.parse(item.narratorDelivery);
        const status = await this.delivery.status(draft.sourceEventId);
        rows.push({ sourceEventId: draft.sourceEventId, subjectKey: `issue:${item.repo}#${item.issueNumber}`,
          catId: draft.catId, threadId: draft.threadId,
          status: status === 'delivered' ? status : item.state === 'discussing' ? 'pending' : 'inactive' });
      }
      this.current(); return rows;
    });
  }
  async stop() { this.stopped = true; await Promise.allSettled([this.delivery.stop(), ...this.pending]); }
}
