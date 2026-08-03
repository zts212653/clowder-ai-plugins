import assert from 'node:assert/strict';
import test from 'node:test';

import type { PhysicalLimbObservation } from '@clowder-ai/plugin-contract';

import { createCatCafeLimbClient } from './cat-cafe-client.js';

const capabilities = [
  {
    cap: 'limb.observe.touch',
    commands: [] as string[],
    authLevel: 'free' as const,
  },
  {
    cap: 'limb.sensor.microphone',
    commands: [] as string[],
    authLevel: 'gated' as const,
  },
];

function touch(): PhysicalLimbObservation {
  return {
    v: 1,
    observationId: 'touch-1',
    nodeId: 'stackchan-home',
    occurredAt: '2026-08-01T09:10:00.000Z',
    sessionId: 'session-1',
    kind: 'touch',
    payload: { gesture: 'stroke', durationMs: 700, confidence: 1 },
  };
}

test('registers, retains the issued credential, heartbeats, and emits only the observation envelope', async () => {
  const requests: Array<{ url: string; init: RequestInit; body: unknown }> = [];
  const fetchFn: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    const body = init.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    requests.push({ url, init, body });
    if (url.endsWith('/register')) {
      return Response.json({ requestId: 'pair-1', apiKey: 'approved-secret', status: 'pending' });
    }
    if (url.endsWith('/observations')) {
      return Response.json({ status: 'reflex_only' }, { status: 202 });
    }
    return Response.json({ status: 'ok' });
  };
  const changed: string[] = [];
  const client = createCatCafeLimbClient({
    baseUrl: 'http://127.0.0.1:3012',
    nodeId: 'stackchan-home',
    displayName: 'StackChan Home',
    endpointUrl: 'http://127.0.0.1:8788',
    capabilities,
    fetchFn,
    onApiKeyChanged: (apiKey) => {
      changed.push(apiKey);
    },
  });

  assert.deepEqual(await client.register(), {
    requestId: 'pair-1',
    apiKey: 'approved-secret',
    status: 'pending',
  });
  await client.heartbeat();
  assert.deepEqual(await client.emitObservation(touch()), { status: 'reflex_only' });
  await client.deregister();

  assert.deepEqual(changed, ['approved-secret']);
  assert.deepEqual(requests.map((request) => new URL(request.url).pathname), [
    '/api/limb/register',
    '/api/limb/heartbeat',
    '/api/limb/observations',
    '/api/limb/deregister',
  ]);
  assert.deepEqual(requests[0]?.body, {
    nodeId: 'stackchan-home',
    displayName: 'StackChan Home',
    platform: 'stackchan',
    endpointUrl: 'http://127.0.0.1:8788',
    capabilities,
  });
  assert.equal(
    (requests[2]?.init.headers as Record<string, string>).Authorization,
    'Bearer approved-secret',
  );
  assert.deepEqual(requests[2]?.body, { observation: touch() });
});

test('rejects observations outside the canonical contract before sending them to Cat Cafe', async () => {
  let fetchCount = 0;
  const client = createCatCafeLimbClient({
    baseUrl: 'http://127.0.0.1:3012',
    nodeId: 'stackchan-home',
    displayName: 'StackChan Home',
    endpointUrl: 'http://127.0.0.1:8788',
    capabilities,
    apiKey: 'remembered-secret',
    fetchFn: async () => {
      fetchCount += 1;
      return Response.json({ status: 'reflex_only' }, { status: 202 });
    },
  });
  const malformedDateTouch = {
    ...touch(),
    occurredAt: '2026-08-03',
  } as PhysicalLimbObservation;

  await assert.rejects(
    client.emitObservation(malformedDateTouch),
    /Invalid StackChan observation/,
  );
  assert.equal(fetchCount, 0);
});

test('reconnect sends only the configured credential and fails closed on bad or oversized responses', async () => {
  const bodies: unknown[] = [];
  let mode: 'bad' | 'oversized' = 'bad';
  const client = createCatCafeLimbClient({
    baseUrl: 'http://127.0.0.1:3012/',
    nodeId: 'stackchan-home',
    displayName: 'StackChan Home',
    endpointUrl: 'http://127.0.0.1:8788',
    capabilities,
    apiKey: 'remembered-secret',
    fetchFn: async (_input, init = {}) => {
      bodies.push(JSON.parse(String(init.body)) as unknown);
      return mode === 'bad'
        ? new Response('{"status":"approved","extra":true}', {
            headers: { 'content-type': 'application/json' },
          })
        : new Response(JSON.stringify({ error: 'x'.repeat(70_000) }), {
            status: 500,
            headers: { 'content-type': 'application/json' },
          });
    },
  });

  await assert.rejects(client.register(), /invalid registration response/);
  mode = 'oversized';
  await assert.rejects(client.register(), /response exceeds 64 KiB/);
  assert.equal((bodies[0] as Record<string, unknown>).apiKey, 'remembered-secret');
  assert.equal(Object.keys(bodies[0] as Record<string, unknown>).length, 6);
});

test('refuses authenticated operations before registration supplies a credential', async () => {
  const client = createCatCafeLimbClient({
    baseUrl: 'http://127.0.0.1:3012',
    nodeId: 'stackchan-home',
    displayName: 'StackChan Home',
    endpointUrl: 'http://127.0.0.1:8788',
    capabilities,
    fetchFn: async () => {
      throw new Error('must not fetch');
    },
  });

  await assert.rejects(client.heartbeat(), /not registered/);
  await assert.rejects(client.emitObservation(touch()), /not registered/);
  await assert.rejects(client.deregister(), /not registered/);
});

test('cancels a streaming response as soon as the 64 KiB limit is crossed', async () => {
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      controller.enqueue(new Uint8Array(16 * 1_024));
      if (pulls === 16) controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  const client = createCatCafeLimbClient({
    baseUrl: 'http://127.0.0.1:3012',
    nodeId: 'stackchan-home',
    displayName: 'StackChan Home',
    endpointUrl: 'http://127.0.0.1:8788',
    capabilities,
    fetchFn: async () => new Response(body),
  });

  await assert.rejects(client.register(), /response exceeds 64 KiB/);
  assert.equal(cancelled, true);
  assert.ok(pulls < 16, `expected an early stop, got ${pulls} pulls`);
});
