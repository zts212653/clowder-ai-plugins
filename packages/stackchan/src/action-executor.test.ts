import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  PhysicalLimbAction,
  PhysicalLimbCancel,
} from '@clowder-ai/plugin-contract';

import { createStackChanActionExecutor } from './action-executor.js';

const NOW = 1_785_575_600_000;

function motionAction(overrides: Partial<PhysicalLimbAction> = {}): PhysicalLimbAction {
  return {
    v: 1,
    actionId: 'action-1',
    nodeId: 'stackchan-home',
    deadlineUnixMs: NOW + 5_000,
    timeoutMs: 5_000,
    cancelToken: 'cancel-1',
    kind: 'motion',
    payload: {
      yawDeg: 12.4,
      pitchDeg: 42.6,
      speedDps: 80,
      accelerationDps2: 240,
    },
    ...overrides,
  } as PhysicalLimbAction;
}

test('maps bounded motion to the gateway allowlist and returns a typed result', async () => {
  const calls: Array<{ name: string; input: Readonly<Record<string, unknown>> }> = [];
  const executor = createStackChanActionExecutor({
    nodeId: 'stackchan-home',
    now: () => NOW,
    safePose: { yawDeg: 0, pitchDeg: 35, timeoutMs: 2_000 },
    expressionFaces: {},
    voiceProfiles: {},
    caller: {
      async callTool(name, input) {
        calls.push({ name, input });
        return { content: [{ type: 'text', text: '{"ok":true}' }] };
      },
    },
  });

  assert.deepEqual(await executor.execute(motionAction()), {
    v: 1,
    actionId: 'action-1',
    nodeId: 'stackchan-home',
    outcome: 'succeeded',
    observedAt: new Date(NOW).toISOString(),
  });
  assert.deepEqual(calls, [
    {
      name: 'move_head',
      input: { yaw: 12, pitch: 43, speed: 80 },
    },
  ]);
});

test('maps approved face, light, and voice refs without forwarding arbitrary refs', async () => {
  const calls: Array<{ name: string; input: Readonly<Record<string, unknown>> }> = [];
  const executor = createStackChanActionExecutor({
    nodeId: 'stackchan-home',
    now: () => NOW,
    safePose: { yawDeg: 0, pitchDeg: 35, timeoutMs: 2_000 },
    expressionFaces: { 'yanyan:happy': 'happy' },
    voiceProfiles: { 'yanyan:local': { voice: 'voicevox', speakerId: 3 } },
    caller: {
      async callTool(name, input) {
        calls.push({ name, input });
        return { content: [{ type: 'text', text: '{"ok":true}' }] };
      },
    },
  });

  const base = {
    v: 1 as const,
    nodeId: 'stackchan-home',
    deadlineUnixMs: NOW + 5_000,
    timeoutMs: 5_000,
  };
  await executor.execute({
    ...base,
    actionId: 'display-1',
    cancelToken: 'cancel-display',
    kind: 'display',
    payload: {
      expression: 'yanyan:happy',
      expressionSource: { kind: 'cat_state', ref: 'state-1' },
    },
  });
  await executor.execute({
    ...base,
    actionId: 'light-1',
    cancelToken: 'cancel-light',
    kind: 'light',
    payload: { colors: [[255, 180, 64]] },
  });
  await executor.execute({
    ...base,
    actionId: 'speaker-1',
    cancelToken: 'cancel-speaker',
    kind: 'speaker',
    payload: {
      text: '我在这里。',
      voiceProfileRef: 'yanyan:local',
      volumePercent: 35,
    },
  });

  assert.deepEqual(calls, [
    { name: 'set_avatar', input: { face: 'happy' } },
    { name: 'set_leds', input: { colors: [[255, 180, 64]] } },
    { name: 'set_volume', input: { volume: 35 } },
    { name: 'say', input: { text: '我在这里。', voice: 'voicevox', speaker_id: 3 } },
  ]);
});

test('refuses stale, cross-node, oversized-light, and unapproved identity actions', async () => {
  let callCount = 0;
  const executor = createStackChanActionExecutor({
    nodeId: 'stackchan-home',
    now: () => NOW,
    safePose: { yawDeg: 0, pitchDeg: 35, timeoutMs: 2_000 },
    expressionFaces: {},
    voiceProfiles: {},
    caller: {
      async callTool() {
        callCount += 1;
        return {};
      },
    },
  });

  const stale = await executor.execute(motionAction({ deadlineUnixMs: NOW - 1 }));
  const otherNode = await executor.execute(motionAction({ nodeId: 'not-this-body' }));
  const unknownFace = await executor.execute({
    v: 1,
    actionId: 'display-1',
    nodeId: 'stackchan-home',
    deadlineUnixMs: NOW + 1_000,
    timeoutMs: 1_000,
    cancelToken: 'cancel-display',
    kind: 'display',
    payload: {
      expression: 'unapproved',
      expressionSource: { kind: 'cat_state', ref: 'state-1' },
    },
  });
  const tooManyLights = await executor.execute({
    v: 1,
    actionId: 'light-1',
    nodeId: 'stackchan-home',
    deadlineUnixMs: NOW + 1_000,
    timeoutMs: 1_000,
    cancelToken: 'cancel-light',
    kind: 'light',
    payload: { colors: Array.from({ length: 13 }, () => [0, 0, 0]) },
  });

  assert.equal(stale.outcome, 'refused');
  assert.equal(otherNode.outcome, 'refused');
  assert.equal(unknownFace.outcome, 'refused');
  assert.equal(tooManyLights.outcome, 'refused');
  assert.equal(callCount, 0);
});

test('cancel stops new output and drives the declared safe pose', async () => {
  const calls: Array<{ name: string; input: Readonly<Record<string, unknown>> }> = [];
  const executor = createStackChanActionExecutor({
    nodeId: 'stackchan-home',
    now: () => NOW,
    safePose: { yawDeg: 0, pitchDeg: 35, timeoutMs: 2_000 },
    expressionFaces: {},
    voiceProfiles: {},
    caller: {
      async callTool(name, input) {
        calls.push({ name, input });
        return { content: [{ type: 'text', text: '{"ok":true}' }] };
      },
    },
  });
  const cancel: PhysicalLimbCancel = {
    v: 1,
    nodeId: 'stackchan-home',
    actionId: 'action-1',
    cancelToken: 'cancel-1',
    reason: 'lease_lost',
  };

  const result = await executor.execute(cancel);

  assert.equal(result.outcome, 'canceled');
  assert.deepEqual(calls, [
    { name: 'move_head', input: { yaw: 0, pitch: 35, speed: 'low' } },
  ]);
});
