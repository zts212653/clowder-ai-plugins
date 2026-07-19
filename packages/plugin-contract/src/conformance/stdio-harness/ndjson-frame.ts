export const MAX_NDJSON_FRAME_BYTES = 1_048_576;

export type JsonObject = Readonly<Record<string, unknown>>;

export interface DecodedNdjsonFrame {
  /** Exact bytes before LF; retained for pre-parse contract validation. */
  readonly raw: Uint8Array;
  /** Convenience parse only; contract validation must still inspect raw. */
  readonly value: JsonObject;
}

export type NdjsonFrameErrorCode =
  | 'FRAME_TOO_LARGE'
  | 'INVALID_UTF8'
  | 'INVALID_JSON'
  | 'INVALID_FRAME'
  | 'TRUNCATED_FRAME'
  | 'DECODER_CLOSED';

export class NdjsonFrameError extends Error {
  constructor(
    readonly code: NdjsonFrameErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'NdjsonFrameError';
  }
}

function assertJsonObject(value: unknown): asserts value is JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new NdjsonFrameError(
      'INVALID_FRAME',
      'NDJSON frames must contain one non-array JSON object',
    );
  }
}

function decodeFrame(frame: Uint8Array): DecodedNdjsonFrame {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(frame);
  } catch {
    throw new NdjsonFrameError('INVALID_UTF8', 'NDJSON frame is not valid UTF-8');
  }

  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new NdjsonFrameError('INVALID_JSON', 'NDJSON frame is not valid JSON');
  }
  assertJsonObject(value);
  return { raw: Buffer.from(frame), value };
}

export function encodeNdjsonFrame(
  value: JsonObject,
  maxFrameBytes = MAX_NDJSON_FRAME_BYTES,
): Uint8Array {
  assertJsonObject(value);
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new NdjsonFrameError(
      'INVALID_FRAME',
      'NDJSON frames must serialize to one non-array JSON object',
    );
  }
  assertJsonObject(JSON.parse(serialized) as unknown);
  const frame = Buffer.from(serialized, 'utf8');
  if (frame.byteLength > maxFrameBytes) {
    throw new NdjsonFrameError(
      'FRAME_TOO_LARGE',
      `NDJSON frame is ${frame.byteLength} bytes; limit is ${maxFrameBytes}`,
    );
  }
  return Buffer.concat([frame, Buffer.from('\n')], frame.byteLength + 1);
}

export class NdjsonFrameDecoder {
  private buffered = Buffer.alloc(0);
  private closed = false;
  private failed = false;

  constructor(private readonly maxFrameBytes = MAX_NDJSON_FRAME_BYTES) {}

  push(chunk: Uint8Array): readonly DecodedNdjsonFrame[] {
    this.assertOpen();
    if (chunk.byteLength === 0) {
      return [];
    }

    const incoming = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const combined =
      this.buffered.byteLength === 0
        ? incoming
        : Buffer.concat(
            [this.buffered, incoming],
            this.buffered.byteLength + incoming.byteLength,
          );
    const frames: DecodedNdjsonFrame[] = [];
    let frameStart = 0;

    try {
      let newline = combined.indexOf(0x0a, frameStart);
      while (newline !== -1) {
        const frameLength = newline - frameStart;
        if (frameLength > this.maxFrameBytes) {
          throw new NdjsonFrameError(
            'FRAME_TOO_LARGE',
            `NDJSON frame is ${frameLength} bytes; limit is ${this.maxFrameBytes}`,
          );
        }
        if (frameLength === 0) {
          throw new NdjsonFrameError('INVALID_FRAME', 'blank NDJSON frames are not allowed');
        }
        frames.push(decodeFrame(combined.subarray(frameStart, newline)));
        frameStart = newline + 1;
        newline = combined.indexOf(0x0a, frameStart);
      }

      const remainder = combined.subarray(frameStart);
      if (remainder.byteLength > this.maxFrameBytes) {
        throw new NdjsonFrameError(
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

  end(): readonly DecodedNdjsonFrame[] {
    this.assertOpen();
    this.closed = true;
    if (this.buffered.byteLength === 0) {
      return [];
    }
    this.buffered = Buffer.alloc(0);
    throw new NdjsonFrameError(
      'TRUNCATED_FRAME',
      'NDJSON stream ended before the final LF delimiter',
    );
  }

  private assertOpen(): void {
    if (this.closed || this.failed) {
      throw new NdjsonFrameError('DECODER_CLOSED', 'NDJSON decoder is closed');
    }
  }

  private fail(): void {
    this.failed = true;
    this.buffered = Buffer.alloc(0);
  }
}
