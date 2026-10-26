import type { IncomingMessage, ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { collectiveMediaResponseHeaders } from '../contracts/index.js';
import { readJsonBody, requireBearer, writeJson } from './http-transport.js';
import type { CollectiveServiceStore } from './store.js';

/** Authenticated binary traffic avoids JSON envelopes and never puts a bearer into a media URL. */
export async function routeMessageAttachmentHttp(
  store: CollectiveServiceStore,
  url: URL,
  request: IncomingMessage,
  response: ServerResponse,
) {
  if (
    request.method !== 'POST' ||
    ![
      '/api/message-attachments/upload',
      '/api/message-attachments/read',
      '/api/message-attachments/catalog',
      '/api/participation/image',
      '/api/participation/media',
      '/api/participation/sticker',
    ].includes(url.pathname)
  )
    return false;
  const token = requireBearer(request);
  const controller = new AbortController();
  const abort = () => controller.abort();
  response.once('close', abort);
  try {
    const input = Object.fromEntries(url.searchParams);
    if (url.pathname.endsWith('/catalog')) {
      const result = await store.openMessageSticker(token, input, controller.signal);
      response.writeHead(200, {
        'content-type': 'image/png',
        'content-length': result.byteLength,
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
      });
      await pipeline(result.body, response);
    } else if (url.pathname === '/api/participation/image') {
      response.setHeader('cache-control', 'no-store');
      writeJson(
        response,
        200,
        await store.readParticipationImage(token, await readJsonBody(request), controller.signal),
      );
    } else if (url.pathname === '/api/participation/media') {
      response.setHeader('cache-control', 'no-store');
      writeJson(
        response,
        200,
        await store.readParticipationMedia(token, await readJsonBody(request), controller.signal),
      );
    } else if (url.pathname === '/api/participation/sticker') {
      response.setHeader('cache-control', 'no-store');
      writeJson(
        response,
        200,
        await store.prepareParticipationSticker(token, await readJsonBody(request), controller.signal),
      );
    } else if (url.pathname.endsWith('/upload')) {
      writeJson(response, 201, await store.uploadMessageAttachment(token, input, request, controller.signal));
    } else {
      const result = await store.openMessageAttachment(
        token,
        {
          ...input,
          ...(typeof request.headers.range === 'string' ? { range: request.headers.range } : {}),
        },
        controller.signal,
      );
      const headers = collectiveMediaResponseHeaders({
        ...result.attachment,
        status: result.status,
        ...(result.start === undefined ? {} : { start: result.start }),
        ...(result.end === undefined ? {} : { end: result.end }),
      });
      const inline = /^(image\/(png|jpeg|gif|webp)|audio\/(mpeg|mp4|wav|webm|ogg)|video\/(mp4|webm|ogg))$/u.test(
        result.attachment.mediaType,
      );
      headers['content-disposition'] =
        `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(result.attachment.fileName)}`;
      response.writeHead(result.status, headers);
      await pipeline(result.body, response);
    }
    return true;
  } catch (error) {
    if (response.headersSent) {
      response.destroy(error instanceof Error ? error : undefined);
      return true;
    }
    throw error;
  } finally {
    response.off('close', abort);
    controller.abort();
  }
}
