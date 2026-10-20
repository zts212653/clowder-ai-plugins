import type { IncomingMessage, ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';
import {
  collectiveMediaDescriptorHeader,
  collectiveMediaErrorHeader,
  collectiveMediaErrorSchema,
  collectiveMediaResponseHeaders,
} from '../contracts/index.js';
import { ZodError } from 'zod';
import { CollectiveServiceError } from './errors.js';
import { readJsonBody, requireBearer, writeJson } from './http-transport.js';
import type { CollectiveServiceStore } from './store.js';

/** Binary POST responses bypass the JSON body reader; metadata polls remain bounded JSON. */
export async function routeArtifactMediaHttp(
  store: CollectiveServiceStore,
  url: URL,
  request: IncomingMessage,
  response: ServerResponse,
) {
  if (
    request.method !== 'POST' ||
    !['/api/artifacts/media/read', '/api/artifacts/media/poll', '/api/artifacts/media/respond'].includes(url.pathname)
  )
    return false;
  const credential = requireBearer(request);
  try {
    if (url.pathname.endsWith('/poll')) {
      writeJson(response, 200, { operations: store.pollArtifactMedia(credential, await readJsonBody(request)) });
      return true;
    }
    if (url.pathname.endsWith('/respond')) {
      await receiveOwnerMedia(store, url, credential, request);
      writeJson(response, 200, { accepted: true });
      return true;
    }
    await sendReaderMedia(store, credential, request, response);
    return true;
  } catch (error) {
    if (error instanceof ZodError)
      throw new CollectiveServiceError('INVALID_ARTIFACT_REQUEST', 'Invalid media range request', 400);
    throw error;
  }
}

async function receiveOwnerMedia(
  store: CollectiveServiceStore,
  url: URL,
  credential: string,
  request: IncomingMessage,
) {
  const metadata = request.headers[collectiveMediaDescriptorHeader],
    error = request.headers[collectiveMediaErrorHeader];
  if (
    (typeof metadata === 'string') === (typeof error === 'string') ||
    (typeof metadata === 'string' && metadata.length > 4096)
  )
    throw new SyntaxError('Invalid media metadata');
  await store.respondArtifactMedia(
    credential,
    Object.fromEntries(url.searchParams),
    typeof metadata === 'string' ? JSON.parse(decodeURIComponent(metadata)) : undefined,
    error === undefined ? undefined : collectiveMediaErrorSchema.parse(error),
    request,
  );
}

async function sendReaderMedia(
  store: CollectiveServiceStore,
  credential: string,
  request: IncomingMessage,
  response: ServerResponse,
) {
  const input = await readJsonBody(request),
    controller = new AbortController();
  const abort = () => controller.abort();
  response.once('close', abort);
  try {
    const { descriptor, body } = await store.requestArtifactMedia(credential, input, controller.signal);
    for (const [name, value] of Object.entries(collectiveMediaResponseHeaders(descriptor)))
      response.setHeader(name, value);
    response.setHeader(collectiveMediaDescriptorHeader, encodeURIComponent(JSON.stringify(descriptor)));
    response.writeHead(descriptor.status);
    await pipeline(body, response);
  } catch (error) {
    if (response.headersSent) {
      response.destroy(error instanceof Error ? error : undefined);
      return;
    }
    throw error;
  } finally {
    response.off('close', abort);
    controller.abort();
  }
}
