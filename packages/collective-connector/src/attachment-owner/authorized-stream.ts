import { Readable } from 'node:stream';

/** Revalidate each chunk; neither a revoked read nor an abandoned response keeps its file open. */
export function authorizedAttachmentStream(source: Readable, authorize: () => Promise<void>, signal: AbortSignal) {
  const body = Readable.from(
    (async function* () {
      try {
        signal.throwIfAborted();
        for await (const chunk of source) {
          await authorize();
          signal.throwIfAborted();
          yield chunk;
        }
      } finally {
        signal.removeEventListener('abort', abort);
        source.destroy();
      }
    })(),
  );
  function abort() {
    source.destroy();
    body.destroy();
  }
  signal.addEventListener('abort', abort, { once: true });
  body.once('close', () => {
    signal.removeEventListener('abort', abort);
    source.destroy();
  });
  if (signal.aborted) abort();
  return body;
}
