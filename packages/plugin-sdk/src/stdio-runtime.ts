import type { Readable, Writable } from 'node:stream';
import {
  encodeNdjsonFrame,
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
  let accepting = true;
  let fatalError: StdioRuntimeFatalError | undefined;
  let detached = false;
  let queue: Promise<void> = Promise.resolve();

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
    input.pause();
    detach();
    options.onFatal?.(fatalError);
  };

  const send = async (frame: JsonObject): Promise<void> => {
    if (!accepting) {
      throw new NdjsonFrameError('DECODER_CLOSED', 'stdio channel is closed');
    }
    await write(output, encodeNdjsonFrame(frame, options.maxFrameBytes));
  };

  const onData = (chunk: Buffer | string): void => {
    if (!accepting) {
      return;
    }
    if (typeof chunk === 'string') {
      fail(
        'FRAME_ERROR',
        new TypeError('stdio input changed to text mode after channel start'),
      );
      return;
    }
    let frames: readonly DecodedNdjsonFrame[];
    try {
      frames = decoder.push(chunk);
    } catch (error) {
      fail('FRAME_ERROR', error);
      return;
    }
    for (const frame of frames) {
      queue = queue
        .then(async () => {
          if (!accepting) {
            return;
          }
          const response = await options.onFrame(frame);
          if (response !== undefined && accepting) {
            await send(response);
          }
        })
        .catch(error => fail('HANDLER_ERROR', error));
    }
  };

  const onEnd = (): void => {
    if (!accepting) {
      return;
    }
    try {
      decoder.end();
    } catch (error) {
      fail('FRAME_ERROR', error);
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
