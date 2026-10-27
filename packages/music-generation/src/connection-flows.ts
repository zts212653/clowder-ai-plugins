export interface ConnectionStorage {
  get(key: string): Promise<{ readonly revision: number; readonly value: unknown } | undefined>;
  compareAndSet(key: string, revision: number | null, value: unknown): Promise<{ readonly applied: boolean }>;
}

export interface ConnectionFlow {
  readonly flowId: string;
  readonly projectId: string;
  readonly state: 'starting' | 'pending' | 'ready' | 'canceled' | 'expired' | 'failed';
  readonly expiresAt: number;
  readonly authorizationUrl?: string;
  /** An opaque provider-owned completion reference; never a token or authorization code. */
  readonly completionRef?: string;
}

/** This adapter owns its own durable callback lifetime, independently of a settings request. */
export interface ConnectionHelper {
  begin(input: { readonly flowId: string; readonly projectId: string; readonly expiresAt: number }): Promise<{ readonly authorizationUrl: string }>;
  observe(flowId: string): Promise<
    | { readonly state: 'pending'; readonly authorizationUrl?: string }
    | { readonly state: 'ready'; readonly flowId: string; readonly projectId: string; readonly completionRef: string }
    | { readonly state: 'failed' }
  >;
  cancel(flowId: string): Promise<void>;
}

export interface ConnectionFlowOptions {
  readonly storage: ConnectionStorage;
  readonly helper: ConnectionHelper;
  readonly assertCurrent: () => Promise<void>;
  readonly now?: () => number;
  readonly createId?: () => string;
  readonly lifetimeMs?: number;
}

/** Pending metadata only: credential import/commit and Host enable are separate boundaries. */
export class MusicConnectionFlows {
  constructor(private readonly options: ConnectionFlowOptions) {}

  async begin(projectId: string): Promise<ConnectionFlow | null> {
    await this.options.assertCurrent();
    if (!PROJECT_ID.test(projectId)) throw new Error('invalid_cloud_project');
    const pointer = await this.options.storage.get(CURRENT);
    const previous = await this.current();
    if (previous && previous.flow.projectId === projectId && this.waiting(previous.flow) && !this.expired(previous.flow))
      return previous.flow;
    const flowId = this.options.createId?.() ?? crypto.randomUUID();
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(flowId)) throw new Error('invalid_flow_identity');
    const flow: ConnectionFlow = {
      flowId, projectId, state: 'starting',
      expiresAt: this.now() + (this.options.lifetimeMs ?? 600_000),
    };
    if (!(await this.options.storage.compareAndSet(key(flowId), null, flow)).applied)
      throw new Error('flow_identity_conflict');
    if (!(await this.options.storage.compareAndSet(CURRENT, pointer?.revision ?? null, { flowId })).applied) {
      await this.update(flow, { ...flow, state: 'canceled' });
      return (await this.current())?.flow ?? null;
    }
    if (previous && this.waiting(previous.flow)) await this.retire(previous.flow, 'canceled');
    await this.options.assertCurrent();
    if ((await this.current())?.flow.flowId !== flowId) return (await this.current())?.flow ?? null;
    let authorizationUrl: string;
    try {
      const response = await this.options.helper.begin({ flowId, projectId, expiresAt: flow.expiresAt });
      authorizationUrl = publicAuthorizationUrl(response.authorizationUrl);
    } catch {
      return this.settle(flow, { ...flow, state: 'failed' });
    }
    await this.options.assertCurrent();
    return this.settle(flow, { ...flow, state: 'pending', authorizationUrl });
  }

  async poll(): Promise<ConnectionFlow | null> {
    await this.options.assertCurrent();
    const current = await this.current();
    if (!current) return null;
    const flow = current.flow;
    if (!this.waiting(flow)) return flow;
    if (this.expired(flow)) return this.retire(flow, 'expired');
    let observed: Awaited<ReturnType<ConnectionHelper['observe']>>;
    try { observed = await this.options.helper.observe(flow.flowId); }
    catch { return this.settle(flow, terminal(flow, 'failed')); }
    await this.options.assertCurrent();
    if (observed.state === 'pending') {
      if (observed.authorizationUrl !== undefined) {
        try { return this.settle(flow, { ...flow, state: 'pending', authorizationUrl: publicAuthorizationUrl(observed.authorizationUrl) }); }
        catch { return this.settle(flow, terminal(flow, 'failed')); }
      }
      return (await this.current())?.flow ?? null;
    }
    if (observed.state !== 'ready' || observed.flowId !== flow.flowId || observed.projectId !== flow.projectId || !opaqueRef(observed.completionRef))
      return this.settle(flow, terminal(flow, 'failed'));
    if (this.expired(flow)) return this.retire(flow, 'expired');
    return this.settle(flow, { ...terminal(flow, 'ready'), completionRef: observed.completionRef });
  }

  async cancel(): Promise<ConnectionFlow | null> {
    await this.options.assertCurrent();
    const current = await this.current();
    if (!current) return null;
    if (!this.waiting(current.flow)) return current.flow;
    return this.retire(current.flow, 'canceled');
  }

  private async retire(flow: ConnectionFlow, state: 'canceled' | 'expired'): Promise<ConnectionFlow | null> {
    await this.options.assertCurrent();
    if (await this.update(flow, terminal(flow, state))) {
      // The real helper must durably tombstone this exact flow before cancel resolves.
      // It never receives a Host client and cannot cancel a newer flow by project name.
      await this.options.helper.cancel(flow.flowId);
    }
    return (await this.current())?.flow ?? null;
  }

  private async settle(before: ConnectionFlow, after: ConnectionFlow): Promise<ConnectionFlow | null> {
    await this.options.assertCurrent();
    if ((await this.current())?.flow.flowId === before.flowId) await this.update(before, after);
    return (await this.current())?.flow ?? null;
  }

  private async update(before: ConnectionFlow, after: ConnectionFlow): Promise<boolean> {
    const row = await this.options.storage.get(key(before.flowId));
    if (!row || !isFlow(row.value) || row.value.state !== before.state) return false;
    await this.options.assertCurrent();
    return (await this.options.storage.compareAndSet(key(before.flowId), row.revision, after)).applied;
  }

  private async current(): Promise<{ flow: ConnectionFlow } | null> {
    const pointer = await this.options.storage.get(CURRENT);
    if (!pointer) return null;
    if (!object(pointer.value) || !opaqueRef(pointer.value.flowId)) throw new Error('invalid_connection_pointer');
    const row = await this.options.storage.get(key(pointer.value.flowId));
    if (!row || !isFlow(row.value) || row.value.flowId !== pointer.value.flowId) throw new Error('invalid_connection_record');
    return { flow: structuredClone(row.value) };
  }

  private now() { return this.options.now?.() ?? Date.now(); }
  private waiting(flow: ConnectionFlow) { return flow.state === 'starting' || flow.state === 'pending'; }
  private expired(flow: ConnectionFlow) { return flow.expiresAt <= this.now(); }
}

const CURRENT = 'music.connection.current.v1';
const PROJECT_ID = /^[a-z][a-z0-9-]{4,61}[a-z0-9]$/;
const key = (flowId: string) => `music.connection.flow.v1:${flowId}`;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const opaqueRef = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
function isFlow(value: unknown): value is ConnectionFlow {
  if (!object(value) || !opaqueRef(value.flowId) || typeof value.projectId !== 'string' || !PROJECT_ID.test(value.projectId) ||
    !['starting', 'pending', 'ready', 'canceled', 'expired', 'failed'].includes(String(value.state)) ||
    typeof value.expiresAt !== 'number' || !Number.isSafeInteger(value.expiresAt) ||
    Object.keys(value).some(name => !['flowId', 'projectId', 'state', 'expiresAt', 'authorizationUrl', 'completionRef'].includes(name))) return false;
  if (value.state === 'pending') {
    try { if (typeof value.authorizationUrl !== 'string' || publicAuthorizationUrl(value.authorizationUrl) !== value.authorizationUrl) return false; }
    catch { return false; }
  } else if (value.authorizationUrl !== undefined) return false;
  return value.state === 'ready' ? opaqueRef(value.completionRef) : value.completionRef === undefined;
}
function terminal(flow: ConnectionFlow, state: ConnectionFlow['state']): ConnectionFlow {
  return { flowId: flow.flowId, projectId: flow.projectId, expiresAt: flow.expiresAt, state };
}
function publicAuthorizationUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'accounts.google.com' || url.port || url.username || url.password || url.hash ||
    !['/o/oauth2/auth', '/o/oauth2/v2/auth'].includes(url.pathname) ||
    [...url.searchParams.keys()].some(name => /^(?:code|access_token|refresh_token|client_secret|id_token)$/i.test(name)))
    throw new Error('invalid_authorization_url');
  return url.href;
}
