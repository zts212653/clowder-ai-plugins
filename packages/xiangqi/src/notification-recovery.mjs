import { pendingConfirmedActions, recordConfirmedActionReceipt } from './store.mjs';

/**
 * Rebuild pending notifications from the committed game journal. The Host owns
 * durable actionId admission and returns the same receipt on an exact retry.
 */
export async function dispatchConfirmedActions(root, gameId, bindingGeneration, session, host) {
  for (const action of pendingConfirmedActions(root, gameId, bindingGeneration)) {
    const receipt = await host.notifyConfirmedMove(session, action);
    recordConfirmedActionReceipt(root, gameId, action.actionId, receipt);
  }
}
