import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadStackChanAdapterConfig } from './runtime-config.js';

function validConfig(directory: string): Record<string, unknown> {
  return {
    v: 1,
    nodeId: 'stackchan-home',
    displayName: 'StackChan Home',
    catCafeBaseUrl: 'http://127.0.0.1:3012',
    limbHost: '127.0.0.1',
    limbPort: 8788,
    gatewayMcpUrl: 'http://127.0.0.1:8767/mcp',
    gatewayTokenPath: join(directory, 'gateway-token'),
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
  };
}

test('loads a closed, loopback-only runtime config and its separate bearer token', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stackchan-config-'));
  const path = join(directory, 'adapter.json');
  await writeFile(join(directory, 'gateway-token'), '0123456789abcdef\n', {
    mode: 0o600,
  });
  await writeFile(path, JSON.stringify(validConfig(directory)), { mode: 0o600 });

  const config = await loadStackChanAdapterConfig(path);
  assert.equal(config.gatewayToken, '0123456789abcdef');
  assert.equal(config.limbEndpointUrl, 'http://127.0.0.1:8788');
  assert.deepEqual(config.capabilities, [
    { cap: 'limb.action.motion', commands: ['physical_limb.execute'], authLevel: 'leased' },
    { cap: 'limb.action.display', commands: ['physical_limb.execute'], authLevel: 'leased' },
    { cap: 'limb.action.light', commands: ['physical_limb.execute'], authLevel: 'leased' },
    { cap: 'limb.action.speaker', commands: ['physical_limb.execute'], authLevel: 'leased' },
    { cap: 'limb.observe.touch', commands: [], authLevel: 'free' },
    { cap: 'limb.sensor.microphone', commands: [], authLevel: 'gated' },
  ]);
});

test('rejects remote Host projection, camera grants, and unknown config fields', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stackchan-config-'));
  await writeFile(join(directory, 'gateway-token'), '0123456789abcdef\n', {
    mode: 0o600,
  });
  const path = join(directory, 'adapter.json');

  await writeFile(
    path,
    JSON.stringify({
      ...validConfig(directory),
      catCafeBaseUrl: 'https://cat-cafe.example.com',
    }),
  );
  await assert.rejects(loadStackChanAdapterConfig(path), /loopback/i);

  await writeFile(
    path,
    JSON.stringify({ ...validConfig(directory), cameraEnabled: true }),
  );
  await assert.rejects(loadStackChanAdapterConfig(path), /unknown/i);
});
