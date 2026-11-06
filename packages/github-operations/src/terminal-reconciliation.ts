import { z } from 'zod';
import type { PluginActionContext, PluginStorageHost } from '@clowder-ai/plugin-sdk';
import type { GitHubTrackingProvider } from './tracking-runtime.js';
import { SdkCommunityEventLog } from './business/domains/community/CommunityEventLog.js';
import { SdkCommunityObjectStore } from './business/domains/community/CommunityObjectStore.js';
import { SdkCommunityRepoConfigStore } from './business/domains/community/CommunityRepoConfigStore.js';
import { CommunityProjector, CommunityProjectionOperations } from './business/domains/community/community-projector.js';
import { mergeTerminalFacts, parseTerminalFacts, terminalFactsSchema, terminalReviews } from './business/domains/community/terminal-provider-facts.js';
import { fencedIndexedStorage } from './owner-indexed-storage.js';
import { TerminalFactCollection } from './terminal-fact-collection.js';

export const TERMINAL_RECONCILIATION_METHOD = 'github.subject.reconcile-terminal';
export const terminalReconciliationInput = z.object({
  subjectKey: z.string().max(300).regex(/^pr:[a-z0-9_.-]+\/[a-z0-9_.-]+#[1-9][0-9]*$/)
    .refine(subject => !subject.slice(3).split('#')[0]!.split('/').some(part => part === '.' || part === '..'))
    .describe('One existing terminal PR, e.g. pr:owner/repository#12. Provider facts and caller identity are not input fields.'),
}).strict();
export const terminalReconciliationDescription = 'Re-read and persist final GitHub facts for one existing terminal PR. ' +
  'Use when: an authorized historical repair must recover the final HEAD, review commit associations, merge identity or CI provenance. ' +
  'NOT for: active review, publishing a review, changing assignment, restarting tracking or recording native delivery. ' +
  'Output: appends a provider-only observation to this installation’s journal and returns the rebuilt terminal facts; existing native review and failure history remain unchanged. ' +
  'GOTCHA: GitHub approval is external evidence, never proof that a native verdict was delivered. This is a private state mutation, not a read-only inspection.';

/** One subject, one provider read, no caller-supplied facts or active work. */
export class TerminalReconciliationRuntime {
  private readonly lifetime = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly submissions = new CommunityProjectionOperations();
  constructor(private readonly options: {
    storage: PluginStorageHost;
    provider: GitHubTrackingProvider;
    projectionOperations: CommunityProjectionOperations;
  }) {}

  reconcile(value: unknown, caller?: PluginActionContext) {
    const run = this.submit(value, caller);
    this.pending.add(run);
    void run.finally(() => this.pending.delete(run)).catch(() => {});
    return run;
  }

  private async submit(value: unknown, caller: PluginActionContext | undefined) {
    if (!caller?.catId || !caller.threadId || !caller.userId || !caller.invocationId || typeof caller.assertCurrent !== 'function') throw new Error('Authenticated native action context required');
    const { subjectKey } = terminalReconciliationInput.parse(value);
    const match = /^pr:(.+)#([1-9][0-9]*)$/.exec(subjectKey)!;
    const repo = match[1]!, number = Number(match[2]);
    if (!Number.isSafeInteger(number)) throw new TypeError('PR number must be a safe positive integer');
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(30_000)]);
    const current = async () => { signal.throwIfAborted(); await caller.assertCurrent(); signal.throwIfAborted(); };
    await current();
    return this.submissions.run(subjectKey, async () => {
      const source = this.options.storage, configs = new SdkCommunityRepoConfigStore(source);
      const config = await configs.getByRepo(repo);
      if (!config) throw new Error('Repository is not configured for terminal reconciliation');
      const fence = async () => {
        await current();
        if (JSON.stringify(await configs.getByRepo(repo)) !== JSON.stringify(config)) throw new Error('Repository policy changed during terminal reconciliation');
        await current();
      };
      const objects = new SdkCommunityObjectStore(source);
      const original = await objects.get(subjectKey);
      const subjectHistory = await new SdkCommunityEventLog(source).read(subjectKey);
      const providerTerminal = subjectHistory.some(event => {
        if (event.kind === 'pr.merged' || event.kind === 'pr.closed') return true;
        const facts = event.kind === 'pr.terminal_observed' ? terminalFactsSchema.safeParse(event.payload.terminalFacts) : null;
        return !!facts?.success && facts.data.subjectKey === subjectKey;
      });
      if (!subjectHistory.length || (!providerTerminal && (!original ||
          (original.externalReview?.lifecycle !== 'terminal' && !['fixed', 'closed', 'declined'].includes(original.state))))) throw new Error('Existing terminal subject required');
      await fence();
      const snapshot = await this.options.provider.read({ kind: 'pr', repoFullName: repo, number,
        threadId: caller.threadId, catId: caller.catId }, signal);
      await fence();
      if (snapshot.state === 'open' || !snapshot.terminalFacts || snapshot.commentsComplete !== true) throw new Error('Complete terminal provider snapshot required');
      const incoming = parseTerminalFacts(snapshot.terminalFacts, subjectKey);
      const history = terminalReviews(await new SdkCommunityEventLog(source).read(subjectKey));
      const facts = mergeTerminalFacts({ ...incoming, reviews: history }, incoming);
      if (facts.source !== 'github-api' || facts.state !== snapshot.state || facts.headSha !== snapshot.headSha) throw new TypeError('Terminal snapshot subject or commit identity mismatch');
      mergeTerminalFacts((await objects.get(subjectKey))?.terminalFacts, facts);
      const scan = source.scan?.bind(source);
      const storage: PluginStorageHost = {
        ...fencedIndexedStorage(source, fence), get: key => source.get(key), list: () => source.list(),
        ...(scan ? { scan } : {}),
        set: async (key, value) => { await fence(); return source.set(key, value); },
        compareAndSet: async (key, revision, value) => { await fence(); return source.compareAndSet(key, revision, value); },
        delete: async (key, revision) => { await fence(); return source.delete(key, revision); },
      };
      const events = new SdkCommunityEventLog(storage), guardedObjects = new SdkCommunityObjectStore(storage);
      const projector = new CommunityProjector(events, guardedObjects, this.options.projectionOperations, 'projection-only');
      const result = await new TerminalFactCollection(storage, events, projector, this.options.projectionOperations, signal).collect(subjectKey, [], facts, true);
      if (result.denied) throw new Error('Provider observation is older than the current provider state');
      if (!result.recorded) await projector.rebuild(subjectKey);
      await fence();
      return { data: { subjectKey, outcome: result.recorded ? 'recorded' : 'unchanged',
        terminalFacts: (await guardedObjects.get(subjectKey))?.terminalFacts ?? null } };
    });
  }

  async stop(): Promise<void> { this.lifetime.abort(); await Promise.allSettled([...this.pending]); }
}
