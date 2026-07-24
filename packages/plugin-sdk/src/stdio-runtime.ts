import type { Readable, Writable } from 'node:stream';
import {
  encodeNdjsonFrame,
  MAX_NDJSON_FRAME_BYTES,
  NdjsonFrameDecoder,
  NdjsonFrameError,
  type DecodedNdjsonFrame,
  type JsonObject,
} from '@clowder-ai/plugin-contract/conformance';

export { NdjsonFrameError } from '@clowder-ai/plugin-contract/conformance';
export type {
  DecodedNdjsonFrame as StdioFrame,
  JsonObject,
  NdjsonFrameErrorCode as StdioFrameErrorCode,
} from '@clowder-ai/plugin-contract/conformance';

export type StdioRuntimeFatalReason =
  | 'FRAME_ERROR'
  | 'HANDLER_ERROR'
  | 'INPUT_ERROR'
  | 'OUTPUT_ERROR';

export interface StdioRuntimeFatalErrorOptions {
  readonly reason: StdioRuntimeFatalReason;
  readonly cause: unknown;
}

/** A terminal channel failure. It deliberately never becomes a protocol frame. */
export class StdioRuntimeFatalError extends Error {
  readonly reason: StdioRuntimeFatalReason;

  constructor(options: StdioRuntimeFatalErrorOptions) {
    super(`stdio runtime stopped after ${options.reason}`, {
      cause: options.cause,
    });
    this.name = 'StdioRuntimeFatalError';
    this.reason = options.reason;
  }
}

export type StdioFrameHandler = (
  frame: DecodedNdjsonFrame,
) => JsonObject | undefined | Promise<JsonObject | undefined>;
export interface StdioChannelOptions {
  /** Defaults to the contract-owned hard cap; callers may only choose a stricter cap. */
  readonly maxFrameBytes?: number;
  readonly onFrame: StdioFrameHandler;
  readonly onFatal?: (error: StdioRuntimeFatalError) => void;
}

export interface StdioRuntimeOptions extends StdioChannelOptions {}
export interface StdioChannel {
  /** Encode and write exactly one object frame followed by LF. */
  send(frame: JsonObject): Promise<void>;
  /** Stop accepting input without closing a stream owned by the caller. */
  close(): void;
  readonly failed: boolean;
}

// Scan a bounded source window at a time. Complete frames are coalesced only
// once before reaching the contract decoder, so a near-cap partial frame is
// neither repeatedly copied nor repeatedly scanned by that decoder.
const MAX_INPUT_DECODE_SLICE_BYTES = 16 * 1024;

function write(output: Writable, frame: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    output.write(frame, error => {
      if (error === null || error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

function nextInputSliceEnd(chunk: Uint8Array, offset: number): number {
  const boundedEnd = Math.min(offset + MAX_INPUT_DECODE_SLICE_BYTES, chunk.byteLength);
  const newline = chunk.subarray(offset, boundedEnd).indexOf(0x0a);
  return newline === -1 ? boundedEnd : offset + newline + 1;
}

/**
 * Connect a schema-neutral NDJSON channel to caller-owned streams.
 *
 * Frame processing is serialized, preserving request order without creating
 * a production request/result vocabulary or a Host Broker substitute.
 */
export function createStdioChannel(
  input: Readable,
  output: Writable,
  options: StdioChannelOptions,
): StdioChannel {
  const readableEncoding = (input as Readable & {
    readonly readableEncoding?: BufferEncoding | null;
  }).readableEncoding;
  if (readableEncoding !== undefined && readableEncoding !== null) {
    throw new RangeError('stdio input must remain in byte mode');
  }
  const decoder = new NdjsonFrameDecoder(options.maxFrameBytes);
  const maxFrameBytes = options.maxFrameBytes ?? MAX_NDJSON_FRAME_BYTES;
  let accepting = true;
  let fatalError: StdioRuntimeFatalError | undefined;
  let detached = false;
  let processing = false;
  let inputEnded = false;
  let decoderEnded = false;
  let undecodedSegments: Uint8Array[] = [];
  let undecodedBytes = 0;

  const discardUndecodedFrame = (): void => {
    undecodedSegments = [];
    undecodedBytes = 0;
  };

  const takeUndecodedFrame = (): Uint8Array | undefined => {
    if (undecodedSegments.length === 0) {
      return undefined;
    }
    const frame =
      undecodedSegments.length === 1
        ? undecodedSegments[0]!
        : Buffer.concat(undecodedSegments, undecodedBytes);
    discardUndecodedFrame();
    return frame;
  };

  const detach = (): void => {
    if (detached) {
      return;
    }
    detached = true;
    input.off('data', onData);
    input.off('end', onEnd);
    input.off('error', onInputError);
    output.off('error', onOutputError);
  };

  const fail = (reason: StdioRuntimeFatalReason, cause: unknown): void => {
    if (fatalError !== undefined) {
      return;
    }
    accepting = false;
    fatalError = new StdioRuntimeFatalError({ reason, cause });
    discardUndecodedFrame();
    input.pause();
    detach();
    options.onFatal?.(fatalError);
  };

  const send = async (frame: JsonObject): Promise<void> => {
    if (!accepting) {
      throw new NdjsonFrameError('DECODER_CLOSED', 'stdio channel is closed');
    }
    const encoded = encodeNdjsonFrame(frame, options.maxFrameBytes);
    try {
      await write(output, encoded);
    } catch (error) {
      fail('OUTPUT_ERROR', error);
      throw error;
    }
  };

  const finishDecoder = (): void => {
    if (!accepting || decoderEnded) {
      return;
    }
    decoderEnded = true;
    try {
      const pendingFrame = takeUndecodedFrame();
      if (pendingFrame !== undefined) {
        decoder.push(pendingFrame);
      }
      decoder.end();
    } catch (error) {
      fail('FRAME_ERROR', error);
    }
  };

  const onData = (chunk: unknown): void => {
    if (!accepting) {
      return;
    }
    if (processing) {
      fail('INPUT_ERROR', new Error('stdio input emitted data while processing was paused'));
      return;
    }
    // A data listener puts Readable into flowing mode. Pause before decoding so
    // a slow handler or output write cannot accumulate an unbounded Promise
    // chain from later source chunks.
    processing = true;
    input.pause();
    if (!(chunk instanceof Uint8Array)) {
      fail(
        'INPUT_ERROR',
        new TypeError('stdio input must emit Uint8Array chunks'),
      );
      return;
    }
    void processChunk(chunk);
  };

  const processChunk = async (chunk: Uint8Array): Promise<void> => {
    try {
      let offset = 0;
      while (offset < chunk.byteLength && accepting) {
        const nextOffset = nextInputSliceEnd(chunk, offset);
        const segment = chunk.subarray(offset, nextOffset);
        undecodedSegments.push(segment);
        undecodedBytes += segment.byteLength;
        offset = nextOffset;
        if (segment.at(-1) !== 0x0a && undecodedBytes <= maxFrameBytes) {
          continue;
        }
        let frames: readonly DecodedNdjsonFrame[];
        try {
          const frame = takeUndecodedFrame();
          if (frame === undefined) {
            continue;
          }
          frames = decoder.push(frame);
        } catch (error) {
          fail('FRAME_ERROR', error);
          return;
        }
        for (const frame of frames) {
          if (!accepting) {
            return;
          }
          const response = await options.onFrame(frame);
          if (response !== undefined && accepting) {
            await send(response);
          }
        }
      }
    } catch (error) {
      fail('HANDLER_ERROR', error);
    } finally {
      processing = false;
      if (inputEnded) {
        finishDecoder();
      } else if (accepting) {
        input.resume();
      }
    }
  };

  const onEnd = (): void => {
    inputEnded = true;
    if (!processing) {
      finishDecoder();
    }
  };

  const onInputError = (error: Error): void => fail('INPUT_ERROR', error);
  const onOutputError = (error: Error): void => fail('OUTPUT_ERROR', error);
  input.on('data', onData);
  input.once('end', onEnd);
  input.once('error', onInputError);
  output.once('error', onOutputError);

  return {
    send,
    close: () => {
      if (detached) {
        return;
      }
      accepting = false;
      discardUndecodedFrame();
      detach();
      input.pause();
    },
    get failed(): boolean {
      return fatalError !== undefined;
    },
  };
}

/**
 * Start the public standalone SDK runtime on the process standard streams.
 * Diagnostics remain out of stdout; callers may observe fatal errors through
 * `onFatal` and choose to write their own stderr diagnostics.
 */
export function startStdioRuntime(options: StdioRuntimeOptions): StdioChannel {
  return createStdioChannel(process.stdin, process.stdout, {
    ...options,
    onFatal: error => {
      process.exitCode = 1;
      // The standalone runtime owns process.stdin. A framing fatal closes that
      // transport immediately, instead of remaining alive until a hostile or
      // broken parent eventually sends EOF.
      process.stdin.destroy();
      options.onFatal?.(error);
    },
  });
}
