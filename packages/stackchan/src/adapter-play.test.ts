import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createStackChanAdapterApp } from './adapter-app.js';
import type { StackChanAdapterConfig } from './runtime-config.js';
import type { StackChanStreamableHttpMcpCaller } from './mcp-transport.js';
import type { CatCafeLimbClient } from './cat-cafe-client.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'stackchan-interrupt-'));
  const reservation = createServer();
  await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = (reservation.address() as AddressInfo).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const url = `http://127.0.0.1:${port}`;
  const config: StackChanAdapterConfig = {
    nodeId: 'stackchan-home', displayName: 'Test body', catCafeBaseUrl: 'http://127.0.0.1:3012',
    limbHost: '127.0.0.1', limbPort: port, limbEndpointUrl: url,
    gatewayMcpUrl: 'http://127.0.0.1:8767/mcp', gatewayToken: '0123456789abcdef',
    eventJsonlPath: join(root, 'events.jsonl'), cursorPath: join(root, 'cursor.json'),apiKeyPath: join(root,'key'),
    listen: {durationMs: 1000,engine: 'faster-whisper',language: 'zh',lookUpPitch: 55,debounceMs: 750},
    safePose: {yawDeg: 0,pitchDeg: 35,timeoutMs: 2000},expressionFaces: {'yanyan:happy': 'happy'},
    voiceProfiles: Object.fromEntries(['yanyan','shuosh','xianxian'].map(cat => [`${cat}:local`,{voice:'edge-tts',speakerName:cat}])),
    cycleIntervalMs: 100,capabilities: [],
  };
  await writeFile(config.eventJsonlPath,'');
  const calls: Array<{name:string;input:Readonly<Record<string,unknown>>}> = [];
  const errors: string[] = [];
  let entered!: () => void;
  const danceStarted = new Promise<void>(resolve => {entered = resolve;});
  let touchFinished!: () => void;
  const touchResult = new Promise<void>(resolve => {touchFinished = resolve;});
  const caller: StackChanStreamableHttpMcpCaller = {
    async connect() {},async close() {},status: () => 'online',
    async callTool(name,input) {
      calls.push({name,input});
      if (name === 'get_status') return {content:[{type:'text',text:'{"connected":true,"tools_count":20}'}]};
      if (name === 'beat_mode_start') entered();
      if (name === 'beat_mode_stop') throw new Error('previous beat cleanup failed');
      if (name === 'listen') return {content:[{type:'text',text:'{"text":"继续聊天","duration_ms":1000,"language":"zh"}'}]};
      return {content:[{type:'text',text:'{"ok":true}'}]};
    },
  };
  const client: CatCafeLimbClient = {
    async register() {return {requestId:'pair-1',apiKey:'fixture-owner-key',status:'approved'};},
    async heartbeat() {},async deregister() {},getApiKey: () => 'fixture-owner-key',
    async emitObservation(observation) {
      if (observation.kind === 'transcript') touchFinished();
      return {status:'reflex_only'};
    },
  };
  const app = await createStackChanAdapterApp(config,{caller,client,onError(error) {
    errors.push(error.message);
    if (error.message.includes('touch-to-reply failed')) touchFinished();
  }});
  await app.start();
  const post = (path:string,body:unknown) => fetch(`${url}/${path}`,{
    method:'POST',headers:{authorization:'Bearer fixture-owner-key','content-type':'application/json'},body:JSON.stringify(body),
  });
  const playRequest = post('play',{scene:'dance'});
  t.after(async () => {
    await app.stop();
    await playRequest;
    await rm(root,{recursive:true,force:true});
  });
  await danceStarted;
  return {config,calls,errors,post,playRequest,touchResult};
}

test('incoming Limb motion still runs after an interrupted scene reports cleanup failure', {timeout: 3000}, async t => {
  const f = await fixture(t);
  const response = await f.post('invoke',{command:'physical_limb.execute',params:{instruction:{
    v:1,actionId:'next-motion',nodeId:'stackchan-home',deadlineUnixMs:Date.now()+5000,timeoutMs:2000,cancelToken:'next-cancel',
    kind:'motion',payload:{yawDeg:12,pitchDeg:50,speedDps:80,accelerationDps2:240},
  }}});
  assert.equal(response.status,200);
  assert.equal((await response.json() as {data:{outcome:string}}).data.outcome,'succeeded');
  assert.ok(f.calls.some(c => c.name === 'move_head' && c.input.yaw === 12));
  assert.equal((await f.playRequest).status,409,'the failed scene must still report its own failure');
  assert.ok(f.errors.some(error => error.includes('cleanup failed')));
});

test('a real tap event interrupts play and can listen despite the previous scene failure', {timeout: 3000}, async t => {
  const f = await fixture(t);
  await appendFile(f.config.eventJsonlPath,JSON.stringify({
    event_type:'touch',subtype:'tap',duration_ms:180,action:'head_pat',ts:1,ts_unix:Date.now()/1000,session_id:'current-device-session',
  })+'\n');
  await f.touchResult;
  assert.ok(f.calls.some(c => c.name === 'listen'),'tap must reach the microphone after play cleanup');
  assert.equal((await f.playRequest).status,409);
  assert.ok(f.errors.some(error => error.includes('cleanup failed')));
  assert.ok(!f.errors.some(error => error.includes('touch-to-reply failed')));
});
