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

test('missing scene voices are reported before device readiness and cause no physical output', async () => {
  const calls: string[] = [];
  const play = createStackChanPlayController({
    caller: {async callTool(name) {calls.push(name);return {content: [{type: 'text', text: '{"connected":false}'}]};}},
    voiceProfiles: {'yanyan:local': voices['yanyan:local']},
    safePose: {yawDeg: 0, pitchDeg: 35, timeoutMs: 3000},canPlay: () => true,
  });
  await assert.rejects(play.run('bicker'), /缺少短剧声线配置/);
  assert.deepEqual(calls, []);
});

test('interrupting dance or banter never leaves the ordinary speaker muted', async () => {
  for (const scene of ['dance', 'bicker'] as const) {
    const volumes: unknown[] = [];
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => {entered = resolve;});
    const play = createStackChanPlayController({
      caller: {async callTool(name,args) {
        if (name === 'set_volume') volumes.push(args.volume);
        return name === 'get_status' ? online : {content: [{type: 'text',text: '{"ok":true}'}]};
      }}, voiceProfiles: voices,safePose: {yawDeg: 0,pitchDeg: 35,timeoutMs: 3000},canPlay: () => true,
      wait: async (_ms,signal) => {entered();await new Promise<void>((_resolve,reject) => signal.addEventListener('abort',() => reject(signal.reason),{once:true}));},
    });
    const running = play.run(scene);
    await waiting;
    await play.stop();
    await running;
    assert.deepEqual(volumes, scene === 'bicker' ? [35] : []);
  }
});

test('stop aborts a pending readiness request before any output starts', async () => {
  let healthSignal: AbortSignal | undefined;
  let finish!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => {entered = resolve;});
  const play = createStackChanPlayController({
    caller: {async callTool(_name,_args,options) {
      healthSignal = options?.signal;
      entered();
      return new Promise((_resolve,reject) => {
        finish = () => reject(new Error('end test'));
        healthSignal?.addEventListener('abort',() => reject(healthSignal?.reason),{once:true});
      });
    }}, voiceProfiles: voices,safePose: {yawDeg: 0,pitchDeg: 35,timeoutMs: 3000},canPlay: () => true,
  });
  const running = play.run('dance');
  const settled = running.catch(() => undefined);
  await waiting;
  try {
    assert.ok(healthSignal, 'readiness must receive the scene AbortSignal');
    await play.stop();
    assert.equal(healthSignal.aborted,true);
    assert.deepEqual(await running,{scene: 'dance',outcome: 'stopped'});
  } finally {finish();await settled;}
});

test('a scene timeout is reported to its caller without poisoning the next stop or interaction', async (t) => {
  t.mock.timers.enable({apis: ['setTimeout']});
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => {entered = resolve;});
  const play = createStackChanPlayController({
    caller: {async callTool(name) {return name === 'get_status' ? online : {content: [{type: 'text',text: '{"ok":true}'}]};}},
    voiceProfiles: voices,safePose: {yawDeg: 0,pitchDeg: 35,timeoutMs: 3000},canPlay: () => true,
    wait: async (_ms,signal) => {entered();await new Promise<void>((_resolve,reject) => signal.addEventListener('abort',() => reject(signal.reason),{once:true}));},
  });
  const running = play.run('dance');
  const failure = assert.rejects(running,/桌面互动超时/);
  await waiting;
  t.mock.timers.tick(45_000);
  await play.stop();
  await failure;
});

test('the owner can retry physical stop after a scene has failed its first cleanup', async () => {
  let releases = 0;
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => {entered = resolve;});
  const play = createStackChanPlayController({
    caller: {async callTool(name) {
      if (name === 'beat_mode_stop' && ++releases === 1) throw new Error('transient stop failure');
      return name === 'get_status' ? online : {content: [{type:'text',text:'{"ok":true}'}]};
    }},voiceProfiles: voices,safePose: {yawDeg:0,pitchDeg:35,timeoutMs:3000},canPlay: () => true,
    wait: async (_ms,signal) => {entered();await new Promise<void>((_resolve,reject) => signal.addEventListener('abort',() => reject(signal.reason),{once:true}));},
  });
  const running = play.run('dance');
  const failure = assert.rejects(running,/cleanup failed/);
  await waiting;
  await assert.rejects(play.run('stop'),/cleanup failed/);
  await failure;
  assert.deepEqual(await play.run('stop'),{scene:'stop',outcome:'stopped'});
  assert.equal(releases,2,'an idle controller must still allow explicit physical stop recovery');
});
