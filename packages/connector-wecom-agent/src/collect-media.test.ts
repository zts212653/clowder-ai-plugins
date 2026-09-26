import assert from 'node:assert/strict';
import test from 'node:test';

import { collectProviderMedia, ProviderMediaLimitError } from './collect-media.js';

async function* chunks(...values: Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const value of values) yield value;
}

test('collectProviderMedia joins bounded provider chunks', async () => {
  const bytes = await collectProviderMedia('audio', chunks(Buffer.from('first-'), Buffer.from('second')));
  assert.equal(bytes.toString(), 'first-second');
});

test('collectProviderMedia rejects before buffering beyond the provider limit', async () => {
  await assert.rejects(
    collectProviderMedia('image', chunks(new Uint8Array(10 * 1024 * 1024), new Uint8Array([1]))),
    ProviderMediaLimitError,
  );
});

test('collectProviderMedia accepts images larger than the unrelated 2 MiB webhook-card limit', async () => {
  const bytes = await collectProviderMedia('image', chunks(new Uint8Array(5 * 1024 * 1024)));
  assert.equal(bytes.byteLength, 5 * 1024 * 1024);
});
