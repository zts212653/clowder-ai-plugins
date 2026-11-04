import assert from 'node:assert/strict';
import test from 'node:test';
import { createStackChanPlayController, readStackChanDeviceHealth } from './play-controller.js';

const online = { content: [{type: 'text', text: '{"connected":true,"tools_count":20}'}] };
const voices = Object.fromEntries(['xianxian', 'shuosh', 'yanyan'].map((cat) => [`${cat}:local`, {voice: 'edge-tts', speakerName: cat}]));

test('offline robot cannot run a scene even when its gateway transport responds', async () => {
  const calls: string[] = [];
  const caller = { async callTool(name: string) { calls.push(name); return {content: [{type: 'text', text: '{"connected":false,"tools_count":0}'}]}; } };
  assert.equal(await readStackChanDeviceHealth(caller), 'offline');
  const play = createStackChanPlayController({caller, voiceProfiles: voices, safePose: {yawDeg: 0, pitchDeg: 35, timeoutMs: 3000}, canPlay: () => true});
  await assert.rejects(play.run('bicker'), /尚未连接/);
  assert.deepEqual(calls, ['get_status', 'get_status']);
});

test('three cats take distinct turns with configured voices and bounded motion', async () => {
  const calls: Array<{name: string; args: Readonly<Record<string, unknown>>}> = [];
  const caller = { async callTool(name: string, args: Readonly<Record<string, unknown>>) { calls.push({name, args}); return name === 'get_status' ? online : {content: [{type: 'text', text: '{"ok":true}'}]}; } };
  const play = createStackChanPlayController({caller, voiceProfiles: voices, safePose: {yawDeg: 0, pitchDeg: 35, timeoutMs: 3000}, canPlay: () => true, wait: async () => {}});
  assert.deepEqual(await play.run('bicker'), {scene: 'bicker', outcome: 'completed'});
  assert.deepEqual(calls.filter(c => c.name === 'say').map(c => c.args.speaker_name), ['xianxian','shuosh','yanyan']);
  assert.deepEqual(calls.filter(c => c.name === 'move_head').map(c => c.args.yaw), [-18,18,0]);
  assert.ok(!calls.some(c => c.name === 'listen' || c.name === 'take_photo'));
});

test('stop interrupts the dance, releases the microphone, and prevents overlapping scenes', async () => {
  const calls: string[] = [];
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const caller = { async callTool(name: string) { calls.push(name); return name === 'get_status' ? online : {content: [{type: 'text', text: '{"ok":true}'}]}; } };
  const play = createStackChanPlayController({caller, voiceProfiles: voices, safePose: {yawDeg: 0, pitchDeg: 35, timeoutMs: 3000}, canPlay: () => true,
    wait: async (_ms, signal) => { entered(); await new Promise<void>((_resolve,reject) => signal.addEventListener('abort', () => reject(signal.reason), {once: true})); },
  });
  const running = play.run('dance');
  await waiting;
  await assert.rejects(play.run('bicker'), /正在互动/);
  assert.deepEqual(await play.run('stop'), {scene: 'stop', outcome: 'stopped'});
  assert.deepEqual(await running, {scene: 'dance', outcome: 'stopped'});
  assert.ok(calls.includes('beat_mode_stop'));
  assert.ok(calls.includes('clear_leds'));
  assert.equal(play.isActive(), false);
});

test('incomplete discovery, malformed results, and tool errors never report a ready body', async () => {
  for (const result of [
    {content: [{type: 'text', text: '{"connected":true,"tools_count":0}'}]},
    {content: [{type: 'text', text: '{"ok":true}'}]},
    {isError: true, content: [{type: 'text', text: '{"connected":true,"tools_count":20}'}]},
    {content: [{type: 'text', text: '{"connected":true,"tools_count":20}'}, {type: 'text', text: '{"error":"disconnected"}'}]},
  ]) assert.equal(await readStackChanDeviceHealth({async callTool() {return result;}}), 'degraded');
});

test('cleanup attempts to stop motion and clear lights even if beat microphone release fails', async () => {
  const calls: string[] = [];
  const caller = {async callTool(name: string) {
    calls.push(name);
    if (name === 'beat_mode_stop') throw new Error('gateway failed to stop beat mode');
    return name === 'get_status' ? online : {content: [{type: 'text', text: '{"ok":true}'}]};
  }};
  const play = createStackChanPlayController({caller, voiceProfiles: voices, safePose: {yawDeg: 0, pitchDeg: 35, timeoutMs: 3000}, canPlay: () => true,
    wait: async () => {throw new Error('transport lost');},
  });
  await assert.rejects(play.run('dance'), /cleanup failed/);
  assert.ok(calls.includes('move_head'));
  assert.ok(calls.includes('clear_leds'));
  assert.equal(play.isActive(), false);
});
