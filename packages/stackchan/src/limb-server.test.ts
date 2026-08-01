import assert from 'node:assert/strict';
import test from 'node:test';

import type { PhysicalLimbActionResult } from '@clowder-ai/plugin-contract';

import { createStackChanRemoteLimbServer } from './limb-server.js';

const NOW = 1_785_575_600_000;
const instruction = {
  v: 1,
  actionId: 'action-1',
  nodeId: 'stackchan-home',
  deadlineUnixMs: NOW + 5_000,
  timeoutMs: 5_000,
  cancelToken: 'cancel-1',
  kind: 'speaker',
  payload: {
    text: '我在这里。',
    voiceProfileRef: 'yanyan:local',
    volumePercent: 35,
  },
};

test('exposes authenticated health and schema-validated physical action invoke', async () => {
  const executed: unknown[] = [];
  const server = createStackChanRemoteLimbServer({
    nodeId: 'stackchan-home',
    apiKey: 'approved-key',
    host: '127.0.0.1',
    port: 0,
    health: async () => 'online',
    executor: {
      async execute(value): Promise<PhysicalLimbActionResult> {
        executed.push(value);
        return {
          v: 1,
          actionId: value.actionId,
          nodeId: 'stackchan-home',
          outcome: 'succeeded',
          observedAt: new Date(NOW).toISOString(),
        };
      },
    },
  });

  const address = await server.start();
  try {
    const unauthorized = await fetch(`${address.url}/health`);
    assert.equal(unauthorized.status, 401);

    const health = await fetch(`${address.url}/health`, {
      headers: { authorization: 'Bearer approved-key' },
    });
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'online' });

    const response = await fetch(`${address.url}/invoke`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer approved-key',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        command: 'physical_limb.execute',
        params: { instruction },
      }),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.success, true);
    assert.equal(executed.length, 1);
  } finally {
    await server.stop();
  }
});

test('rejects unknown commands, extra/raw fields, oversized bodies, and node mismatch', async () => {
  let executeCount = 0;
  const server = createStackChanRemoteLimbServer({
    nodeId: 'stackchan-home',
    apiKey: 'approved-key',
    host: '127.0.0.1',
    port: 0,
    health: async () => 'online',
    executor: {
      async execute(value) {
        executeCount += 1;
        return {
          v: 1 as const,
          actionId: value.actionId,
          nodeId: 'stackchan-home',
          outcome: 'succeeded' as const,
          observedAt: new Date(NOW).toISOString(),
        };
      },
    },
  });
  const { url } = await server.start();
  const post = (payload: unknown) =>
    fetch(`${url}/invoke`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer approved-key',
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

  try {
    assert.equal((await post({ command: 'shell', params: {} })).status, 400);
    assert.equal(
      (
        await post({
          command: 'physical_limb.execute',
          params: { instruction: { ...instruction, raw_audio: 'forbidden' } },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await post({
          command: 'physical_limb.execute',
          params: { instruction: { ...instruction, nodeId: 'other-body' } },
        })
      ).status,
      403,
    );
    const oversized = await fetch(`${url}/invoke`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer approved-key',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ padding: 'x'.repeat(70_000) }),
    });
    assert.equal(oversized.status, 413);
    assert.equal(executeCount, 0);
  } finally {
    await server.stop();
  }
});
