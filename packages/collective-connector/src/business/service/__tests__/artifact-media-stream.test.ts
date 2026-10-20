import { PassThrough, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout } from 'node:timers/promises';
import { collectiveMediaBufferBytes } from '../../contracts/index.js';
import { expect, it } from 'vitest';
import { exactMediaLength } from '../artifact-media-stream.js';

it('an unread consumer backpressures a long synthetic byte source instead of retaining its complete body', async () => {
  let generated = 0;
  const chunk = Buffer.alloc(collectiveMediaBufferBytes, 7),
    count = 8192;
  const source = Readable.from(
    (async function* () {
      for (let index = 0; index < count; index++) {
        generated++;
        yield chunk;
      }
    })(),
    { objectMode: false, highWaterMark: collectiveMediaBufferBytes },
  );
  const target = new PassThrough({ highWaterMark: collectiveMediaBufferBytes });
  const result = pipeline(source, exactMediaLength(count * chunk.length), target).catch(() => {});
  try {
    for (let tick = 0; tick < 20 && generated < 3; tick++) await setTimeout(5);
    expect(generated).toBeGreaterThanOrEqual(3);
    expect(generated).toBeLessThan(10);
    expect(target.readableLength).toBeLessThanOrEqual(collectiveMediaBufferBytes);
    expect(target.writableLength).toBeLessThanOrEqual(collectiveMediaBufferBytes);
  } finally {
    target.destroy();
    await result;
  }
  expect(source.destroyed).toBe(true);
});

it('refuses extra or missing bytes rather than completing a falsely sized response', async () => {
  for (const [bytes, length] of [
    [Buffer.from('abc'), 2],
    [Buffer.from('a'), 2],
  ] as const) {
    const target = new PassThrough();
    target.resume();
    await expect(pipeline(Readable.from([bytes]), exactMediaLength(length), target)).rejects.toThrow(/media/);
  }
});
