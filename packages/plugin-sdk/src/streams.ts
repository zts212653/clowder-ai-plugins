/** A reference stays owned by its source; ending a reader never deletes it. */
export interface PluginStreamReadOptions { readonly signal?: AbortSignal; }
export interface PluginStreams {
  read(reference: string, options?: PluginStreamReadOptions): AsyncIterable<Uint8Array>;
}

/** Preserve backpressure and recheck lifetime around every awaited chunk. */
export function createStreamsClient(source: PluginStreams, assertCurrent: () => void, lifetime?: AbortSignal): PluginStreams {
  return Object.freeze({
    read(reference: string, options: PluginStreamReadOptions = {}): AsyncIterable<Uint8Array> {
      assertCurrent();
      if (typeof reference !== 'string' || !reference.trim()) throw new TypeError('stream reference must be non-empty');
      const signals = [lifetime, options.signal].filter((signal): signal is AbortSignal => signal !== undefined);
      const signal = signals.length ? AbortSignal.any(signals) : undefined;
      signal?.throwIfAborted();
      return { async *[Symbol.asyncIterator]() {
        assertCurrent(); signal?.throwIfAborted();
        const reader = source.read(reference, signal ? {signal} : {})[Symbol.asyncIterator]();
        let done = false;
        try {
          while (true) {
            assertCurrent(); signal?.throwIfAborted();
            const next = await reader.next();
            assertCurrent(); signal?.throwIfAborted();
            if (next.done) {done = true; return;}
            if (!(next.value instanceof Uint8Array)) throw new TypeError('stream chunks must be Uint8Array');
            yield next.value;
          }
        } finally {
          if (!done) await reader.return?.();
        }
      }};
    },
  });
}
