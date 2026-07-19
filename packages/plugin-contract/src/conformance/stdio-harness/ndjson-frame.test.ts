import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_NDJSON_FRAME_BYTES,
  NdjsonFrameDecoder,
  NdjsonFrameError,
  encodeNdjsonFrame,
} from './ndjson-frame.js';

test('accepts an exact-limit frame and appends LF outside the byte budget', () => {
  const prefixBytes = Buffer.byteLength('{"payload":""}', 'utf8');
  const payload = 'x'.repeat(MAX_NDJSON_FRAME_BYTES - prefixBytes);

  const encoded = encodeNdjsonFrame({ payload });

  assert.equal(encoded.byteLength, MAX_NDJSON_FRAME_BYTES + 1);
  assert.equal(encoded.at(-1), 0x0a);
});

test('rejects an outbound frame one byte above the hard limit', () => {
  const prefixBytes = Buffer.byteLength('{"payload":""}', 'utf8');
  const payload = 'x'.repeat(MAX_NDJSON_FRAME_BYTES - prefixBytes + 1);

  assert.throws(
    () => encodeNdjsonFrame({ payload }),
    (error: unknown) =>
      error instanceof NdjsonFrameError && error.code === 'FRAME_TOO_LARGE',
  );
});

test('decodes frames split across arbitrary stdout chunks', () => {
  const decoder = new NdjsonFrameDecoder();

  assert.deepEqual(decoder.push(Buffer.from('{"type":"pi')), []);
  const frames = decoder.push(Buffer.from('ng"}\n{"type":"pong"}\n'));
  assert.deepEqual(frames.map(({ value }) => value), [
    { type: 'ping' },
    { type: 'pong' },
  ]);
  assert.deepEqual(decoder.end(), []);
});

test('retains raw frame bytes for the later pre-parse contract validator', () => {
  const decoder = new NdjsonFrameDecoder();
  const raw = '{"id":"first","id":"second"}';

  const [frame] = decoder.push(Buffer.from(`${raw}\n`));

  assert.ok(frame);
  assert.equal(Buffer.from(frame.raw).toString('utf8'), raw);
  assert.deepEqual(frame.value, { id: 'second' });
});

test('rejects an oversized unterminated frame before another chunk arrives', () => {
  const decoder = new NdjsonFrameDecoder();

  assert.throws(
    () => decoder.push(Buffer.alloc(MAX_NDJSON_FRAME_BYTES + 1, 0x78)),
    (error: unknown) =>
      error instanceof NdjsonFrameError && error.code === 'FRAME_TOO_LARGE',
  );
});

test('rejects invalid UTF-8 and non-object JSON frames', () => {
  const invalidUtf8 = new NdjsonFrameDecoder();
  assert.throws(
    () => invalidUtf8.push(Buffer.from([0xc3, 0x28, 0x0a])),
    (error: unknown) =>
      error instanceof NdjsonFrameError && error.code === 'INVALID_UTF8',
  );

  const arrayFrame = new NdjsonFrameDecoder();
  assert.throws(
    () => arrayFrame.push(Buffer.from('[]\n')),
    (error: unknown) =>
      error instanceof NdjsonFrameError && error.code === 'INVALID_FRAME',
  );
});

test('rejects a truncated final frame at stream end', () => {
  const decoder = new NdjsonFrameDecoder();
  decoder.push(Buffer.from('{"type":"partial"}'));

  assert.throws(
    () => decoder.end(),
    (error: unknown) =>
      error instanceof NdjsonFrameError && error.code === 'TRUNCATED_FRAME',
  );
});
