import type { IncomingMessage, ServerResponse } from 'node:http';
import { ZodError } from 'zod';
import { CollectiveServiceError } from './errors.js';
import { requireBearer, writeJson } from './http-transport.js';
import type { CollectiveServiceStore } from './store.js';

/** Human sessions and owner endpoint credentials deliberately enter different methods. */
export async function routeArtifactPost(
  store: CollectiveServiceStore,
  pathname: string,
  request: IncomingMessage,
  response: ServerResponse,
  body: Record<string, unknown>,
): Promise<boolean> {
  if (!pathname.startsWith('/api/artifacts/')) return false;
  try {
    return await dispatchArtifactPost(store, pathname, request, response, body);
  } catch (error) {
    if (error instanceof ZodError)
      throw new CollectiveServiceError('INVALID_ARTIFACT_REQUEST', 'Invalid shared work request', 400);
    throw error;
  }
}

async function dispatchArtifactPost(
  store: CollectiveServiceStore,
  pathname: string,
  request: IncomingMessage,
  response: ServerResponse,
  body: Record<string, unknown>,
): Promise<boolean> {
  const credential = requireBearer(request);
  const routes: Record<string, readonly [number, () => unknown]> = {
    '/api/artifacts/media/continuity': [200, async () => await store.recoverMediaCustody(credential, body)],
    '/api/artifacts/register': [201, async () => ({ artifact: await store.registerArtifact(credential, body) })],
    '/api/artifacts/register/context': [200, () => store.readArtifactRegistrationContext(credential, body)],
    '/api/artifacts/publications/prepare': [
      201,
      async () => ({ publication: await store.prepareArtifactPublication(credential, body) }),
    ],
    '/api/artifacts/publications/send': [
      201,
      async () => ({ publication: await store.sendArtifactPublication(credential, body) }),
    ],
    '/api/artifacts/publications/poll': [
      200,
      async () => ({ operations: await store.pollArtifactPublications(credential, body) }),
    ],
    '/api/artifacts/publications/validate': [
      200,
      async () => ({ publication: await store.validateArtifactPublication(credential, body) }),
    ],
    '/api/artifacts/publications/respond': [200, async () => await store.respondArtifactPublication(credential, body)],
    '/api/artifacts/publications/recover': [200, async () => await store.recoverArtifactPublication(credential, body)],
    '/api/artifacts/history': [200, () => store.readArtifactHistory(credential, body)],
    '/api/artifacts/receipts/by-request': [200, () => store.readArtifactRequestReceipt(credential, body)],
    '/api/artifacts/list': [200, () => ({ artifacts: store.listArtifacts(credential, body) })],
    '/api/artifacts/management/read': [200, () => ({ management: store.readArtifactManagement(credential, body) })],
    '/api/artifacts/requests/publish': [201, async () => await store.publishArtifactRequest(credential, body)],
    '/api/artifacts/constraints': [201, () => ({ constraint: store.issueArtifactConstraint(credential, body) })],
    '/api/artifacts/constraints/validate': [
      200,
      () => ({ constraint: store.validateArtifactConstraint(credential, body) }),
    ],
    '/api/artifacts/access/revoke': [
      200,
      async () => ({ artifact: await store.revokeArtifactAccess(credential, body) }),
    ],
    '/api/artifacts/access/update': [
      200,
      async () => ({ artifact: await store.updateArtifactAccess(credential, body) }),
    ],
    '/api/artifacts/custody/offer': [201, async () => await store.offerArtifactCustody(credential, body)],
    '/api/artifacts/custody/accept': [
      200,
      async () => ({ artifact: await store.acceptArtifactCustody(credential, body) }),
    ],
    '/api/artifacts/custody/prepared': [
      200,
      async () => ({ transfer: await store.prepareArtifactCustody(credential, body) }),
    ],
    '/api/artifacts/custody/ready': [
      200,
      async () => ({ transfer: await store.readyArtifactCustody(credential, body) }),
    ],
    '/api/artifacts/custody/state': [200, () => ({ transfer: store.readArtifactCustody(credential, body) })],
    '/api/artifacts/custody/authorize': [200, () => ({ transfer: store.authorizeArtifactCustody(credential, body) })],
    '/api/artifacts/custody/poll': [200, () => ({ transfers: store.pollArtifactCustody(credential, body) })],
    '/api/artifacts/custody/pages/request': [
      200,
      async () => ({ page: await store.requestArtifactCustodyPage(credential, body) }),
    ],
    '/api/artifacts/custody/pages/poll': [
      200,
      () => ({ operations: store.pollArtifactCustodyPages(credential, body) }),
    ],
    '/api/artifacts/custody/pages/respond': [200, () => store.respondArtifactCustodyPage(credential, body)],
    '/api/artifacts/custody/cancel': [
      200,
      async () => ({ transfer: await store.cancelArtifactCustody(credential, body) }),
    ],
    '/api/artifacts/custody/finalized': [
      200,
      async () => ({ transfer: await store.finalizeArtifactCustody(credential, body) }),
    ],
    '/api/artifacts/owner/request': [
      200,
      async () => ({ value: await store.requestArtifactOperation(credential, body) }),
    ],
    '/api/artifacts/agent/request': [
      200,
      async () => ({ value: await store.requestAgentArtifactOperation(credential, body) }),
    ],
    '/api/artifacts/agent/context': [200, () => store.readAgentArtifactContext(credential, body)],
    '/api/artifacts/owner/poll': [200, () => ({ operations: store.pollArtifactOperations(credential, body) })],
    '/api/artifacts/owner/respond': [200, async () => await store.respondArtifactOperation(credential, body)],
  };
  const route = routes[pathname];
  if (!route) return false;
  writeJson(response, route[0], await route[1]());
  return true;
}
