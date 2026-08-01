import assert from 'node:assert/strict';
import test from 'node:test';

import type { CatCafeLimbRegistration } from './cat-cafe-client.js';
import { createStackChanAdapterRuntime } from './adapter-runtime.js';

test('starts the authenticated local server while pending and consumes no events before approval', async () => {
  const calls: string[] = [];
  let registration: CatCafeLimbRegistration = {
    requestId: 'pair-1',
    apiKey: 'pairing-secret',
    status: 'pending',
  };
  const runtime = createStackChanAdapterRuntime({
    client: {
      async register() {
        calls.push('register');
        return registration;
      },
      async heartbeat() {
        calls.push('heartbeat');
      },
      async emitObservation() {
        return { status: 'reflex_only' };
      },
      async deregister() {
        calls.push('deregister');
      },
      getApiKey() {
        return registration.apiKey;
      },
    },
    createServer(apiKey) {
      assert.equal(apiKey, 'pairing-secret');
      return {
        async start() {
          calls.push('server:start');
          return { host: '127.0.0.1', port: 8788, url: 'http://127.0.0.1:8788' };
        },
        async stop() {
          calls.push('server:stop');
        },
      };
    },
    eventSource: {
      async pollOnce() {
        calls.push('poll');
        return 1;
      },
    },
    schedule: () => ({}) as NodeJS.Timeout,
    cancelSchedule: () => undefined,
  });

  await runtime.start();
  assert.deepEqual(calls, ['register', 'server:start']);

  registration = { ...registration, status: 'approved' };
  assert.deepEqual(await runtime.runOnce(), { status: 'approved', events: 1 });
  assert.deepEqual(calls, [
    'register',
    'server:start',
    'register',
    'heartbeat',
    'poll',
  ]);

  await runtime.stop();
  assert.deepEqual(calls.slice(-2), ['deregister', 'server:stop']);
});

test('rotates the local server when Host issues a replacement key and keeps polling serialized', async () => {
  const calls: string[] = [];
  let key = 'first-secret';
  let releasePoll: (() => void) | undefined;
  const runtime = createStackChanAdapterRuntime({
    client: {
      async register() {
        return { requestId: 'pair-1', apiKey: key, status: 'approved' };
      },
      async heartbeat() {
        calls.push(`heartbeat:${key}`);
      },
      async emitObservation() {
        return { status: 'reflex_only' };
      },
      async deregister() {},
      getApiKey() {
        return key;
      },
    },
    createServer(apiKey) {
      return {
        async start() {
          calls.push(`start:${apiKey}`);
          return { host: '127.0.0.1', port: 8788, url: 'http://127.0.0.1:8788' };
        },
        async stop() {
          calls.push(`stop:${apiKey}`);
        },
      };
    },
    eventSource: {
      async pollOnce() {
        calls.push(`poll:${key}`);
        if (releasePoll === undefined) {
          await new Promise<void>((resolve) => {
            releasePoll = resolve;
          });
        }
        return 0;
      },
    },
    schedule: () => ({}) as NodeJS.Timeout,
    cancelSchedule: () => undefined,
  });

  const first = runtime.start();
  const concurrent = runtime.runOnce();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['start:first-secret', 'heartbeat:first-secret', 'poll:first-secret']);
  releasePoll?.();
  await first;
  assert.deepEqual(await concurrent, { status: 'approved', events: 0 });
  assert.equal(calls.filter((call) => call.startsWith('poll:')).length, 1);

  key = 'second-secret';
  await runtime.runOnce();
  assert.deepEqual(calls.slice(-4), [
    'stop:first-secret',
    'start:second-secret',
    'heartbeat:second-secret',
    'poll:second-secret',
  ]);
  await runtime.stop();
});

test('reports transient scheduled failures and remains retryable', async () => {
  const errors: string[] = [];
  let scheduled: (() => void) | undefined;
  let attempts = 0;
  const runtime = createStackChanAdapterRuntime({
    client: {
      async register() {
        attempts += 1;
        if (attempts === 1) throw new Error('Host unavailable');
        return { requestId: 'pair-1', apiKey: 'pairing-secret', status: 'pending' };
      },
      async heartbeat() {},
      async emitObservation() {
        return { status: 'reflex_only' };
      },
      async deregister() {},
      getApiKey() {
        return undefined;
      },
    },
    createServer() {
      throw new Error('not reached');
    },
    eventSource: { async pollOnce() { return 0; } },
    onError: (error) => errors.push(error.message),
    schedule(callback) {
      scheduled = callback;
      return {} as NodeJS.Timeout;
    },
    cancelSchedule: () => undefined,
  });

  await assert.rejects(runtime.start(), /Host unavailable/);
  assert.deepEqual(errors, ['Host unavailable']);
  scheduled?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 2);
  await runtime.stop();
});

test('keeps the retry timer referenced so a pending daemon stays alive', async () => {
  let unrefCalls = 0;
  const runtime = createStackChanAdapterRuntime({
    client: {
      async register() {
        return { requestId: 'pair-1', apiKey: 'pairing-secret', status: 'pending' };
      },
      async heartbeat() {},
      async emitObservation() {
        return { status: 'reflex_only' };
      },
      async deregister() {},
      getApiKey() {
        return undefined;
      },
    },
    createServer() {
      return {
        async start() {
          return { host: '127.0.0.1', port: 8788, url: 'http://127.0.0.1:8788' };
        },
        async stop() {},
      };
    },
    eventSource: { async pollOnce() { return 0; } },
    schedule() {
      return {
        unref() {
          unrefCalls += 1;
          return this;
        },
      } as unknown as NodeJS.Timeout;
    },
    cancelSchedule: () => undefined,
  });

  await runtime.start();
  assert.equal(unrefCalls, 0);
  await runtime.stop();
});
