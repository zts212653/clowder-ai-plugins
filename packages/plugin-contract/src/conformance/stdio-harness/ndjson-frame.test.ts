import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_NDJSON_FRAME_BYTES,
  NdjsonFrameDecoder,
  NdjsonFrameError,
  encodeNdjsonFrame,
} from './ndjson-frame.js';
import { MAX_FRAME_BYTES } from '../../wire/constants.js';

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

test('rejects limits that could weaken the hard cap before serialization or decoding', () => {
  const invalidLimits = [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    0,
    -1,
    1.5,
    MAX_NDJSON_FRAME_BYTES + 1,
    Number.MAX_SAFE_INTEGER + 1,
  ];

  for (const limit of invalidLimits) {
    let serialized = false;
    assert.throws(
      () =>
        encodeNdjsonFrame(
          {
            toJSON: () => {
              serialized = true;
              return { ok: true };
            },
          },
          limit,
        ),
      RangeError,
    );
    assert.equal(serialized, false, `limit ${String(limit)} serialized the frame`);
    assert.throws(() => new NdjsonFrameDecoder(limit), RangeError);
  }
});

test('does not let an explicit limit bypass the hard cap', () => {
  const prefixBytes = Buffer.byteLength('{"payload":""}', 'utf8');
  const exactPayload = 'x'.repeat(MAX_NDJSON_FRAME_BYTES - prefixBytes);
  const oversizedPayload = `${exactPayload}x`;

  assert.equal(
    encodeNdjsonFrame(
      { payload: exactPayload },
      MAX_NDJSON_FRAME_BYTES,
    ).byteLength,
    MAX_NDJSON_FRAME_BYTES + 1,
  );
  const exactDecoder = new NdjsonFrameDecoder(MAX_NDJSON_FRAME_BYTES);
  const [exactDecoded] = exactDecoder.push(
    Buffer.from(`{"payload":"${exactPayload}"}\n`),
  );
  assert.equal(exactDecoded?.raw.byteLength, MAX_NDJSON_FRAME_BYTES);

  for (const invalidLimit of [
    Number.POSITIVE_INFINITY,
    MAX_NDJSON_FRAME_BYTES + 1,
  ]) {
    assert.throws(
      () => encodeNdjsonFrame({ payload: oversizedPayload }, invalidLimit),
      RangeError,
    );
    assert.throws(() => new NdjsonFrameDecoder(invalidLimit), RangeError);
  }
});

test('allows a caller to choose a stricter positive safe-integer limit', () => {
  const strictLimit = 16;
  const exactFrame = '{"ok":true}';
  const decoder = new NdjsonFrameDecoder(strictLimit);

  assert.equal(
    encodeNdjsonFrame({ ok: true }, strictLimit).byteLength,
    Buffer.byteLength(exactFrame) + 1,
  );
  assert.deepEqual(decoder.push(Buffer.from(`${exactFrame}\n`))[0]?.value, {
    ok: true,
  });

  assert.throws(
    () => encodeNdjsonFrame({ payload: 'too large' }, strictLimit),
    (error: unknown) =>
      error instanceof NdjsonFrameError && error.code === 'FRAME_TOO_LARGE',
  );
});

test('rejects objects whose serialized top-level value is not an object', () => {
  for (const serializedValue of [null, 'scalar', ['array'], undefined]) {
    assert.throws(
      () =>
        encodeNdjsonFrame({
          toJSON: () => serializedValue,
        }),
      (error: unknown) =>
        error instanceof NdjsonFrameError && error.code === 'INVALID_FRAME',
    );
  }
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

test('MAX_NDJSON_FRAME_BYTES is derived from canonical wire MAX_FRAME_BYTES (anti-drift)', () => {
  assert.equal(
    MAX_NDJSON_FRAME_BYTES,
    MAX_FRAME_BYTES,
    'NDJSON frame ceiling must equal the canonical wire constant — if this fails, the two truth sources have drifted',
  );
});
