import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CompanionConversation } from '../src/conversation.mjs';

const state = (phase = 'ready') => ({ kind: 'state', phase, displayName: '宪宪', skin: 'xianxian-codex', documentsAllowed: true, toolsReady: true,
  nativeActivity: 'none', liveTransport: { kind: 'gpt_live_v3', verifiedModel: null },
  nativeWork: { scopeId: phase === 'idle' ? null : '0123456789abcdef', revision: 0, active: [], recent: [] },
  duty: { catId: 'opus5', displayName: '宪宪' }, carrier: { catId: 'codex-astra', displayName: '砚砚' } });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture(overrides = {}) {
  const events = [], calls = [], rows = [], peerOperations = [];
  let notify, readiness, closed = false;
  const client = {
    prepare() { calls.push('prepare'); return Promise.resolve(state()); },
    stop: async () => { calls.push('stop'); },
    text: async (...args) => { calls.push(args); },
    state: async () => state('talking'),
    documents: async allowed => ({ ...state('idle'), documentsAllowed: allowed }),
    ...overrides,
  };
  const prepare = client.prepare;
  client.prepare = (...args) => { closed = false; readiness = Promise.resolve(prepare(...args)); return readiness; };
  const peer = {
    connect: async mode => { calls.push('connect'); peerOperations.push(['connect', mode]); await readiness; if (!closed) notify({ type: 'connected' }); },
    close: async () => { closed = true; calls.push('close'); },
    muteMic(value) { peerOperations.push(['microphone', value]); },
    muteSpeaker(value) { peerOperations.push(['speaker', value]); },
  };
  const conversation = new CompanionConversation({ client,
    createPeer: callback => { notify = callback; return peer; },
    render: value => events.push(value), transcript: value => rows.push(value),
    stopScreen: async () => {}, uuid: () => '0a9a8b00-334a-4ee1-9cff-bf77b0f7489',
  });
  return { conversation, calls, events, rows, peer, peerOperations, notify: value => notify(value) };
}
test('typing while idle sends to the Host without a microphone or voice preparation', async () => {
  const f = fixture();
  await f.conversation.refresh();
  assert.equal(await f.conversation.send('只写下来'), true);
  assert.deepEqual(f.calls, [['只写下来', '0a9a8b00-334a-4ee1-9cff-bf77b0f7489']]);
  assert.equal(f.conversation.phase, 'idle');
  assert.equal(f.rows[0].text, '只写下来');
});
test('one click synchronously submits preparation and voice intent before user activation expires', async () => {
  const f = fixture(); const starting = f.conversation.begin();
  assert.deepEqual(f.calls, ['prepare', 'connect']);
  await starting;
  assert.deepEqual(f.calls, ['prepare', 'connect']);
  assert.equal(f.events.at(-1).phase, 'talking');
  assert.equal(f.events.at(-1).identity.duty.catId, 'opus5');
  await f.conversation.end();
});
test('receive-only starts playback without ever issuing a microphone command', async () => {
  const audio = { supportedModes: ['duplex', 'receive_only'], activeMode: null };
  const f = fixture({
    state: async () => ({ ...state('idle'), audio }),
    prepare: async () => ({ ...state(), audio }),
  });
  await f.conversation.refresh();
  await f.conversation.begin('receive_only');
  assert.deepEqual(f.peerOperations, [['speaker', false], ['connect', 'receive_only']]);
  assert.equal(f.events.at(-1).audioMode, 'receive_only');
  assert.match(f.events.at(-1).message, /只听模式 · 麦克风未启用/u);
  f.conversation.muteMic();
  assert.equal(f.peerOperations.some(([kind]) => kind === 'microphone'), false);
  await f.conversation.end();
});
test('receive-only failures never claim that a microphone was opened or route back to voice', async () => {
  const audio = { supportedModes: ['duplex', 'receive_only'], activeMode: null };
  let poll = 0;
  const f = fixture({
    state: async () => ({ ...state(poll++ === 0 ? 'idle' : 'closed'), audio }),
    prepare: async () => ({ ...state(), audio }),
  });
  await f.conversation.refresh();
  await f.conversation.begin('receive_only');
  await f.conversation.refresh();
  assert.match(f.events.at(-1).message, /麦克风未启用.*点击只听重试/u);
  assert.doesNotMatch(f.events.at(-1).message, /点击语音聊|麦克风已关闭/u);

  const stopFailure = fixture({
    state: async () => ({ ...state('idle'), audio }),
    prepare: async () => ({ ...state(), audio }),
    stop: async () => { throw new Error('stop receipt unavailable'); },
  });
  await stopFailure.conversation.refresh();
  await stopFailure.conversation.begin('receive_only');
  await stopFailure.conversation.end();
  assert.match(stopFailure.events.at(-1).message, /麦克风未启用.*收尾尚未确认/u);
  assert.doesNotMatch(stopFailure.events.at(-1).message, /麦克风已关闭/u);
});
test('an old Host without the capability cannot receive a hidden receive-only request', async () => {
  const f = fixture();
  await f.conversation.refresh();
  await f.conversation.begin('receive_only');
  assert.deepEqual(f.calls, []);
  assert.equal(f.conversation.active, false);
});
test('a failed prepare cancels the submitted voice intent and shows only a safe message', async () => {
  const f = fixture({ prepare: async () => { throw new Error('/private/owner token=secret'); } });
  await f.conversation.begin();
  assert.ok(f.calls.includes('close'));
  assert.ok(!f.events.some(event => event.phase === 'talking'));
  assert.equal(f.events.at(-1).phase, 'idle');
  assert.equal(f.events.at(-1).failed, true);
  assert.doesNotMatch(JSON.stringify(f.events), /private|secret/);
});
test('ending while prepare is pending fences every late media continuation', async () => {
  const waiting = deferred(); const f = fixture({ prepare: () => waiting.promise });
  const starting = f.conversation.begin(); await f.conversation.end(); waiting.resolve(state()); await starting;
  assert.ok(!f.events.some(event => event.phase === 'talking'));
  assert.equal(f.calls.filter(call => call === 'connect').length, 1);
  assert.equal(f.conversation.active, false);
});
test('uncertain text stays with its original id and a deliberate retry does not duplicate the visible row', async () => {
  let attempts = 0; const ids = [];
  const f = fixture({ text: async (_text, id) => { ids.push(id); if (++attempts === 1) throw { code: 'unconfirmed' }; } });
  await f.conversation.begin();
  assert.equal(await f.conversation.send('帮我查原文'), false);
  assert.equal(f.rows.length, 0);
  assert.equal(await f.conversation.send('帮我查原文'), true);
  assert.equal(ids[0], ids[1]); assert.equal(f.rows.length, 1);
  await f.conversation.end();
});
test('parallel clicks cannot start two calls or submit text twice', async () => {
  const waiting = deferred(); const f = fixture({ text: async (...args) => { f.calls.push(args); await waiting.promise; } });
  await Promise.all([f.conversation.begin(), f.conversation.begin()]);
  assert.equal(f.calls.filter(c => c === 'prepare').length, 1);
  const first = f.conversation.send('一句'); assert.equal(await f.conversation.send('一句'), false);
  waiting.resolve(); assert.equal(await first, true);
  assert.equal(f.calls.filter(Array.isArray).length, 1); await f.conversation.end();
});
test('a confirmed late send retires its id before the next conversation', async () => {
  const receipt = deferred(), ids = [];
  const f = fixture({ text: async (_text, id) => { ids.push(id); if (ids.length === 1) await receipt.promise; } });
  let sequence = 0;
  f.conversation.uuid = () => `message-${++sequence}`;
  await f.conversation.begin();
  const first = f.conversation.send('好');
  await f.conversation.end(); receipt.resolve(); await first;
  await f.conversation.begin(); await f.conversation.send('好'); await f.conversation.end();
  assert.notEqual(ids[0], ids[1]);
});
test('an accepted text reply after voice stops still clears the sent draft without reviving voice', async () => {
  const receipt = deferred(); const f = fixture({ text: () => receipt.promise });
  await f.conversation.begin();
  const sending = f.conversation.send('已收到的一句');
  await f.conversation.end('通话已经停止'); receipt.resolve();
  assert.equal(await sending, true, 'the composer must consume the successful receipt');
  assert.equal(f.conversation.phase, 'idle');
  assert.equal(f.events.at(-1).message, '通话已经停止');
  assert.equal(f.calls.filter(call => call === 'connect').length, 1);
});
test('changing microphone preference while connecting never claims to be listening', async () => {
  const ready = deferred(); const f = fixture({ prepare: () => ready.promise });
  const begin = f.conversation.begin();
  f.conversation.muteMic(); f.conversation.muteMic();
  const message = f.events.at(-1).message;
  await f.conversation.end(); ready.resolve(state()); await begin;
  assert.doesNotMatch(message, /正在听/);
});
test('a closed Host session releases local media and keeps the next start available', async () => {
  const f = fixture({ state: async () => state('closed') }); await f.conversation.begin();
  await f.conversation.refresh();
  assert.equal(f.conversation.active, false); assert.ok(f.calls.includes('close'));
  assert.equal(f.events.at(-1).phase, 'idle');
});
test('unexpected Host revocation stays visible across status polls without auto-reopening audio', async () => {
  const f = fixture({ state: async () => state('idle') }); await f.conversation.begin();
  await f.conversation.hostStopped('closed'); await f.conversation.refresh();
  assert.equal(f.conversation.active, false);
  assert.equal(f.events.at(-1).failed, true);
  assert.match(f.events.at(-1).message, /中断/);
  assert.equal(f.calls.filter(call => call === 'connect').length, 1);
});
test('the stop echo cannot replace the failure with a generic stopped message', async () => {
  const f = fixture(); await f.conversation.begin();
  await f.conversation.end('连接未恢复 · 点击语音聊重试', true);
  await f.conversation.hostStopped('revoked'); await f.conversation.refresh();
  assert.equal(f.events.at(-1).message, '连接未恢复 · 点击语音聊重试');
});
test('pausing household access invokes the gesture-bound bridge before awaiting cleanup and never auto-restarts', async () => {
  const f = fixture({ documents: allowed => { f.calls.push(['documents', allowed]); return Promise.resolve({ ...state('idle'), documentsAllowed: allowed }); } });
  await f.conversation.begin(); f.calls.length = 0;
  const pause = f.conversation.documents(false);
  assert.deepEqual(f.calls[0], ['documents', false]); await pause;
  assert.equal(f.conversation.active, false);
  assert.equal(f.events.at(-1).identity.documentsAllowed, false);
  assert.ok(!f.calls.includes('connect'));
});
