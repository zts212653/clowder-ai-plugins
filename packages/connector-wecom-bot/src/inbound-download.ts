const MEBIBYTE = 1024 * 1024;

/** Host import is capped at 64 MiB; reject before an adapter buffers beyond it. */
export const INBOUND_MEDIA_MAX_BYTES = 64 * MEBIBYTE;
export const INBOUND_MEDIA_TIMEOUT_MS = 30_000;

export class InboundMediaLimitError extends Error {
  constructor(readonly maxBytes: number) {
    super(`inbound media exceeds the plugin safety limit of ${maxBytes} bytes`);
    this.name = 'InboundMediaLimitError';
  }
}

export async function collectBoundedInboundMedia(
  content: AsyncIterable<Uint8Array>,
  maxBytes = INBOUND_MEDIA_MAX_BYTES,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of content) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new InboundMediaLimitError(maxBytes);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, total);
}

export async function fetchBoundedInboundMedia(
  fetchFn: typeof fetch,
  input: string | URL,
  init: RequestInit = {},
  maxBytes = INBOUND_MEDIA_MAX_BYTES,
  timeoutMs = INBOUND_MEDIA_TIMEOUT_MS,
): Promise<{ readonly response: Response; readonly bytes: Buffer }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('inbound media download timed out')), timeoutMs);
  const signal = init.signal === null || init.signal === undefined
    ? controller.signal
    : AbortSignal.any([init.signal, controller.signal]);
  try {
    const response = await fetchFn(input, { ...init, signal });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { response, bytes: Buffer.alloc(0) };
    }
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      controller.abort();
      await response.body?.cancel().catch(() => undefined);
      throw new InboundMediaLimitError(maxBytes);
    }
    if (response.body === null) return { response, bytes: Buffer.alloc(0) };
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        total += item.value.byteLength;
        if (total > maxBytes) {
          controller.abort();
          await reader.cancel().catch(() => undefined);
          throw new InboundMediaLimitError(maxBytes);
        }
        chunks.push(Buffer.from(item.value));
      }
    } finally {
      reader.releaseLock();
    }
    return { response, bytes: Buffer.concat(chunks, total) };
  } finally {
    clearTimeout(timer);
  }
}
