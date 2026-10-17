import { parseInteractionActionDraft } from '../../plugin-contract/drafts/interaction-action.mjs';

/**
 * Unpublished author-side shape. The Host selects the target and grants access;
 * forwarding an opaque handle through this client never grants authority.
 */
export function createInteractionDraftClient(featureBinding, hostAdapter) {
  if (!featureBinding?.executionLease || !featureBinding.pluginInstanceId || !featureBinding.featureId)
    throw new TypeError('Host FeatureBinding is required');
  let session;
  return {
    async openCurrentSelection() {
      session = await hostAdapter.openCurrentSelection(featureBinding);
      if (!session?.sessionHandle || !session.bindingGeneration) throw new TypeError('Host session is incomplete');
      return Object.freeze({ ...session });
    },
    async acceptConfirmedAction(input) {
      if (!session) throw new Error('no Host session');
      const action = parseInteractionActionDraft(input);
      if (action.sessionHandle !== session.sessionHandle ||
          action.bindingGeneration !== session.bindingGeneration ||
          action.runtimeLease !== featureBinding.executionLease)
        throw new Error('stale or cross-session action');
      return hostAdapter.acceptConfirmedAction(featureBinding, session, action);
    },
  };
}
