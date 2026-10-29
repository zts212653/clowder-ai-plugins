import { rm } from 'node:fs/promises';
import {createCollectiveAssetResponder, type CollectiveClientAssets} from '../../client-assets.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { maxCollectiveArtifactProposalEnvelopeBytes } from '../contracts/index.js';
import { routeArtifactPost } from './artifact-http-routes.js';
import { routeArtifactMediaHttp } from './artifact-media-http.js';
import { routeMessageAttachmentHttp } from './message-attachment-http.js';
import { routeCollaborationPost } from './collaboration-http-routes.js';
import { CollectiveServiceError } from './errors.js';
import type { GitHubAppManifestSetup } from './github-app-manifest-setup.js';
import { routeGitHubAppSetupGet, routeGitHubAppSetupPost } from './github-app-setup-routes.js';
import { routeCollectiveRead } from './http-read-routes.js';
import {
  applySecurityHeaders,
  clearHumanAuthCompletionCookie,
  forbiddenOrigin,
  normalizedOrigin,
  optionalBearer,
  parseHumanAuthIntent,
  readJsonBody,
  requireAllowedOrigin,
  requireBearer,
  requiredQuery,
  requiredString,
  requireFields,
  requireHumanAuthCompletionCookie,
  setHumanAuthCompletionCookie,
  writeError,
  writeJson,
} from './http-transport.js';
import type { CollectiveServiceStore } from './store.js';
import { routeWorkResultFileGet } from './work-result-file-http.js';

interface CollectiveHttpHandlerOptions {
  readonly store: CollectiveServiceStore;
  readonly serviceOrigin?: string;
  readonly allowedHostOrigins: readonly string[] | ReadonlySet<string>;
  readonly clientAssets?: CollectiveClientAssets;
  readonly bootstrapLinkPath?: string;
  readonly githubAppSetup?: GitHubAppManifestSetup;
}

export function createCollectiveHttpHandler(options: CollectiveHttpHandlerOptions) {
  const allowedOrigins = options.allowedHostOrigins instanceof Set ? options.allowedHostOrigins
    : new Set([...options.allowedHostOrigins].map(origin => new URL(origin).origin));
  const serveAsset = createCollectiveAssetResponder(options.clientAssets);
  return async (request: IncomingMessage, response: ServerResponse) => {
    try {
      const documentNonce = randomBytes(18).toString('base64url');
      applySecurityHeaders(response, allowedOrigins, documentNonce);
      const origin = normalizedOrigin(request.headers.origin);
      if (origin && !allowedOrigins.has(origin)) forbiddenOrigin();
      if (request.method === 'POST' && !origin && !request.headers.authorization) forbiddenOrigin();
      if (origin && allowedOrigins.has(origin)) response.setHeader('access-control-allow-origin', origin);
      if (request.method === 'OPTIONS') {
        response.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
        response.setHeader('access-control-allow-headers', 'authorization,content-type,range,x-collective-message-content,x-collective-human-id');
        response.writeHead(origin && allowedOrigins.has(origin) ? 204 : 403).end();
        return;
      }
      const intendedHuman = request.headers['x-collective-human-id'];
      if (intendedHuman !== undefined) {
        const current = await options.store.requireSession(requireBearer(request));
        if (typeof intendedHuman !== 'string' || current.human.humanId !== intendedHuman)
          throw new CollectiveServiceError('HUMAN_CONTEXT_CHANGED', 'This private expression belongs to a different signed-in person', 409);
      }
      const assetPath = new URL(request.url ?? '/', 'http://collective.local').pathname;
      if (serveAsset(request, response, assetPath, documentNonce)) return;
      await routeRequest(
        options.store,
        options.serviceOrigin,
        allowedOrigins,
        options.bootstrapLinkPath,
        options.githubAppSetup,
        request,
        response,
      );
    } catch (error) {
      writeError(response, error);
    }
  };
}

async function routeRequest(
  store: CollectiveServiceStore,
  serviceOrigin: string | undefined,
  allowedOrigins: ReadonlySet<string>,
  bootstrapLinkPath: string | undefined,
  githubAppSetup: GitHubAppManifestSetup | undefined,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://collective.local');
  const method = request.method ?? 'GET';
  if (await routeMessageAttachmentHttp(store, url, request, response)) return;
  if (await routeArtifactMediaHttp(store, url, request, response)) return;
  if (method === 'GET') {
    await routeGet(store, githubAppSetup, url, request, response);
    return;
  }
  if (method !== 'POST') {
    routeClientFallback(url, response);
    return;
  }
  await routePost(store, serviceOrigin, allowedOrigins, bootstrapLinkPath, githubAppSetup, url, request, response);
}

async function routeGet(
  store: CollectiveServiceStore,
  githubAppSetup: GitHubAppManifestSetup | undefined,
  url: URL,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (url.pathname === '/api/health') {
    writeJson(response, 200, { ok: true, ...store.getMetadata() });
    return;
  }
  if (url.pathname === '/api/meta') {
    writeJson(response, 200, store.getMetadata());
    return;
  }
  if (await routeGitHubAppSetupGet(store, githubAppSetup, url, response)) return;
  if (url.pathname === '/api/auth/github/callback') {
    if (url.searchParams.has('error')) {
      redirectHumanAuthError(response, 'authorization_denied', humanAuthCookieIsSecure(store));
      return;
    }
    try {
      const completion = await store.completeHumanAuth({
        provider: 'github',
        state: requiredQuery(url, 'state'),
        code: requiredQuery(url, 'code'),
      });
      setHumanAuthCompletionCookie(response, completion.completionToken, humanAuthCookieIsSecure(store));
      response.setHeader('location', '/?authCompleted=1');
      response.writeHead(303).end();
    } catch (error) {
      redirectHumanAuthError(response, humanAuthErrorCode(error), humanAuthCookieIsSecure(store));
    }
    return;
  }
  if (routeWorkResultFileGet(store, url, request, response)) return;
  if (await routeCollectiveRead(store, url, request, response)) return;
  routeClientFallback(url, response);
}

type HumanAuthRedirectError =
  | 'authorization_denied'
  | 'authorization_expired'
  | 'identity_conflict'
  | 'provider_unavailable'
  | 'authorization_failed';

function humanAuthErrorCode(error: unknown): HumanAuthRedirectError {
  if (!(error instanceof CollectiveServiceError)) return 'provider_unavailable';
  if (
    error.code === 'AUTH_ATTEMPT_CONSUMED' ||
    error.code === 'AUTH_ATTEMPT_EXPIRED' ||
    error.code === 'INVITE_EXPIRED'
  ) {
    return 'authorization_expired';
  }
  if (error.code === 'AUTH_IDENTITY_CONFLICT') return 'identity_conflict';
  if (error.code === 'AUTH_PROVIDER_NOT_READY' || error.code === 'AUTH_IDENTITY_INVALID') {
    return 'provider_unavailable';
  }
  return 'authorization_failed';
}

function redirectHumanAuthError(response: ServerResponse, code: HumanAuthRedirectError, secure: boolean): void {
  clearHumanAuthCompletionCookie(response, secure);
  response.setHeader('location', `/?authError=${code}`);
  response.writeHead(303).end();
}

async function routePost(
  store: CollectiveServiceStore,
  serviceOrigin: string | undefined,
  allowedOrigins: ReadonlySet<string>,
  bootstrapLinkPath: string | undefined,
  githubAppSetup: GitHubAppManifestSetup | undefined,
  url: URL,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readJsonBody(
    request,
    url.pathname === '/api/artifacts/agent/request' ? maxCollectiveArtifactProposalEnvelopeBytes : undefined,
  );
  if (await routeArtifactPost(store, url.pathname, request, response, body)) return;
  if (await routeGitHubAppSetupPost(store, githubAppSetup, url.pathname, request, response, body)) return;
  if (await routeIdentityPost(store, bootstrapLinkPath, url.pathname, request, response, body)) return;
  if (await routeConnectionPost(store, allowedOrigins, url.pathname, request, response, body)) return;
  if (await routeCollaborationPost(store, url.pathname, request, response, body)) return;
  if (await routeEventPost(store, serviceOrigin, url.pathname, request, response, body)) return;
  writeJson(response, 404, { error: { code: 'NOT_FOUND', message: 'Route not found' } });
}

async function routeIdentityPost(
  store: CollectiveServiceStore,
  bootstrapLinkPath: string | undefined,
  pathname: string,
  request: IncomingMessage,
  response: ServerResponse,
  body: Record<string, unknown>,
): Promise<boolean> {
  if (pathname === '/api/channel-state/draft') {
    writeJson(response, 200, await store.saveHumanChannelDraft(requireBearer(request), body)); return true;
  }
  if (pathname === '/api/channel-state/read') {
    writeJson(response, 200, await store.markHumanChannelRead(requireBearer(request), body)); return true;
  }
  if (pathname === '/api/channels') {
    const result = await store.createChannel(requireBearer(request), body);
    writeJson(response, result.status === 'created' ? 201 : 200, result);
    return true;
  }
  if (pathname === '/api/bootstrap') {
    const result = await store.consumeBootstrap(requireFields(body, ['secret', 'displayName']));
    if (bootstrapLinkPath) await rm(bootstrapLinkPath, { force: true }).catch(() => undefined);
    writeJson(response, 201, result);
  } else if (pathname === '/api/collectives') {
    writeJson(
      response,
      201,
      await store.createCollective({
        sessionToken: requireBearer(request),
        name: requiredString(body, 'name'),
      }),
    );
  } else if (pathname === '/api/invites') {
    writeJson(
      response,
      201,
      await store.createInvite({
        sessionToken: requireBearer(request),
        collectiveId: requiredString(body, 'collectiveId'),
      }),
    );
  } else if (pathname === '/api/join') {
    writeJson(response, 201, await store.joinInvite(requireFields(body, ['inviteToken', 'displayName'])));
  } else if (pathname === '/api/memberships/self-leave') {
    writeJson(
      response,
      200,
      await store.leaveCollective({
        sessionToken: requireBearer(request),
        collectiveId: requiredString(body, 'collectiveId'),
      }),
    );
  } else if (pathname === '/api/auth/github/begin') {
    const result = await store.beginHumanAuth({
      provider: 'github',
      intent: parseHumanAuthIntent(body),
      ...(optionalBearer(request) ? { sessionToken: optionalBearer(request) } : {}),
    });
    clearHumanAuthCompletionCookie(response, humanAuthCookieIsSecure(store));
    writeJson(response, 201, result);
  } else if (pathname === '/api/auth/completions/exchange') {
    const secure = humanAuthCookieIsSecure(store);
    try {
      const completionToken = requireHumanAuthCompletionCookie(request);
      const result = await store.exchangeHumanAuthCompletion(completionToken);
      clearHumanAuthCompletionCookie(response, secure);
      writeJson(response, 200, result);
    } catch (error) {
      clearHumanAuthCompletionCookie(response, secure);
      throw error;
    }
  } else {
    return false;
  }
  return true;
}

function humanAuthCookieIsSecure(store: CollectiveServiceStore): boolean {
  return new URL(store.getHumanAuthRedirectUri()).protocol === 'https:';
}

async function routeConnectionPost(
  store: CollectiveServiceStore,
  allowedOrigins: ReadonlySet<string>,
  pathname: string,
  request: IncomingMessage,
  response: ServerResponse,
  body: Record<string, unknown>,
): Promise<boolean> {
  if (pathname === '/api/pairing-intents') {
    const hostOrigin = normalizedOrigin(requiredString(body, 'hostOrigin'));
    requireAllowedOrigin(hostOrigin, allowedOrigins);
    writeJson(
      response,
      201,
      await store.createPairingIntent({
        sessionToken: requireBearer(request),
        collectiveId: requiredString(body, 'collectiveId'),
        hostOrigin,
        nonce: requiredString(body, 'nonce'),
      }),
    );
  } else if (pathname === '/api/connections/exchange') {
    await exchangeConnection(store, allowedOrigins, request, response, body);
  } else if (pathname === '/api/connections/revoke') {
    writeJson(
      response,
      200,
      await store.revokeConnection({
        sessionToken: requireBearer(request),
        collectiveId: requiredString(body, 'collectiveId'),
        connectionId: requiredString(body, 'connectionId'),
      }),
    );
  } else if (pathname === '/api/connections/self-revoke') {
    writeJson(response, 200, await store.revokeOwnConnection(requireBearer(request), body));
  } else {
    return false;
  }
  return true;
}

async function routeEventPost(
  store: CollectiveServiceStore,
  serviceOrigin: string | undefined,
  pathname: string,
  request: IncomingMessage,
  response: ServerResponse,
  body: Record<string, unknown>,
): Promise<boolean> {
  if (pathname === '/api/events/human') {
    writeJson(response, 201, await store.postHumanMessage(requireBearer(request), body));
  } else if (pathname === '/api/events/agent') {
    writeJson(response, 201, await store.postAgentMessage(requireBearer(request), body, serviceOrigin));
  } else if (pathname === '/api/collaboration/work-result-files/bind') {
    writeJson(response, 200, await store.bindAcceptedWorkResultFile(requireBearer(request), body));
  } else if (pathname === '/api/acks') {
    writeJson(response, 200, await store.acknowledge(requireBearer(request), body));
  } else if (pathname === '/api/participation') {
    writeJson(response, 200, await store.publishParticipation(requireBearer(request), body));
  } else if (pathname === '/api/participation/context') {
    writeJson(response, 200, store.readParticipationContext(requireBearer(request), body, String(request.headers['x-collective-message-content'] ?? 'legacy')));
  } else {
    return false;
  }
  return true;
}

async function exchangeConnection(
  store: CollectiveServiceStore,
  allowedOrigins: ReadonlySet<string>,
  request: IncomingMessage,
  response: ServerResponse,
  body: Record<string, unknown>,
): Promise<void> {
  const origin = normalizedOrigin(request.headers.origin);
  requireAllowedOrigin(origin, allowedOrigins);
  const exchange = requireFields(body, [
    'serviceInstanceId',
    'collectiveId',
    'pairingIntentId',
    'hostOrigin',
    'nonce',
    'endpointLabel',
  ]);
  if (normalizedOrigin(exchange.hostOrigin) !== origin) forbiddenOrigin();
  writeJson(response, 201, await store.exchangePairingIntent(exchange));
}

function routeClientFallback(url: URL, response: ServerResponse): void {
  if (url.pathname.startsWith('/api/')) {
    writeJson(response, 404, { error: { code: 'NOT_FOUND', message: 'Route not found' } });
    return;
  }
  writeJson(response, 404, { error: { code: 'CLIENT_UNAVAILABLE', message: 'Client asset not found' } });
}
