import { z } from 'zod';
import { hostRouteBodySchema } from './owner-route-validation.js';
import { individualParticipationInput } from './owner-participation-change.js';
import type { BrowserServiceBinding, PluginOwnerHttpContext } from '@clowder-ai/plugin-sdk';
import type { CollectiveConnector } from './business/connector/connector.js';
import type { createCollectiveEntryCaller } from './entry-control.js';
import type { HostRouteConfig } from './business/connector/host-route-state.js';
import { desiredParticipationSchema } from './business/connector/host-route-state.js';
import { channelListeningInputSchema } from './business/connector/channel-listening-custody.js';
import { reconsiderationInput, type createCollectiveWorkReconsiderationCaller } from './collective-work-reconsideration.js';

const requestSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT']), path: z.string().min(1).max(512),
  query: z.record(z.unknown()).optional(), body: z.unknown().optional(), rawBody: z.unknown().optional(),
  headers: z.record(z.union([z.string(), z.array(z.string()), z.undefined()])).default({}),
  principal: z.object({ kind: z.literal('owner'), id: z.string().min(1).max(240) }).strict(),
}).strict();
const inputSchema = z.object({ request: requestSchema }).strict();
const reconcileInput = z.object({ expectedRevision: z.number().int().nonnegative(),
  channelIds: z.array(z.string().trim().min(1).max(160)).min(1).max(100) }).strict();
const policyInput = reconcileInput.extend({ policy: desiredParticipationSchema }).strict();
const adoptInput = z.object({ expectedPolicyRevision: z.number().int().positive() }).strict();
const revokeInput = z.object({ grantRefs: z.array(z.string().trim().min(1).max(240)).min(1).max(100) }).strict();
export interface CollectiveLocalServiceStatus {
  readonly state: 'setup_required' | 'ready';
  readonly serviceUrl: string;
  readonly dataDirectory: string;
  readonly serviceInstanceId: string;
  readonly bootstrapNeeded: boolean;
  readonly setupStep?: 'github_app' | 'owner_setup';
}
interface OwnerControlOptions {
  readonly reconsideration?: ReturnType<typeof createCollectiveWorkReconsiderationCaller>['reconsider'];
  readonly routeChange?: (ownerUserId: string, connectionId: string, input: z.infer<typeof hostRouteBodySchema>) => Promise<HostRouteConfig>;
  readonly participation?: (ownerUserId: string, connectionId: string, input: z.infer<typeof individualParticipationInput>) => Promise<HostRouteConfig>;
  readonly view?: (ownerUserId: string, connectionId: string) => Promise<unknown>;
  readonly entry?: ReturnType<typeof createCollectiveEntryCaller>;
  readonly reconcile?: (ownerUserId: string, connectionId: string, input: z.infer<typeof reconcileInput> & { readonly policy?: z.infer<typeof desiredParticipationSchema> }) => Promise<HostRouteConfig>;
  readonly connector: Pick<CollectiveConnector, 'listConnections' | 'listInbox' | 'sync' | 'revoke' | 'getHostRoute' |
    'setChannelListening' | 'readWorkPolicyStatus' | 'adoptWorkPolicy' | 'revokeWorkGrants'>;
  readonly binding: BrowserServiceBinding;
  readonly assertActive: () => void;
  readonly status: () => CollectiveLocalServiceStatus;
  readonly launch: () => Promise<{ readonly service: CollectiveLocalServiceStatus; readonly launchUrl: string }>;
}
const response = (status: number, body: unknown) => ({ status, headers: { 'content-type': 'application/json' }, body });

/** The existing authenticated owner webhook lane, not a browser-service or native action.
 * Host supplies principal only after local owner authentication and declared-webhook admission.
 * Core connector persistence, policy, sync and revocation algorithms stay unchanged. */
export function createOwnerControlHttp(options: OwnerControlOptions) {
  // Retain the original owner participation mutation serialization across thread/route effects.
  const mutations = new Map<string, Promise<void>>();
  const mutate = async <T>(id: string, run: () => Promise<T>) => {
    const previous = mutations.get(id) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>(resolve => { release = resolve; });
    mutations.set(id, tail);
    await previous;
    try { return await run(); } finally { release(); if (mutations.get(id) === tail) mutations.delete(id); }
  };
  return async (input: unknown, native?: unknown, caller?: unknown) => {
    if (native !== undefined || caller !== undefined &&
      (!caller || typeof caller !== 'object' || !('kind' in caller) || caller.kind !== 'owner-http-request'))
      throw new Error('Collective owner webhook context required');
    const { request } = inputSchema.parse(input);
    const owner = caller as PluginOwnerHttpContext | undefined;
    if (owner && (owner.userId !== request.principal.id || !owner.pluginInstanceId ||
      owner.operation !== (request.method === 'GET' ? 'read' : 'write') || typeof owner.assertCurrent !== 'function' ||
      owner.requestIdentity && (owner.requestIdentity.method !== request.method || owner.requestIdentity.path !== request.path)))
      throw new Error('Collective owner webhook context required');
    const current = async () => {
      owner?.signal.throwIfAborted(); await owner?.assertCurrent();
      options.assertActive(); await options.binding.assertCurrent(); options.assertActive();
      owner?.signal.throwIfAborted(); await owner?.assertCurrent();
    };
    await current();
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== options.binding.parentOrigin)
      return response(403, { code: 'PAIRING_ORIGIN_MISMATCH', error: 'Owner request origin does not match this Host' });
    const { connector } = options;
    const finish = async (status: number, body: unknown) => { await current(); return response(status, body); };
    const reconsider = /^connections\/([A-Za-z0-9_-]{1,240})\/work\/reconsider$/.exec(request.path);
    if (reconsider) {
      if (request.method !== 'POST') return finish(405, { code: 'OWNER_CONTROL_METHOD_NOT_ALLOWED' });
      if (!options.reconsideration || !owner) return finish(409, { code: 'WORK_RECONSIDERATION_UNAVAILABLE' });
      try {
        const parsed = reconsiderationInput.parse(request.body);
        const result = await mutate(reconsider[1]!, async () => {
          await current(); return options.reconsideration!(reconsider[1]!, parsed, owner);
        });
        return finish(200, result);
      } catch (error) {
        await current();
        if (error instanceof z.ZodError) return response(400, { code: 'INVALID_WORK_RECONSIDERATION_REQUEST' });
        const code = error && typeof error === 'object' && 'code' in error ? error.code : 'WORK_RECONSIDERATION_UNAVAILABLE';
        return response(code === 'CONNECTOR_OWNER_MISMATCH' ? 403 : code === 'PARTICIPATION_UNSUPPORTED' ? 422 : 409,
          { code, error: error instanceof Error ? error.message : 'Current reconsideration is unavailable' });
      }
    }
    const rawRoute = /^connections\/([A-Za-z0-9_-]{1,240})\/route$/.exec(request.path);
    if (rawRoute && request.method === 'PUT' && options.routeChange) {
      const parsed = hostRouteBodySchema.safeParse(request.body);
      if (!parsed.success) return finish(400, { error: 'Invalid Collective Host route' });
      try {
        const updated = await mutate(rawRoute[1]!, async () => {
          await current(); return options.routeChange!(request.principal.id, rawRoute[1]!, parsed.data);
        });
        return finish(200, updated);
      } catch (error) {
        await current();
        const code = error && typeof error === 'object' && 'code' in error ? error.code : 'CONNECTOR_OPERATION_FAILED';
        const status = code === 'CONNECTOR_OWNER_MISMATCH' ? 403 : error && typeof error === 'object' && 'status' in error && typeof error.status === 'number'
          ? error.status : code === 'IDENTITY_REBIND_REQUIRED' || code === 'ROUTE_ROSTER_CHANGED' || code === 'PARTICIPATION_REVISION_CONFLICT' ? 409
          : error instanceof Error && error.message === 'Collective connection was not found' ? 404 : 502;
        return response(status, { code, error: error instanceof Error ? error.message : 'Collective route unavailable' });
      }
    }
    const view = /^connections\/([A-Za-z0-9_-]{1,240})\/participation$/.exec(request.path);
    if (view && request.method === 'PUT' && options.participation) {
      try {
        const parsed = individualParticipationInput.parse(request.body);
        const route = await mutate(view[1]!, async () => { await current(); return options.participation!(request.principal.id, view[1]!, parsed); });
        return finish(200, { revision: route.revision, published: true });
      } catch (error) {
        await current();
        if (error instanceof z.ZodError) return response(400, { code: 'INVALID_PARTICIPATION_REQUEST' });
        const code = error && typeof error === 'object' && 'code' in error ? error.code : 'PARTICIPATION_UNAVAILABLE';
        return response(code === 'CONNECTOR_OWNER_MISMATCH' ? 403 : code === 'PARTICIPATION_UNSUPPORTED' ? 422 : 409,
          { code, error: error instanceof Error ? error.message : 'Participation unavailable' });
      }
    }
    if (view && options.view) {
      if (request.method !== 'GET') return finish(405, { code: 'OWNER_CONTROL_METHOD_NOT_ALLOWED' });
      try { return finish(200, await options.view(request.principal.id, view[1]!)); }
      catch (error) {
        await current();
        const code = error && typeof error === 'object' && 'code' in error ? error.code : 'PARTICIPATION_UNAVAILABLE';
        return response(code === 'CONNECTOR_OWNER_MISMATCH' ? 403 : 409,
          { code, error: error instanceof Error ? error.message : 'Participation unavailable' });
      }
    }
    if (request.path === 'entry-roster' && request.method === 'GET' && options.entry) return finish(200, await options.entry.entryRoster());
    if (request.path === 'pair' && request.method === 'POST' && options.entry) {
      const result = await options.entry.pair(request.body, typeof origin === 'string' ? origin : undefined);
      return finish(result.status, result.body);
    }
    const reconcile = /^connections\/([A-Za-z0-9_-]{1,240})\/participation\/(reconcile|policy)$/.exec(request.path);
    if (reconcile && options.reconcile) {
      const isPolicy = reconcile[2] === 'policy';
      if (request.method !== (isPolicy ? 'PUT' : 'POST')) return finish(405, { code: 'OWNER_CONTROL_METHOD_NOT_ALLOWED' });
      try {
        const parsed = (isPolicy ? policyInput : reconcileInput).parse(request.body);
        const route = await mutate(reconcile[1]!, async () => { await current(); return options.reconcile!(request.principal.id, reconcile[1]!, parsed); });
        return finish(200, { revision: route.revision, published: true });
      } catch (error) {
        await current();
        if (error instanceof z.ZodError) return response(400, { code: 'INVALID_PARTICIPATION_REQUEST' });
        const code = error && typeof error === 'object' && 'code' in error ? error.code : 'PARTICIPATION_UNAVAILABLE';
        return response(code === 'CONNECTOR_OWNER_MISMATCH' ? 403 : 409, { code, error: error instanceof Error ? error.message : 'Participation unavailable' });
      }
    }
    if (request.path === 'connections' && request.method === 'GET')
      return finish(200, { runtimeStatus: 'active', connections: await connector.listConnections(), localService: options.status() });
    if (request.path === 'service/provision' && request.method === 'POST') {
      try { return await finish(200, await options.launch()); }
      catch (error) {
        await current();
        return response(409, { code: 'COLLECTIVE_SERVICE_PROVISION_FAILED', error: error instanceof Error ? error.message : 'Local Collective Service could not be created' });
      }
    }
    const match = /^connections\/([A-Za-z0-9_-]{1,240})\/(inbox|route|reconnect|revoke|listening|work-policy(?:\/(?:adopt|revoke))?)$/.exec(request.path);
    if (!match) return finish(404, { code: 'OWNER_CONTROL_NOT_DECLARED' });
    const connectionId = match[1]!, action = match[2]!;
    const allowed = action === 'listening' ? ['GET', 'POST']
      : ['inbox', 'route', 'work-policy'].includes(action) ? ['GET'] : ['POST'];
    if (!allowed.includes(request.method)) return finish(405, { code: 'OWNER_CONTROL_METHOD_NOT_ALLOWED' });
    const policy = action.startsWith('work-policy');
    const listening = action === 'listening';
    try {
      if (action === 'route' || policy || listening) {
        const route = await connector.getHostRoute(connectionId);
        await current();
        if (!route && action === 'route') return response(404, { error: 'Collective Host route is not configured' });
        if (route?.localOwnerUserId !== request.principal.id)
          return response(403, { code: 'CONNECTOR_OWNER_MISMATCH', error: 'Collective Host route belongs to another local owner' });
        if (action === 'route') return finish(200, route);
        if (listening) {
          const updated = request.method === 'GET' ? route
            : await connector.setChannelListening(connectionId, request.principal.id, channelListeningInputSchema.parse(request.body));
          return finish(200, { channelListening: updated?.channelListening ?? {}, attentionRevision: updated?.attentionRevision ?? 0 });
        }
        if (action === 'work-policy') return finish(200, await connector.readWorkPolicyStatus(connectionId));
        if (action === 'work-policy/adopt') return finish(200, {
          policy: await connector.adoptWorkPolicy(connectionId, request.principal.id, adoptInput.parse(request.body).expectedPolicyRevision),
        });
        await connector.revokeWorkGrants(connectionId, request.principal.id, revokeInput.parse(request.body).grantRefs);
        return finish(200, { disposition: 'revocation_confirmed' });
      }
      if (action === 'inbox') return finish(200, { events: await connector.listInbox(connectionId) });
      const projection = await (action === 'reconnect' ? connector.sync(connectionId) : connector.revoke(connectionId));
      if (action === 'revoke' && projection.authorityStatus === 'revoking')
        return finish(409, { code: 'COLLECTIVE_REVOCATION_UNCONFIRMED', error: projection.lastError ?? 'Revocation requires recovery', connection: projection });
      if (action === 'reconnect' && projection.recovery?.held)
        return finish(409, { code: 'COLLECTIVE_RECOVERY_REQUIRED', error: projection.lastError ?? 'Local operation requires recovery', connection: projection });
      return finish(200, projection);
    } catch (error) {
      await current();
      if (policy) {
        if (error instanceof z.ZodError) return response(400, { code: 'INVALID_WORK_POLICY_REQUEST' });
        const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'WORK_POLICY_UNAVAILABLE';
        return response(409, { code, error: error instanceof Error ? error.message : 'Current owner policy is unavailable' });
      }
      if (listening) {
        if (error instanceof z.ZodError) return response(400, { code: 'INVALID_LISTENING_REQUEST' });
        const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'LISTENING_UNAVAILABLE';
        return response(409, { code, error: error instanceof Error ? error.message : 'Listening is unavailable' });
      }
      if (error instanceof Error && error.message === 'Collective connection was not found')
        return response(404, { code: 'CONNECTION_NOT_FOUND', error: error.message });
      return response(502, { code: 'CONNECTOR_OPERATION_FAILED', error: 'Collective Connector operation failed' });
    }
  };
}
