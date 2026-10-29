import type { IncomingMessage, ServerResponse } from 'node:http';
import { numberQuery, requireBearer, requiredQuery, writeJson } from './http-transport.js';
import type { CollectiveServiceStore } from './store.js';
import { assertComposerContentReader, assertMessageContentReader, messageContentVersionHeader } from './message-content-compatibility.js';

/** Read APIs retain their authentication and membership checks in the canonical Store. */
export async function routeCollectiveRead(
  store: CollectiveServiceStore,
  url: URL,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  if (url.pathname === '/api/channel-state') {
    const result = store.readHumanChannelState(requireBearer(request), Object.fromEntries(url.searchParams));
    assertComposerContentReader(result.draft.content, String(request.headers[messageContentVersionHeader] ?? 'legacy'));
    writeJson(response, 200, result);
    return true;
  }
  if (url.pathname === '/api/me') {
    writeJson(response, 200, await store.getHumanProjection(requireBearer(request)));
    return true;
  }
  if (url.pathname === '/api/channels') {
    const collectiveId = requiredQuery(url, 'collectiveId');
    writeJson(response, 200, {
      serviceInstanceId: store.serviceInstanceId,
      collectiveId,
      channels: store.listChannels(requireBearer(request), collectiveId),
    });
    return true;
  }
  if (url.pathname === '/api/memberships/self-leave/readiness') {
    writeJson(
      response,
      200,
      store.readMembershipLeaveReadiness(requireBearer(request), requiredQuery(url, 'collectiveId')),
    );
    return true;
  }
  if (url.pathname === '/api/events/human') {
    const collectiveId = requiredQuery(url, 'collectiveId');
    const events = await store.listEventsForHuman(requireBearer(request), collectiveId);
    assertMessageContentReader(events, String(request.headers[messageContentVersionHeader] ?? 'legacy'));
    writeJson(response, 200, {
      serviceInstanceId: store.serviceInstanceId,
      collectiveId,
      events,
    });
    return true;
  }
  if (url.pathname === '/api/participants') {
    writeJson(response, 200, {
      participants: store.listParticipants(requireBearer(request), requiredQuery(url, 'collectiveId')),
    });
    return true;
  }
  if (url.pathname === '/api/members') {
    writeJson(response, 200, store.listMembers(requireBearer(request), requiredQuery(url, 'collectiveId')));
    return true;
  }
  if (url.pathname === '/api/collaboration') {
    writeJson(
      response,
      200,
      store.listCollectiveCollaboration(requireBearer(request), requiredQuery(url, 'collectiveId')),
    );
    return true;
  }
  if (url.pathname === '/api/collaboration/work/assigned') {
    writeJson(
      response,
      200,
      store.readAssignedWork(requireBearer(request), {
        serviceInstanceId: requiredQuery(url, 'serviceInstanceId'),
        collectiveId: requiredQuery(url, 'collectiveId'),
        connectionId: requiredQuery(url, 'connectionId'),
        workId: requiredQuery(url, 'workId'),
      }),
    );
    return true;
  }
  if (url.pathname === '/api/collaboration/work/assigned-by-assignment') {
    writeJson(
      response,
      200,
      store.readAssignedWorkByAssignment(requireBearer(request), {
        serviceInstanceId: requiredQuery(url, 'serviceInstanceId'),
        collectiveId: requiredQuery(url, 'collectiveId'),
        connectionId: requiredQuery(url, 'connectionId'),
        assignmentEventId: requiredQuery(url, 'assignmentEventId'),
      }),
    );
    return true;
  }
  if (url.pathname === '/api/collaboration/work/accountability/pending') {
    writeJson(
      response,
      200,
      store.readCollectiveAccountabilityAttention(requireBearer(request), {
        serviceInstanceId: requiredQuery(url, 'serviceInstanceId'),
        collectiveId: requiredQuery(url, 'collectiveId'),
        connectionId: requiredQuery(url, 'connectionId'),
        offset: numberQuery(url, 'offset', 0),
        limit: numberQuery(url, 'limit', 50),
        ...(url.searchParams.get('snapshot') ? { snapshot: url.searchParams.get('snapshot') } : {}),
      }),
    );
    return true;
  }
  if (url.pathname === '/api/participation') {
    writeJson(
      response,
      200,
      store.readParticipationDeclaration(requireBearer(request), {
        serviceInstanceId: requiredQuery(url, 'serviceInstanceId'),
        collectiveId: requiredQuery(url, 'collectiveId'),
        connectionId: requiredQuery(url, 'connectionId'),
      }),
    );
    return true;
  }
  if (url.pathname === '/api/events/endpoint') {
    writeJson(
      response,
      200,
      await store.pollEvents(requireBearer(request), {
        serviceInstanceId: requiredQuery(url, 'serviceInstanceId'),
        collectiveId: requiredQuery(url, 'collectiveId'),
        connectionId: requiredQuery(url, 'connectionId'),
        afterSequence: numberQuery(url, 'afterSequence', 0),
        limit: numberQuery(url, 'limit', 100),
      }, String(request.headers[messageContentVersionHeader] ?? 'legacy')),
    );
    return true;
  }
  return false;
}
