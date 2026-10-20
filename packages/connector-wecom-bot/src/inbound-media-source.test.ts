import assert from 'node:assert/strict';
import test from 'node:test';

import type { FeatureContext } from '@clowder-ai/plugin-sdk';

import { createInboundMediaSource, releaseInboundMedia, retainInboundMedia } from './inbound-media-source.js';

test('private media source retains locators across readers and rejects genuinely missing references', async () => {
  const state = new Map<string, { revision: number; value: unknown }>();
  const context = {
    storage: {
      get: async (key: string) => state.get(key),
      list: async () => Object.fromEntries(state),
      set: async (key: string, value: unknown) => {
        const revision = (state.get(key)?.revision ?? 0) + 1;
        state.set(key, { revision, value });
        return { revision };
      },
      compareAndSet: async (key: string, expectedRevision: number | null, value: unknown) => {
        if (expectedRevision !== null || state.has(key)) return { applied: false };
        state.set(key, { revision: 1, value });
        return { applied: true, revision: 1 };
      },
      delete: async (key: string, expectedRevision?: number) => {
        const current = state.get(key);
        if (expectedRevision !== undefined && current?.revision !== expectedRevision) {
          return { deleted: false, revision: current?.revision };
        }
        return { deleted: state.delete(key), revision: current?.revision };
      },
    },
    log() {},
  } as unknown as FeatureContext;
  const retained = await retainInboundMedia(context, 'test', 'test-media', 'provider-event-1', [{
    type: 'image', platformKey: 'provider-secret-locator', fileName: 'photo.png',
  }]);
  const { elements } = retained;
  assert.equal(elements.length, 1);
  const element = elements[0]!;
  assert.equal(element.kind, 'media_ref');
  if (element.kind !== 'media_ref') assert.fail('expected media_ref');
  assert.match(element.payload.reference, /^pmr_test_/u);
  assert.equal(element.payload.sourceId, 'test-media');
  assert.equal(JSON.stringify(elements).includes('provider-secret-locator'), false);
  const replayed = await retainInboundMedia(context, 'test', 'test-media', 'provider-event-1', [{
    type: 'image', platformKey: 'provider-secret-locator', fileName: 'photo.png',
  }]);
  assert.deepEqual(replayed.elements, elements);
  await releaseInboundMedia(
    context,
    retained.ownership,
    Object.assign(new Error('still owned by the in-flight send'), { code: 'RETRYABLE_INFLIGHT' }),
  );
  assert.equal(state.size, 1, 'an indeterminate send result must retain its locator');
  await releaseInboundMedia(
    context,
    replayed.ownership,
    Object.assign(new Error('replay rejected'), { code: 'VALIDATION' }),
  );
  assert.equal(state.size, 1, 'a replay must not release the first delivery\'s locator');
  const conflict = await retainInboundMedia(context, 'test', 'test-media', 'provider-event-1', [{
    type: 'image', platformKey: 'different-provider-locator', fileName: 'photo.png',
  }]);
  assert.equal(conflict.elements[0]?.kind, 'media_unavailable');
  assert.equal(JSON.stringify([...state.values()]).includes('different-provider-locator'), false);

  const collect=async(source:AsyncIterable<Uint8Array>)=>{const chunks=[];for await(const chunk of source)chunks.push(chunk);return Buffer.concat(chunks);};
  for (const providerFailure of [new RangeError('inbound media exceeds the plugin safety limit'),new Error('inbound media download timed out')]) {
    const source=createInboundMediaSource(context,async()=>{throw providerFailure;});
    await assert.rejects(collect(source.read(element.payload.reference)),error=>error===providerFailure);
    assert.equal(state.size,1,'a provider read failure retains the source reference for retry');
  }
  let downloads=0;
  const source=createInboundMediaSource(context,async locator=>{downloads++;assert.equal(locator.platformKey,'provider-secret-locator');return Buffer.alloc(524289,42);});
  const reference=element.payload.reference;
  const lengths=[];for await(const chunk of source.read(reference))lengths.push(chunk.length);
  assert.deepEqual(lengths,[524288,1]);assert.equal(state.size,1);
  for await(const chunk of source.read(reference)){assert.equal(chunk.length,524288);break;}
  assert.equal(state.size,1,'early return only releases its reader');
  assert.equal((await collect(source.read(reference))).length,524289);assert.equal(downloads,3);
  await assert.rejects(collect(source.read('pmr_test_missing')),/source is unavailable/);
  const abort=new AbortController();abort.abort(new Error('reader canceled'));
  await assert.rejects(collect(source.read(reference,{signal:abort.signal})),/reader canceled/);
  assert.equal(state.size,1);
  await releaseInboundMedia(context,retained.ownership,Object.assign(new Error('definitive send rejection'),{code:'VALIDATION'}));
  assert.equal(state.size,0,'only the owning send rejection releases its source');
  const abandoned = await retainInboundMedia(context, 'test', 'test-media', 'provider-event-2', [{
    type: 'file', platformKey: 'private-abandoned-locator',
  }]);
  await releaseInboundMedia(context, abandoned.ownership);
  assert.equal(state.size, 0);
});

test('state failure preserves text delivery with typed unavailable media and no locator', async () => {
  const warnings: unknown[] = [];
  const context = {
    storage: {
      get: async () => undefined,
      set: async () => { throw new Error('state unavailable'); },
      compareAndSet: async () => { throw new Error('state unavailable'); },
      delete: async () => ({ deleted: false }),
    },
    log: (...args: unknown[]) => { warnings.push(args); },
  } as unknown as FeatureContext;
  const retained = await retainInboundMedia(context, 'test', 'test-media', 'provider-event-1', [{
    type: 'image', platformKey: 'provider-secret-locator', fileName: 'photo.png',
  }]);
  const { elements } = retained;
  assert.deepEqual(elements, [{
    elementId: 'media-1', kind: 'media_unavailable',
    payload: { type: 'image', reason: 'unavailable', fileName: 'photo.png' },
  }]);
  assert.equal(JSON.stringify({ elements, warnings }).includes('provider-secret-locator'), false);
});
