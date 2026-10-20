import { z } from 'zod';
import type { FeatureContext, FeatureActivation, PluginActionHandler, PluginOwnerHttpContext, PluginOwnerOperationContext } from '@clowder-ai/plugin-sdk';
import { rowsResult, operationRowAction } from '@clowder-ai/plugin-sdk';
import type { CollectiveConnector } from './business/connector/connector.js';
import { collectiveEventSourceIdentity } from './business/contracts/index.js';
import { openCollectiveContextReferences, collectiveContextError } from './collective-context-refs.js';
import { collectiveWorkNativeTools } from './work-native-methods.js';
import {createCollectiveMessageWorkCaller} from './collective-message-work.js';
import {reconcileCollectiveMessageWorkResult, resumeCollectiveMessageWork, admitCollectiveMessageWork} from './collective-owner-work-result.js';
import {createCollectiveMessageWorkActions} from './collective-message-work-actions.js';
import {createCollectiveMessageWorkMaterials, WORK_MATERIAL_RECEIVER} from './collective-message-work-materials.js';
import {createCollectiveMessageWorkArtifacts} from './collective-message-work-artifacts.js';
import { collectiveOwnerOperationInput } from './owner-operation-input.js';

interface Backend {
  readonly connector: CollectiveConnector;
  isAllowedOrigin(origin: string): boolean;
  withAction<T>(action: import('@clowder-ai/plugin-sdk').PluginActionContext, run: () => Promise<T>): Promise<T>;
  assertActive(): void;
  startBackground(workSync: (connectionId: string, current: () => Promise<void>) => Promise<void>): void;
}
const requestSchema = z.object({request: z.object({method: z.literal('POST'), path: z.string().min(1).max(512),
  headers: z.record(z.union([z.string(), z.array(z.string()), z.undefined()])).default({}),
  principal: z.object({kind: z.literal('owner'), id: z.string().min(1).max(240)}).strict(),
  body: z.unknown(), query: z.record(z.unknown()).optional(), rawBody: z.unknown().optional()}).strict()}).strict();
const syncSchema = z.object({connectionId: z.string().min(1).max(240)}).strict();

/** One declared private Work feature consumes original callers. Its actions use
 * its own grants/lifetime; sharing the backend Connector does not share owner
 * or native authority. The original Task lifecycle keeps UI data; it does not issue an execution identity. */
export async function activateCollectiveWork(context: FeatureContext, backend: Backend): Promise<FeatureActivation> {
  let live = true;
  const assertActive = () => {if (!live) throw new Error('Collective Work is stopped');void context.dataPath;backend.assertActive();};
  assertActive();
  const {connector} = backend;
  const refs = await openCollectiveContextReferences(context.dataPath, assertActive);
  const materials = createCollectiveMessageWorkMaterials(connector, context, assertActive);
  await materials.restore();
  const messageCaller = createCollectiveMessageWorkCaller(connector, context, {beforeWake: materials.subscribe});
  const messageArtifacts = createCollectiveMessageWorkArtifacts(context, materials);
  const messageAction = createCollectiveMessageWorkActions(connector, messageCaller, refs, messageArtifacts);
  const handlers: Record<string, PluginActionHandler> = {
    [WORK_MATERIAL_RECEIVER]: async (input) => {assertActive();await materials.receive(input);assertActive();},
  };
  for (const tool of collectiveWorkNativeTools) handlers[tool.method] = async (unsafe, action, caller) => {
    assertActive();
    if (!action || caller)
      throw collectiveContextError('NOT_COLLECTIVE_ORIGIN', 'This action requires the authenticated private Work invocation');
    await action.assertCurrent();assertActive();
    const result = await backend.withAction(action, () => messageAction(tool.method, unsafe, action));
    assertActive();await action.assertCurrent();return result;
  };
  handlers['collective.work.control.http'] = async (unsafe, native, caller) => {
    assertActive();
    if (native || caller?.kind !== 'owner-http-request') throw new Error('Authenticated owner Work webhook required');
    const owner: PluginOwnerHttpContext = caller;
    const {request} = requestSchema.parse(unsafe);
    if (owner.operation !== 'write' || owner.userId !== request.principal.id ||
      owner.requestIdentity?.method !== request.method || owner.requestIdentity.path !== request.path ||
      (request.headers.origin !== undefined && (typeof request.headers.origin !== 'string' || !backend.isAllowedOrigin(request.headers.origin))))
      throw new Error('Authenticated owner Work webhook required');
    const current = async () => {assertActive();owner.signal.throwIfAborted();await owner.assertCurrent();assertActive();};
    await current();
    const match = /^connections\/([A-Za-z0-9_-]{1,240})\/work\/(admit|resume|result\/accepted)$/.exec(request.path);
    if (!match) return {status: 404, headers: {'content-type': 'application/json'}, body: {code: 'OWNER_CONTROL_NOT_FOUND'}};
    try {
      if (match[2] === 'result/accepted') {
        const result = await reconcileCollectiveMessageWorkResult(connector, context, owner.userId, match[1]!, request.body, current);
        await current();
        return {status: result.result === 'not_admitted' ? 202 : result.result === 'terminal_unchanged' ? 409 : 200,
          headers: {'content-type': 'application/json'}, body: result.result === 'terminal_unchanged'
            ? {code: 'COLLECTIVE_RESULT_TERMINAL_CONFLICT', ...result} : result};
      }
      const result = match[2] === 'admit'
        ? await admitCollectiveMessageWork(connector, context, messageCaller, owner, match[1]!, request.body, current)
        : await resumeCollectiveMessageWork(connector, context, messageCaller, owner.userId, match[1]!, request.body, current);
      await current();return {status: 'result' in result && result.result === 'needs_clarification' ? 422 : 200,
        headers: {'content-type': 'application/json'}, body: result};
    } catch (error) {
      await current();
      if (error instanceof z.ZodError) return {status: 400, headers: {'content-type': 'application/json'}, body: {code: match[2] === 'result/accepted' ? 'INVALID_COLLECTIVE_RESULT' : 'INVALID_OWNER_WORK_REQUEST'}};
      const code = error && typeof error === 'object' && 'code' in error ? error.code : 'OWNER_ADMISSION_UNAVAILABLE';
      return {status: code === 'CONNECTOR_OWNER_MISMATCH' ? 403 : 409, headers: {'content-type': 'application/json'}, body: {code, error: error instanceof Error ? error.message.slice(0, 500) : 'Work admission unavailable'}};
    }
  };
  const ownerOperation = (caller: unknown): PluginOwnerOperationContext => {
    if (!caller || typeof caller !== 'object' || !('kind' in caller) || caller.kind !== 'owner-operation')
      throw new Error('Authenticated owner Work operation required');
    return caller as PluginOwnerOperationContext;
  };
  handlers['collective.work.owner.connections'] = async (unsafe, native, caller) => {
    assertActive();if (native) throw new Error('Owner Work operation required');const owner = ownerOperation(caller);
    z.object({input: z.object({}).strict()}).strict().parse(collectiveOwnerOperationInput(unsafe));
    owner.signal.throwIfAborted();await owner.assertCurrent();assertActive();
    const rows = [];
    for (const connection of await connector.listConnections()) {
      if ((await connector.getHostRoute(connection.connectionId))?.localOwnerUserId === owner.userId)
        rows.push({key: connection.connectionId, label: connection.endpointLabel, detail: connection.authorityStatus,
          actions: [operationRowAction('sync', {connectionId: connection.connectionId})]});
    }
    owner.signal.throwIfAborted();await owner.assertCurrent();assertActive();return rowsResult(rows, {empty: 'No owner-paired Collective connections. Open Collective to finish account setup and pair a connection.'});
  };
  handlers['collective.work.owner.sync'] = async (unsafe, native, caller) => {
    assertActive();if (native) throw new Error('Owner Work operation required');const owner = ownerOperation(caller);
    const {input} = z.object({input: syncSchema}).strict().parse(collectiveOwnerOperationInput(unsafe));
    const current = async () => {assertActive();owner.signal.throwIfAborted();await owner.assertCurrent();assertActive();};
    await current();const route = await connector.getHostRoute(input.connectionId);await current();
    if (!route || route.localOwnerUserId !== owner.userId) throw new Error('Connection belongs to another owner');
    await connector.sync(input.connectionId);await current();
    const rows = [];
    for (const item of await connector.listInbox(input.connectionId)) {
      const identity = collectiveEventSourceIdentity(item.event);
      if (item.event.workWakeNotice && item.event.workRequest === 'resume') {
        await current();
        try {
          const sent = await messageCaller.wake(input.connectionId, item.event.eventId, owner.userId, current);
          rows.push({key: item.event.eventId, label: 'Work resumed', detail: `Message ${sent.messageId} sent to the existing Work thread.`});
        } catch (error) {
          await current();rows.push({key: item.event.eventId, label: 'Work resume unavailable', detail: error instanceof Error ? error.message.slice(0, 500) : 'Current Work unavailable'});
        }
        continue;
      }
      if (!identity || !['entrust', 'continue'].includes(String(item.event.workRequest))) continue;
      await current();
      try {
        const sent = await messageCaller.send(input.connectionId, item.event.eventId, owner.userId, current);
        rows.push({key: item.event.eventId, label: 'Work sent', detail: `Message ${sent.messageId} sent to the original Cat thread.`});
      } catch (error) {
        await current();rows.push({key: item.event.eventId, label: 'Private execution unavailable', detail: error instanceof Error ? error.message.slice(0, 500) : 'Current Work is unavailable'});
      }
    }
    await connector.reconcileAcceptedWorkResultFiles(input.connectionId, (scope, publication) => messageArtifacts.sealAccepted(scope, publication, current));
    return rowsResult(rows, {empty: 'No committed Work sources or current execution notices'});
  };
  backend.startBackground(async (connectionId, current) => {
    assertActive();
    const route = await connector.getHostRoute(connectionId);await current();
    if (!route) return;
    for (const item of await connector.listInbox(connectionId)) {
      if (item.event.workWakeNotice && item.event.workRequest === 'resume') {
        assertActive();await current();
        try {await messageCaller.wake(connectionId, item.event.eventId, route.localOwnerUserId, current);}
        catch {assertActive();await current();}
        continue;
      }
      const source = collectiveEventSourceIdentity(item.event);
      if (!source || !['entrust', 'continue'].includes(String(item.event.workRequest))) continue;
      assertActive();await current();
      try {await messageCaller.send(connectionId, item.event.eventId, route.localOwnerUserId, current);}
      catch {assertActive();await current();}
    }
    await connector.reconcileAcceptedWorkResultFiles(connectionId, (scope, publication) => messageArtifacts.sealAccepted(scope, publication, current));
  });
  return {actions: handlers, async dispose() {live = false;await materials.dispose();}};
}
