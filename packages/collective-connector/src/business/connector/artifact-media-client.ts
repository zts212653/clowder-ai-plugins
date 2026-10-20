import { Readable } from 'node:stream';
import {
  type CollectiveArtifactMediaOperation,
  type CollectiveMediaReadRequest,
  collectiveMediaBufferBytes,
  collectiveMediaDescriptorHeader,
  collectiveMediaDescriptorSchema,
  collectiveMediaErrorHeader,
  collectiveMediaOperationSchema,
  collectiveMediaReadRequestSchema,
  collectiveMediaResponseHeaders,
  collectiveMediaResponseLength,
} from '../contracts/index.js';
import { z } from 'zod';
import type { CollectiveArtifactMediaResult } from './artifact-media-owner-port.js';
import { ConnectorTransportError } from './service-client.js';

type Coordinates = Pick<CollectiveMediaReadRequest, 'serviceInstanceId' | 'collectiveId' | 'connectionId'>;
type JsonRequest = (
  url: string,
  path: string,
  options: { method: 'POST'; credential: string; body: unknown },
) => Promise<Record<string, unknown>>;
export class CollectiveArtifactMediaClient {
  constructor(
    private readonly json: JsonRequest,
    private readonly fetchImpl: typeof fetch,
  ) {}
  async poll(url: string, credential: string, input: Coordinates) {
    return z
      .object({ operations: z.array(collectiveMediaOperationSchema).max(2) })
      .strict()
      .parse(await this.json(url, '/api/artifacts/media/poll', { method: 'POST', credential, body: input })).operations;
  }
  async read(url: string, credential: string, unsafe: CollectiveMediaReadRequest, signal: AbortSignal) {
    const input = collectiveMediaReadRequestSchema.parse(unsafe),
      controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    timer.unref();
    let response: Response;
    try {
      response = await this.fetchImpl(`${new URL(url).origin}/api/artifacts/media/read`, {
        method: 'POST',
        redirect: 'error',
        headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
        body: JSON.stringify(input),
        signal: AbortSignal.any([signal, controller.signal]),
      });
    } catch {
      throw new ConnectorTransportError('Media owner is unreachable', 503, 'ARTIFACT_OWNER_UNAVAILABLE');
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok && response.status !== 416) await mediaTransportError(response);
    try {
      const encoded = response.headers.get(collectiveMediaDescriptorHeader);
      if (!encoded || encoded.length > 4096 || !response.body) throw new Error('Missing media descriptor');
      const descriptor = collectiveMediaDescriptorSchema.parse(JSON.parse(decodeURIComponent(encoded)));
      if (
        descriptor.ownerRevision !== input.ownerRevision ||
        descriptor.status !== response.status ||
        Object.entries(collectiveMediaResponseHeaders(descriptor)).some(
          ([name, value]) => response.headers.get(name) !== value,
        )
      )
        throw new Error('Media descriptor mismatch');
      // Node 20 declarations and DOM declarations model the same WHATWG stream
      // with different generic variance; the runtime is the Node fetch stream.
      const body = Readable.fromWeb(
        response.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>,
        { highWaterMark: collectiveMediaBufferBytes },
      );
      // Cancellation may arrive before the Host attaches its pipeline. Consumers still observe stream.errored.
      body.on('error', () => {});
      body.once('close', () => controller.abort());
      return { descriptor, body };
    } catch (error) {
      await response.body?.cancel().catch(() => {});
      throw error;
    }
  }
  async respond(
    url: string,
    credential: string,
    coordinates: Coordinates,
    operation: CollectiveArtifactMediaOperation,
    result: CollectiveArtifactMediaResult,
    signal: AbortSignal,
  ) {
    const query = new URLSearchParams({ ...coordinates, relayRef: operation.relayRef });
    const headers: Record<string, string> = { authorization: `Bearer ${credential}` };
    let body: ReadableStream | undefined;
    if (result.status === 'ok') {
      headers[collectiveMediaDescriptorHeader] = encodeURIComponent(
        JSON.stringify(collectiveMediaDescriptorSchema.parse(result.descriptor)),
      );
      headers['content-type'] = 'application/octet-stream';
      headers['content-length'] = String(collectiveMediaResponseLength(result.descriptor));
      body = Readable.toWeb(result.body, {
        strategy: { highWaterMark: collectiveMediaBufferBytes, size: (chunk: Uint8Array) => chunk.byteLength },
      }) as unknown as ReadableStream<Uint8Array>;
    } else {
      headers[collectiveMediaErrorHeader] = result.error.code;
      headers['content-length'] = '0';
    }
    const init: RequestInit & { duplex: 'half' } = {
      method: 'POST',
      redirect: 'error',
      headers,
      signal,
      duplex: 'half',
      ...(body ? { body } : {}),
    };
    const response = await this.fetchImpl(`${new URL(url).origin}/api/artifacts/media/respond?${query}`, init);
    if (!response.ok) await mediaTransportError(response);
    await response.body?.cancel();
  }
}

async function mediaTransportError(response: Response): Promise<never> {
  const payload = z
    .object({ error: z.object({ code: z.string(), message: z.string() }) })
    .safeParse(await response.json().catch(() => null));
  throw new ConnectorTransportError(
    payload.success ? payload.data.error.message : 'Media transport failed',
    response.status,
    payload.success ? payload.data.error.code : 'ARTIFACT_OWNER_UNAVAILABLE',
  );
}
