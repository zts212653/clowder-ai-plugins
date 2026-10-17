import type { FeatureContext, PluginParticipantWithAvailability } from '@clowder-ai/plugin-sdk';
import type { z } from 'zod';
import type { CollectiveConnector } from './business/connector/connector.js';
import { registeredCollectiveCats } from './entry-control.js';
import { hostRouteBodySchema, validateHostRoute } from './owner-route-validation.js';
import { COLLECTIVE_NATIVE_ID } from './public-native-methods.js';

/** Original owner raw-route PUT; quota is an explicit Host fact, never native support or execution authority. */
export function createCollectiveOwnerRouteChange(context: FeatureContext,
  connector: Pick<CollectiveConnector, 'getProjection' | 'getHostRoute' | 'setHostRoute' | 'publishParticipation'>,
  current: () => Promise<void>) {
  return async (userId: string, connectionId: string, input: z.infer<typeof hostRouteBodySchema>) => {
    await current();
    const connection = await connector.getProjection(connectionId);
    let existing = await connector.getHostRoute(connectionId); await current();
    if (existing && existing.localOwnerUserId !== userId)
      throw Object.assign(new Error('Collective Host route belongs to another local owner'), { code: 'CONNECTOR_OWNER_MISMATCH' });
    if (!connection.authorizedHumanId)
      throw Object.assign(new Error('Collective connection must be paired again before routing'), { code: 'IDENTITY_REBIND_REQUIRED' });
    if (!context.participantRoster || !context.ownerThreads) throw new Error('Host owner route ports unavailable');
    const roster = context.participantRoster, threads = context.ownerThreads;
    const read = async () => {
      await current();
      const rows = await roster.listForNativeContribution({ contributionId: COLLECTIVE_NATIVE_ID, includeAvailability: true });
      await current(); return rows;
    };
    const profile = (rows: readonly PluginParticipantWithAvailability[]) => {
      const byId = new Map(rows.map(row => [row.catId, row]));
      const cats = registeredCollectiveCats(rows.map(({ catId, supported: _supported, available: _available, ...row }) => ({ ...row, id: catId })),
        id => byId.get(id)?.supported === true);
      return { byId, cats };
    };
    const initial = profile(await read());
    const invalid = await validateHostRoute({ isCatAvailable: id => initial.byId.get(id)?.available === true,
      supportsParticipation: id => initial.byId.get(id)?.supported === true,
      resolveAgentIdentity: id => initial.cats.find(cat => cat.id === id),
      threadStore: { async get(id) { await current(); const thread = await threads.get(id); await current(); return thread; } },
    }, userId, connection.authorizedHumanId, input);
    if (invalid) throw Object.assign(new Error(invalid.error), { code: invalid.code, status: 422 });
    // Re-read only the facts used by this edit after owner thread reads; quota/profile changes reject before effects.
    const fresh = profile(await read());
    for (const row of Object.values(input.agentRoutes)) {
      const before = initial.byId.get(row.catId), after = fresh.byId.get(row.catId);
      if (!before || !after || before.available !== after.available ||
          (row.participation && (before.supported !== after.supported ||
            initial.cats.find(cat => cat.id === row.catId)?.displayName !== fresh.cats.find(cat => cat.id === row.catId)?.displayName)))
        throw Object.assign(new Error('Collective route roster changed'), { code: 'ROUTE_ROSTER_CHANGED' });
    }
    const after = await connector.getProjection(connectionId);
    existing = await connector.getHostRoute(connectionId); await current();
    if (after.authorizedHumanId !== connection.authorizedHumanId)
      throw Object.assign(new Error('Collective paired identity changed'), { code: 'IDENTITY_REBIND_REQUIRED' });
    if (existing && existing.localOwnerUserId !== userId)
      throw Object.assign(new Error('Collective Host route belongs to another local owner'), { code: 'CONNECTOR_OWNER_MISMATCH' });
    const scoped = Object.values(input.agentRoutes).some(row => row.participation || row.standingWork) ||
      Object.values(existing?.agentRoutes ?? {}).some(row => row.participation || row.standingWork) ||
      Object.keys(existing?.channelRoutes ?? {}).length > 0;
    if (scoped && input.expectedRevision === undefined)
      throw Object.assign(new Error('Participation revision is required'), { code: 'PARTICIPATION_REVISION_REQUIRED', status: 400 });
    const { expectedRevision, ...routeInput } = input;
    await current();
    const updated = await connector.setHostRoute(connectionId, { localOwnerUserId: userId, ...routeInput }, expectedRevision);
    await current();
    if (scoped) { await connector.publishParticipation(connectionId); await current(); }
    return updated;
  };
}
