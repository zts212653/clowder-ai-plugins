import type { Readable, Writable } from 'node:stream';
import { MAX_FRAME_BYTES } from '@clowder-ai/plugin-contract';

/** A schema-neutral protocol frame. Production method schemas are not SDK-owned. */
export type JsonObject = Readonly<Record<string, unknown>>;
export type StdioFrameErrorCode =
  | 'FRAME_TOO_LARGE'
  | 'INVALID_UTF8'
  | 'INVALID_JSON'
  | 'INVALID_FRAME'
  | 'TRUNCATED_FRAME'
  | 'DECODER_CLOSED';

/** Framing failures are fatal: after one, the channel accepts no further input. */
export class StdioFrameError extends Error {
  constructor(
    readonly code: StdioFrameErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'StdioFrameError';
  }
}

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
  frame: JsonObject,
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

interface DecodedFrame {
  readonly value: JsonObject;
}
function assertFrameObject(value: unknown): asserts value is JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new StdioFrameError(
      'INVALID_FRAME',
      'NDJSON frames must contain one non-array JSON object',
    );
  }
}
function assertFrameLimit(maxFrameBytes: number): void {
  if (
    !Number.isSafeInteger(maxFrameBytes) ||
    maxFrameBytes <= 0 ||
    maxFrameBytes > MAX_FRAME_BYTES
  ) {
    throw new RangeError(
      `maxFrameBytes must be a positive safe integer no greater than ${MAX_FRAME_BYTES}`,
    );
  }
}

function decodeFrame(frame: Uint8Array): DecodedFrame {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(frame);
  } catch {
    throw new StdioFrameError('INVALID_UTF8', 'NDJSON frame is not valid UTF-8');
  }

  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new StdioFrameError('INVALID_JSON', 'NDJSON frame is not valid JSON');
  }
  assertFrameObject(value);
  return { value };
}

function encodeFrame(value: JsonObject, maxFrameBytes: number): Buffer {
  assertFrameObject(value);
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new StdioFrameError(
      'INVALID_FRAME',
      'NDJSON frame could not be serialized',
    );
  }
  if (serialized === undefined) {
    throw new StdioFrameError(
      'INVALID_FRAME',
      'NDJSON frame must serialize to one JSON object',
    );
  }

  const encoded = Buffer.from(serialized, 'utf8');
  if (encoded.byteLength > maxFrameBytes) {
    throw new StdioFrameError(
      'FRAME_TOO_LARGE',
      `NDJSON frame is ${encoded.byteLength} bytes; limit is ${maxFrameBytes}`,
    );
  }
  return Buffer.concat([encoded, Buffer.from('\n')], encoded.byteLength + 1);
}

/**
 * Incremental NDJSON decoder used by the SDK runtime.
 *
 * It intentionally consumes only the public contract ceiling, rather than
 * importing the conformance harness: the harness is a test host, while this
 * channel is a reusable runtime primitive.
 */
class NdjsonObjectDecoder {
  private buffered = Buffer.alloc(0);
  private closed = false;
  private failed = false;

  constructor(private readonly maxFrameBytes: number) {}

  push(chunk: Uint8Array): readonly DecodedFrame[] {
    this.assertOpen();
    if (chunk.byteLength === 0) {
      return [];
    }

    const incoming = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const combined = this.buffered.byteLength === 0
      ? incoming
      : Buffer.concat([this.buffered, incoming], this.buffered.byteLength + incoming.byteLength);
    const frames: DecodedFrame[] = [];
    let frameStart = 0;

    try {
      for (let newline = combined.indexOf(0x0a, frameStart); newline !== -1; newline = combined.indexOf(0x0a, frameStart)) {
        const frameLength = newline - frameStart;
        if (frameLength === 0) {
          throw new StdioFrameError('INVALID_FRAME', 'blank NDJSON frames are not allowed');
        }
        if (frameLength > this.maxFrameBytes) {
          throw new StdioFrameError(
            'FRAME_TOO_LARGE',
            `NDJSON frame is ${frameLength} bytes; limit is ${this.maxFrameBytes}`,
          );
        }
        frames.push(decodeFrame(combined.subarray(frameStart, newline)));
        frameStart = newline + 1;
      }

      const remainder = combined.subarray(frameStart);
      if (remainder.byteLength > this.maxFrameBytes) {
        throw new StdioFrameError(
          'FRAME_TOO_LARGE',
          `unterminated NDJSON frame exceeded ${this.maxFrameBytes} bytes`,
        );
      }
      this.buffered = Buffer.from(remainder);
      return frames;
    } catch (error) {
      this.fail();
      throw error;
    }
  }

  end(): void {
    this.assertOpen();
    this.closed = true;
    if (this.buffered.byteLength === 0) {
      return;
    }
    this.buffered = Buffer.alloc(0);
    throw new StdioFrameError(
      'TRUNCATED_FRAME',
      'NDJSON stream ended before the final LF delimiter',
    );
  }

  private assertOpen(): void {
    if (this.closed || this.failed) {
      throw new StdioFrameError('DECODER_CLOSED', 'NDJSON decoder is closed');
    }
  }

  private fail(): void {
    this.failed = true;
    this.buffered = Buffer.alloc(0);
  }
}

function write(output: Writable, frame: Buffer): Promise<void> {
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
  const maxFrameBytes = options.maxFrameBytes ?? MAX_FRAME_BYTES;
  assertFrameLimit(maxFrameBytes);
  const decoder = new NdjsonObjectDecoder(maxFrameBytes);
  let accepting = true;
  let fatalError: StdioRuntimeFatalError | undefined;
  let queue: Promise<void> = Promise.resolve();

  const fail = (reason: StdioRuntimeFatalReason, cause: unknown): void => {
    if (fatalError !== undefined) {
      return;
    }
    accepting = false;
    fatalError = new StdioRuntimeFatalError({ reason, cause });
    input.pause();
    options.onFatal?.(fatalError);
  };

  const send = async (frame: JsonObject): Promise<void> => {
    if (!accepting) {
      throw new StdioFrameError('DECODER_CLOSED', 'stdio channel is closed');
    }
    await write(output, encodeFrame(frame, maxFrameBytes));
  };

  const onData = (chunk: Buffer | string): void => {
    if (!accepting) {
      return;
    }
    let frames: readonly DecodedFrame[];
    try {
      frames = decoder.push(Buffer.from(chunk));
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
          const response = await options.onFrame(frame.value);
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
      if (!accepting) {
        return;
      }
      accepting = false;
      input.off('data', onData);
      input.off('end', onEnd);
      input.off('error', onInputError);
      output.off('error', onOutputError);
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
