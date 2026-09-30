import assert from 'node:assert/strict';
import test from 'node:test';

import type { FeatureContext } from '@clowder-ai/plugin-sdk';

import { createInboundMediaSourceActions, releaseInboundMedia, retainInboundMedia } from './inbound-media-source.js';

test('private media source retains locator, chunks bytes, settles, and rejects stale references', async () => {
  const state = new Map<string, { revision: number; value: unknown }>();
  const context = {
    state: {
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

  for (const providerFailure of [
    new RangeError('inbound media exceeds the plugin safety limit'),
    new Error('inbound media download timed out'),
  ]) {
    const failedActions = createInboundMediaSourceActions(context, async () => { throw providerFailure; });
    assert.deepEqual(await failedActions.read({ requestId: 'failed-import', reference: element.payload.reference, offset: 0, limit: 1 }), {
      kind: 'rejected', requestId: 'failed-import', code: 'MEDIA_SOURCE_UNAVAILABLE',
    });
  }

  const actions = createInboundMediaSourceActions(context, async (locator) => {
    assert.equal(locator.platformKey, 'provider-secret-locator');
    return Buffer.from('private-bytes');
  });
  const reference = element.payload.reference;
  assert.deepEqual(await actions.read({ requestId: 'request-1', reference, offset: 0, limit: 7 }), {
    kind: 'chunk', requestId: 'request-1', offset: 0,
    dataBase64: Buffer.from('private').toString('base64'), nextOffset: 7, done: false,
  });
  assert.deepEqual(await actions.read({ requestId: 'request-1', reference, offset: 7, limit: 524288 }), {
    kind: 'chunk', requestId: 'request-1', offset: 7,
    dataBase64: Buffer.from('-bytes').toString('base64'), done: true,
  });
  assert.deepEqual(await actions.read({ requestId: 'unknown', reference: 'pmr_test_missing', offset: 0, limit: 1 }), {
    kind: 'rejected', requestId: 'unknown', code: 'MEDIA_SOURCE_UNAVAILABLE',
  });
  await actions.settle({ requestId: 'request-1', reference, outcome: 'imported' });
  assert.equal(state.size, 0);
  assert.deepEqual(await actions.read({ requestId: 'request-2', reference, offset: 0, limit: 1 }), {
    kind: 'rejected', requestId: 'request-2', code: 'MEDIA_SOURCE_UNAVAILABLE',
  });

  const abandoned = await retainInboundMedia(context, 'test', 'test-media', 'provider-event-2', [{
    type: 'file', platformKey: 'private-abandoned-locator',
  }]);
  await releaseInboundMedia(context, abandoned.ownership);
  assert.equal(state.size, 0);
});

test('state failure preserves text delivery with typed unavailable media and no locator', async () => {
  const warnings: unknown[] = [];
  const context = {
    state: {
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
