import { threadMappings } from '../../thread-mappings.js';
import type { CommunityThreads } from '../domains/community/ports/CommunityThreads.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import type { PluginActionContext, PluginStorageHost, PluginThreadHost } from '@clowder-ai/plugin-sdk';
import type { FastifyInstance, FastifyReply, FastifyRequest, InjectOptions, LightMyRequestResponse } from 'fastify';

type Principal = { readonly kind: 'owner'; readonly id: string } | { readonly kind: 'native'; readonly context: PluginActionContext };

/** One instance per active module. Only the Host's owner-authenticated webhook
 * forwarding handler or native action's second argument may establish this
 * scope. HTTP headers, body fields and callback credentials never establish it.
 * The embedded router has no listening socket. */
export class CommunityRequestContext {
  private readonly current = new AsyncLocalStorage<Principal>();
  private readonly pending = new Map<string, Principal>();
  private readonly header = 'x-community-local-request';
  private stopped = false;
  constructor(private readonly app: FastifyInstance) {
    // light-my-request creates its async resource outside the caller scope.
    // Re-enter at onRequest using a one-use in-process correlation key. This
    // header is overwritten by inject(), never accepted from a forwarded client.
    app.addHook('onRequest', (request, _reply, done) => {
      const key = request.headers[this.header];
      const principal = typeof key === 'string' ? this.pending.get(key) : undefined;
      if (typeof key === 'string') this.pending.delete(key);
      if (principal) this.current.run(principal, done);
      else this.current.exit(done);
    });
  }
  injectOwner(principal: { readonly kind: 'owner'; readonly id: string }, options: InjectOptions): Promise<LightMyRequestResponse> {
    this.assertActive();
    if (principal.kind !== 'owner' || !principal.id) throw new Error('Host owner principal required');
    return this.inject({ kind: 'owner', id: principal.id }, options);
  }
  async injectNative(context: PluginActionContext, options: InjectOptions): Promise<LightMyRequestResponse> {
    this.assertActive();
    if (!context?.catId || !context.threadId || !context.userId || !context.invocationId || typeof context.assertCurrent !== 'function') throw new Error('Host native action context required');
    await context.assertCurrent();
    return this.inject({ kind: 'native', context }, options);
  }
  private async inject(principal: Principal, options: InjectOptions) {
    this.assertActive();
    const key = randomUUID();
    const headers = Object.fromEntries(Object.entries(options.headers ?? {}).filter(([name]) => name.toLowerCase() !== this.header));
    this.pending.set(key, principal);
    try { return await this.app.inject({ ...options, headers: { ...headers, [this.header]: key } }); }
    finally { this.pending.delete(key); }
  }
  userId(_request?: FastifyRequest): string | null {
    const principal = this.current.getStore();
    return principal?.kind === 'owner' ? principal.id : principal?.context.userId ?? null;
  }
  caller(): PluginActionContext | null {
    const principal = this.current.getStore();
    return principal?.kind === 'native' ? principal.context : null;
  }
  requireCaller(_request: FastifyRequest, reply: FastifyReply): PluginActionContext | null {
    const caller = this.caller();
    if (!caller) reply.code(401).send({ error: 'Authenticated native action required' });
    return caller;
  }
  requireOwner(reply: FastifyReply): boolean {
    if (this.current.getStore()?.kind === 'owner') return true;
    reply.code(403).send({ error: 'Host-authenticated owner required' });
    return false;
  }
  async assertCurrent(): Promise<void> {
    this.assertActive();
    const principal = this.current.getStore();
    if (!principal) throw new Error('Authenticated Community request required');
    if (principal.kind === 'native') await principal.context.assertCurrent();
    this.assertActive();
  }
  /** SDK calls retain the Host's installation/grant filtering. The workflow's
   * historical userId argument is a consistency check, never an SDK identity. */
  threads(host: Pick<PluginThreadHost, 'get' | 'create'>, storage: PluginStorageHost): CommunityThreads {
    return {
      get: async id => {
        if (!id || id.length > 500 || id.trim() !== id) throw new TypeError('Invalid thread id');
        // A live metadata listing is not an existence check: activity may move
        // the target across its cursor. Use the Host's authorized point lookup.
        await this.assertCurrent();
        const thread = await host.get(id);
        await this.assertCurrent();
        return thread ? { id: thread.id, title: thread.title } : null;
      },
      create: async (userId, title, caseId) => {
        await this.assertCurrent();
        if (userId !== this.userId()) throw new Error('Community thread user does not match authenticated caller');
        // No body-supplied user is forwarded; Host authenticates the SDK edge.
        if (!caseId) throw new Error('Community case identity required');
        const key = 'community:case:' + createHash('sha256').update(JSON.stringify([userId, caseId])).digest('hex');
        const thread = await threadMappings({ threads: host, storage } as import('@clowder-ai/plugin-sdk').FeatureContext).ensureByKey(key, { title });
        await this.assertCurrent();
        return { id: thread.id };
      },
    };
  }
  /** Use only for request-owned workflow stores. Background collectors have
   * their own module lifecycle and cannot borrow an invocation's authority. */
  mutationStorage(storage: PluginStorageHost): PluginStorageHost {
    return {
      get: key => storage.get(key),
      list: () => storage.list(),
      set: async (key, value) => { await this.assertCurrent(); return storage.set(key, value); },
      compareAndSet: async (key, expected, value) => { await this.assertCurrent(); return storage.compareAndSet(key, expected, value); },
      delete: async (key, expected) => { await this.assertCurrent(); return storage.delete(key, expected); },
    };
  }
  stop(): void { this.stopped = true; this.pending.clear(); }
  private assertActive(): void { if (this.stopped) throw new Error('Community router stopped'); }
}
