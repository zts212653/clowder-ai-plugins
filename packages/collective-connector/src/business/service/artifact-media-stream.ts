import { Transform } from 'node:stream';
import { collectiveMediaBufferBytes } from '../contracts/index.js';

/** A streaming length fence never buffers a complete range and never lets extra owner bytes pass. */
export function exactMediaLength(length: number) {
  let received = 0;
  return new Transform({
    highWaterMark: collectiveMediaBufferBytes,
    transform(chunk: Buffer, _encoding, done) {
      received += chunk.length;
      if (!Buffer.isBuffer(chunk) || received > length) return done(new Error('Owner media length mismatch'));
      done(null, chunk);
    },
    flush(done) {
      done(received === length ? undefined : new Error('Owner media ended before the exact range'));
    },
  });
}
