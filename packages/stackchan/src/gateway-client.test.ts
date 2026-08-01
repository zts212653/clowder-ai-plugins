import assert from 'node:assert/strict';
import test from 'node:test';

import { createStackChanGatewayClient } from './gateway-client.js';

test('maps the bounded listen request to stackchan-mcp and projects transcript metadata only', async () => {
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  const client = createStackChanGatewayClient(
    {
      async callTool(name, input) {
        calls.push({ name, arguments: input });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                engine: 'faster-whisper',
                text: '砚砚你在吗',
                language: 'zh',
                duration_ms: 4_920,
                frame_count: 82,
                sample_rate: 16_000,
                raw_audio: 'must-not-cross',
              }),
            },
          ],
        };
      },
    },
    { yawDeg: 0, pitchDeg: 35, timeoutMs: 2_000 },
  );

  assert.deepEqual(
    await client.listen({
      durationMs: 5_000,
      engine: 'faster-whisper',
      language: 'zh',
      motion: 'look-up',
      lookUpPitch: 50,
    }),
    {
      text: '砚砚你在吗',
      language: 'zh',
      durationMs: 5_000,
    },
  );
  assert.deepEqual(calls, [
    {
      name: 'listen',
      arguments: {
        duration_ms: 5_000,
        engine: 'faster-whisper',
        language: 'zh',
        motion: 'look-up',
        look_up_pitch: 50,
      },
    },
  ]);
});

test('fails closed on MCP errors, non-text output, or malformed transcript metadata', async () => {
  const results = [
    { content: [{ type: 'text', text: '{"error":"device disconnected"}' }] },
    { content: [{ type: 'image', data: 'raw-audio' }] },
    { content: [{ type: 'text', text: 'not-json' }] },
    { content: [{ type: 'text', text: '{"text":42,"duration_ms":5000}' }] },
    { content: [{ type: 'text', text: '{"text":"hi","duration_ms":30001}' }] },
  ];

  for (const result of results) {
    const client = createStackChanGatewayClient(
      {
        async callTool() {
          return result;
        },
      },
      { yawDeg: 0, pitchDeg: 35, timeoutMs: 2_000 },
    );

    await assert.rejects(
      client.listen({
        durationMs: 5_000,
        engine: 'faster-whisper',
        language: 'zh',
        motion: 'look-up',
        lookUpPitch: 50,
      }),
    );
  }
});

test('restores the configured safe pose through the bounded gateway tool', async () => {
  const calls: Array<{ name: string; input: Readonly<Record<string, unknown>> }> = [];
  const client = createStackChanGatewayClient(
    {
      async callTool(name, input) {
        calls.push({ name, input });
        return { content: [{ type: 'text', text: '{"ok":true}' }] };
      },
    },
    { yawDeg: 0, pitchDeg: 35, timeoutMs: 2_000 },
  );

  await client.restoreSafePose();
  assert.deepEqual(calls, [
    {
      name: 'move_head',
      input: { yaw: 0, pitch: 35, speed: 'low' },
    },
  ]);
});
