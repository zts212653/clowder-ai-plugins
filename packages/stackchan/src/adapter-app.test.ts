import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { CatCafeLimbClient } from './cat-cafe-client.js';
import type { StackChanStreamableHttpMcpCaller } from './mcp-transport.js';
import { createStackChanAdapterApp } from './adapter-app.js';
import type { StackChanAdapterConfig } from './runtime-config.js';

async function fixtureConfig(): Promise<StackChanAdapterConfig> {
  const directory = await mkdtemp(join(tmpdir(), 'stackchan-app-'));
  return {
    nodeId: 'stackchan-home',
    displayName: 'StackChan Home',
    catCafeBaseUrl: 'http://127.0.0.1:3012',
    limbHost: '127.0.0.1',
    limbPort: 0,
    limbEndpointUrl: 'http://127.0.0.1:0',
    gatewayMcpUrl: 'http://127.0.0.1:8767/mcp',
    gatewayToken: '0123456789abcdef',
    eventJsonlPath: join(directory, 'events.jsonl'),
    cursorPath: join(directory, 'cursor.json'),
    apiKeyPath: join(directory, 'limb-api-key'),
    listen: {
      durationMs: 5_000,
      engine: 'faster-whisper',
      language: 'zh',
      lookUpPitch: 50,
      debounceMs: 750,
    },
    safePose: { yawDeg: 0, pitchDeg: 45, timeoutMs: 3_000 },
    expressionFaces: { 'yanyan:replying': 'happy' },
    voiceProfiles: {
      'yanyan:local': {
        voice: 'edge-tts',
        speakerName: 'zh-CN-XiaoxiaoNeural',
      },
    },
    cycleIntervalMs: 1_000,
    capabilities: [
      { cap: 'limb.action.motion', commands: ['physical_limb.execute'], authLevel: 'leased' },
      { cap: 'limb.action.display', commands: ['physical_limb.execute'], authLevel: 'leased' },
      { cap: 'limb.action.light', commands: ['physical_limb.execute'], authLevel: 'leased' },
      { cap: 'limb.action.speaker', commands: ['physical_limb.execute'], authLevel: 'leased' },
      { cap: 'limb.observe.touch', commands: [], authLevel: 'free' },
      { cap: 'limb.sensor.microphone', commands: [], authLevel: 'gated' },
    ],
  };
}

test('connects gateway before registration and closes the runtime before transport', async () => {
  const calls: string[] = [];
  let status: ReturnType<StackChanStreamableHttpMcpCaller['status']> = 'offline';
  const caller: StackChanStreamableHttpMcpCaller = {
    async connect() {
      calls.push('gateway:connect');
      status = 'online';
    },
    async callTool() {
      return { content: [{ type: 'text', text: '{"ok":true}' }] };
    },
    async close() {
      calls.push('gateway:close');
      status = 'offline';
    },
    status() {
      return status;
    },
  };
  const client: CatCafeLimbClient = {
    async register() {
      calls.push('host:register');
      return { requestId: 'pair-1', apiKey: 'pairing-secret', status: 'pending' };
    },
    async heartbeat() {},
    async emitObservation() {
      return { status: 'reflex_only' };
    },
    async deregister() {
      calls.push('host:deregister');
    },
    getApiKey() {
      return undefined;
    },
  };
  const app = await createStackChanAdapterApp(await fixtureConfig(), {
    caller,
    client,
  });

  await app.start();
  assert.deepEqual(calls.slice(0, 2), ['gateway:connect', 'host:register']);
  assert.equal(app.status(), 'online');
  await app.stop();
  assert.equal(calls.at(-1), 'gateway:close');
});

test('keeps retrying after a transient Host registration failure', async () => {
  const errors: string[] = [];
  const caller: StackChanStreamableHttpMcpCaller = {
    async connect() {},
    async callTool() {
      return {};
    },
    async close() {},
    status() {
      return 'online';
    },
  };
  const client: CatCafeLimbClient = {
    async register() {
      throw new Error('Host unavailable');
    },
    async heartbeat() {},
    async emitObservation() {
      return { status: 'reflex_only' };
    },
    async deregister() {},
    getApiKey() {
      return undefined;
    },
  };
  const app = await createStackChanAdapterApp(await fixtureConfig(), {
    caller,
    client,
    onError: (error) => errors.push(error.message),
  });

  await app.start();
  assert.deepEqual(errors, ['Host unavailable']);
  await app.stop();
});
