import { z } from 'zod';
import { rowsResult, operationRowAction } from '@clowder-ai/plugin-sdk';
import type { FeatureContext, PluginActionHandler, PluginOwnerOperationContext } from '@clowder-ai/plugin-sdk';
import type { CollectiveConnector } from './business/connector/connector.js';
import { collectiveEventSourceIdentity } from './business/contracts/index.js';
import { createCollectivePublicSourceCaller } from './collective-public-source.js';
import { createCollectivePublicNativeActions } from './collective-public-native-context.js';
import { openCollectiveContextReferences } from './collective-context-refs.js';
import { COLLECTIVE_NATIVE_ID, COLLECTIVE_PUBLIC_METHODS } from './public-native-methods.js';
import { createAccountabilityAttentionAction } from './accountability-owner-action.js';
import { collectiveOwnerOperationInput } from './owner-operation-input.js';

const syncInput = z.object({ connectionId: z.string().trim().min(1).max(240) }).strict();
export async function activateCollectivePublicNative(context: FeatureContext, connector: CollectiveConnector, assertActive: () => void) {
  if (!context.members)
    throw new Error('Collective native source/owner-thread Host ports are required');
  const references = await openCollectiveContextReferences(context.dataPath, assertActive);
  const sourceCaller = createCollectivePublicSourceCaller({ connector,
    native: { contributionId: COLLECTIVE_NATIVE_ID, methods: COLLECTIVE_PUBLIC_METHODS },
    messaging: context.messaging,
    pluginInstanceId: context.pluginInstanceId, threads: context.threads });
  const inputOf = <T>(value: unknown, schema: z.ZodType<T>) => schema.parse(z.object({ input: z.unknown() }).strict().parse(collectiveOwnerOperationInput(value)).input);
  const list: PluginActionHandler = async (input, native, caller) => {
    if (native || caller?.kind !== 'owner-operation') throw new Error('Collective connections require the authenticated owner operation');
    inputOf(input, z.object({}).strict());
    caller.signal.throwIfAborted(); await caller.assertCurrent(); assertActive();
    const rows = [];
    for (const connection of await connector.listConnections()) {
      if ((await connector.getHostRoute(connection.connectionId))?.localOwnerUserId !== caller.userId) continue;
      rows.push({ key: connection.connectionId, label: connection.endpointLabel,
        detail: `${connection.authorityStatus} · ${connection.liveStatus}`, actions: [operationRowAction('sync', { connectionId: connection.connectionId })] });
    }
    await caller.assertCurrent(); caller.signal.throwIfAborted(); assertActive();
    return rowsResult(rows, { empty: 'No owner-paired Collective connections. Open Collective to finish account setup and pair a connection.' });
  };
  const sync: PluginActionHandler = async (input, native, caller) => {
    if (native || caller?.kind !== 'owner-operation') throw new Error('Collective sync requires the authenticated owner operation');
    const owner: PluginOwnerOperationContext = caller;
    const current = async () => { assertActive(); owner.signal.throwIfAborted(); await owner.assertCurrent(); assertActive(); owner.signal.throwIfAborted(); };
    const { connectionId } = inputOf(input, syncInput);
    await current();
    const route = await connector.getHostRoute(connectionId); await current();
    if (route?.localOwnerUserId !== owner.userId) throw new Error('Collective connection belongs to another owner');
    await connector.sync(connectionId); await current();
    const admissions: { eventId: string; receipt: unknown }[] = [];
    const remaining: string[] = [];
    for (const item of await connector.listInbox(connectionId)) {
      await current();
      if (item.disposition === 'routed') continue;
      const event = item.event;
      // Keep Work and non-exact requests for their original consumer; ordinary sync does not complete them.
      if (!collectiveEventSourceIdentity(event) || event.target.kind !== 'agent' || event.workRequest ||
        event.workAcceptanceNotice || event.workExecutionNotice || event.workRevisionNotice) { remaining.push(event.eventId); continue; }
      admissions.push({ eventId: event.eventId, receipt: await sourceCaller.admitAgentEvent(connectionId, event.eventId, owner) });
      await current();
    }
    return rowsResult([
      ...admissions.map(({ eventId, receipt }) => ({ key: eventId, label: 'Named request sent', detail: JSON.stringify(receipt) })),
      ...remaining.map(eventId => ({ key: eventId, label: 'Original consumer pending', detail: 'This source remains pending its Work or channel consumer.' })),
    ], { empty: 'No pending named requests' });
  };
  return {
    async syncModule(connectionId: string, current: () => Promise<void>, signal: AbortSignal) {
      const route = await connector.getHostRoute(connectionId);await current();
      if (!route) return;
      for (const item of await connector.listInbox(connectionId)) {
        await current();
        const event = item.event;
        if (item.disposition === 'routed' || !collectiveEventSourceIdentity(event) || event.target.kind !== 'agent' ||
          event.workRequest || event.workAcceptanceNotice || event.workExecutionNotice || event.workRevisionNotice) continue;
        await sourceCaller.admitAgentEvent(connectionId, event.eventId, {kind: 'module', userId: route.localOwnerUserId,
          pluginInstanceId: context.pluginInstanceId, signal, assertCurrent: current});
      }
    },
    actions: { ...createCollectivePublicNativeActions({ connector, sourceCaller, references }),
      'collective.owner.accountability-attention': createAccountabilityAttentionAction(connector, assertActive),
      'collective.owner.sync': sync, 'collective.owner.connections': list } };
}
