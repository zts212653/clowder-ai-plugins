import type { FeatureContext, PluginActionHandler } from '@clowder-ai/plugin-sdk';
import type { CollectiveConnector } from './business/connector/connector.js';
import { registeredCollectiveCats } from './entry-control.js';
import { collectiveContextError } from './collective-context-refs.js';
import type { createCollectiveAgentVerification } from './native-agent-verification.js';
import { COLLECTIVE_OWNER_NATIVE_ID, collectiveOwnerSendSchema } from './owner-native-methods.js';

/** Original unrestricted owner send. Public/purpose/private consumers never enter this path. */
export function createCollectiveOwnerSendAction(options: {
  readonly connector: Pick<CollectiveConnector, 'getHostRoute' | 'getProjection' | 'queueAgentMessage'>;
  readonly roster: NonNullable<FeatureContext['participantRoster']>;
  readonly verification: ReturnType<typeof createCollectiveAgentVerification>;
  readonly assertActive: () => void;
}): PluginActionHandler {
  return async (unsafe, action, hostContext) => {
    if (!action || hostContext || action.ownerAuthProvenance !== 'strict')
      throw collectiveContextError('CONNECTOR_OWNER_AUTHORITY_REQUIRED', 'Authenticated unrestricted owner invocation is required');
    if (action.toolExecutionPolicy !== undefined)
      throw collectiveContextError('EXACT_COLLECTIVE_RETURN_REQUIRED', 'Limited participation or Work must use its exact return operation');
    const parsed = collectiveOwnerSendSchema.safeParse(unsafe);
    if (!parsed.success) throw Object.assign(parsed.error, { code: 'INVALID_COLLECTIVE_REQUEST' });
    const { connectionId, ...message } = parsed.data;
    const current = async () => { options.assertActive(); await action.assertCurrent(); options.assertActive(); };
    const profile = async () => {
      await current();
      const route = await options.connector.getHostRoute(connectionId); await current();
      if (route?.localOwnerUserId !== action.userId)
        throw collectiveContextError('CONNECTOR_OWNER_MISMATCH', 'Connection belongs to another owner');
      const connection = await options.connector.getProjection(connectionId); await current();
      if (connection.authorityStatus !== 'connected')
        throw collectiveContextError('PARTICIPATION_REVOKED', 'Connection is not authorized');
      const rows = await options.roster.listForNativeContribution({ contributionId: COLLECTIVE_OWNER_NATIVE_ID }); await current();
      const matches = registeredCollectiveCats(rows.map(({ catId, supported: _supported, ...row }) => ({ ...row, id: catId })), () => true)
        .filter(row => row.id === action.catId);
      if (matches.length !== 1 || !matches[0]!.displayName.trim())
        throw collectiveContextError('AGENT_PROVENANCE_UNVERIFIED', 'Host cannot resolve the current Agent profile');
      return matches[0]!.displayName;
    };
    const displayName = await profile();
    const revalidate = async () => {
      if (await profile() !== displayName)
        throw collectiveContextError('AGENT_PROVENANCE_UNVERIFIED', 'Current Host Agent profile changed');
    };
    const agent = { catId: action.catId, agentId: action.catId, displayName, sessionRef: action.invocationId };
    await revalidate();
    const connection = await options.verification.withOwner(agent, revalidate,
      () => options.connector.queueAgentMessage(connectionId, { ...message, agent }));
    await revalidate();
    return { disposition: 'queued', connection };
  };
}
