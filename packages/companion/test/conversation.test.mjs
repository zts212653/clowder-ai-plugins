import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CompanionConversation } from '../src/conversation.mjs';

const CALL_A = '11111111-1111-4111-8111-111111111111';
const CALL_B = '22222222-2222-4222-8222-222222222222';

const state = (phase = 'ready') => ({ kind: 'state', phase, displayName: '宪宪', skin: 'xianxian-codex', documentsAllowed: true, toolsReady: true,
  behaviorEnabled: true,
  nativeActivity: 'none', liveTransport: { kind: 'gpt_live_v3', verifiedModel: null },
  nativeWork: { scopeId: phase === 'idle' ? null : '0123456789abcdef', revision: 0, active: [], recent: [] },
  duty: { catId: 'opus5', displayName: '宪宪' }, carrier: { catId: 'codex-astra', displayName: '砚砚' } });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture(overrides = {}) {
  const { callIds = [CALL_A], ...clientOverrides } = overrides;
  const events = [], calls = [], rows = [], peerOperations = [];
  let notify, readiness, closed = false, connection = 0;
  const client = {
    prepare() { calls.push('prepare'); return Promise.resolve(state()); },
    stop: async () => { calls.push('stop'); },
    text: async (...args) => {
      calls.push(args);
      return { kind: 'delivery', delivery: 'accepted', clientMessageId: args[1], messageId: `message-${args[1]}`, callId: null };
    },
    state: async () => state('talking'),
    documents: async allowed => ({ ...state('idle'), documentsAllowed: allowed }),
    ...clientOverrides,
  };
  const prepare = client.prepare;
  client.prepare = (...args) => { closed = false; readiness = Promise.resolve(prepare(...args)); return readiness; };
  const peer = {
    connect: async mode => {
      calls.push('connect'); peerOperations.push(['connect', mode]); await readiness;
      if (!closed) notify({ type: 'connected', callId: callIds[connection++] ?? callIds.at(-1) });
    },
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
  assert.equal(f.rows[0].type, 'typed');
  assert.equal(f.rows[0].receipt.messageId, 'message-0a9a8b00-334a-4ee1-9cff-bf77b0f7489');
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
  assert.doesNotMatch(f.events.at(-1).message, /点击语音通话|麦克风已关闭/u);

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
  const f = fixture({ text: async (_text, id) => {
    ids.push(id);
    if (++attempts === 1) throw { code: 'unconfirmed' };
    return { kind: 'delivery', delivery: 'accepted', clientMessageId: id, messageId: 'message-retry', callId: CALL_A };
  } });
  await f.conversation.begin();
  assert.equal(await f.conversation.send('帮我查原文'), false);
  assert.equal(f.rows.length, 0);
  assert.equal(await f.conversation.send('帮我查原文'), true);
  assert.equal(ids[0], ids[1]); assert.equal(f.rows.length, 1);
  await f.conversation.end();
});

test('an explicit unconfirmed delivery receipt keeps the draft and retry identity', async () => {
  let attempts = 0;
  const ids = [];
  const f = fixture({ text: async (_text, clientMessageId) => {
    ids.push(clientMessageId);
    if (++attempts === 1) return {
      kind: 'delivery', delivery: 'unconfirmed', clientMessageId, messageId: null, callId: null,
    };
    return {
      kind: 'delivery', delivery: 'accepted', clientMessageId, messageId: 'message-after-retry', callId: CALL_A,
    };
  } });
  await f.conversation.begin();
  assert.equal(await f.conversation.send('把这句留着'), false);
  assert.equal(f.rows.length, 0);
  assert.match(f.events.at(-1).message, /发送尚未确认/u);
  assert.equal(await f.conversation.send('把这句留着'), true);
  assert.deepEqual(ids, [ids[0], ids[0]]);
  assert.equal(f.rows[0].receipt.messageId, 'message-after-retry');
  await f.conversation.end();
});
test('parallel clicks cannot start two calls or submit text twice', async () => {
  const waiting = deferred(); const f = fixture({ text: async (...args) => {
    f.calls.push(args); await waiting.promise;
    return { kind: 'delivery', delivery: 'accepted', clientMessageId: args[1], messageId: 'message-parallel', callId: CALL_A };
  } });
  await Promise.all([f.conversation.begin(), f.conversation.begin()]);
  assert.equal(f.calls.filter(c => c === 'prepare').length, 1);
  const first = f.conversation.send('一句'); assert.equal(await f.conversation.send('一句'), false);
  waiting.resolve(); assert.equal(await first, true);
  assert.equal(f.calls.filter(Array.isArray).length, 1); await f.conversation.end();
});
test('a confirmed late send retires its id before the next conversation', async () => {
  const waiting = deferred(), ids = [];
  const f = fixture({ text: async (_text, id) => {
    ids.push(id); if (ids.length === 1) await waiting.promise;
    return { kind: 'delivery', delivery: 'accepted', clientMessageId: id, messageId: `message-${id}`, callId: CALL_A };
  } });
  let sequence = 0;
  f.conversation.uuid = () => `message-${++sequence}`;
  await f.conversation.begin();
  const first = f.conversation.send('好');
  await f.conversation.end(); waiting.resolve(); await first;
  await f.conversation.begin(); await f.conversation.send('好'); await f.conversation.end();
  assert.notEqual(ids[0], ids[1]);
});
test('an accepted text reply after voice stops still clears the sent draft without reviving voice', async () => {
  const receipt = deferred(); const f = fixture({ text: (_text, id) => receipt.promise.then(() => ({
    kind: 'delivery', delivery: 'accepted', clientMessageId: id, messageId: 'message-late', callId: CALL_A,
  })) });
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
  await f.conversation.end('连接未恢复 · 点击语音通话重试', true);
  await f.conversation.hostStopped('revoked'); await f.conversation.refresh();
  assert.equal(f.events.at(-1).message, '连接未恢复 · 点击语音通话重试');
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

test('the trusted connected call fences transcript events from old and foreign calls', async () => {
  const f = fixture();
  await f.conversation.begin();
  f.notify({ type: 'transcript', callId: CALL_B, role: 'assistant', text: 'foreign', itemId: 'foreign-item' });
  f.notify({ type: 'transcript', callId: CALL_A, role: 'assistant', text: 'current', itemId: 'current-item' });
  assert.deepEqual(f.rows.map(row => row.text), ['current']);

  await f.conversation.end();
  await f.conversation.begin();
  f.notify({ type: 'transcript', callId: CALL_B, role: 'assistant', text: 'still foreign', itemId: 'foreign-2' });
  assert.deepEqual(f.rows.map(row => row.text), ['current']);
  await f.conversation.end();
});

test('local failures and pre-connect Host failures stop the current attempt while foreign failures stay fenced', async () => {
  const connected = fixture();
  await connected.conversation.begin();
  connected.notify({ type: 'error', callId: CALL_B, code: 'unavailable' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(connected.conversation.phase, 'talking');
  connected.notify({ type: 'error', code: 'unavailable' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(connected.conversation.phase, 'idle');
  assert.equal(connected.events.at(-1).failed, true);

  const ready = deferred();
  const connecting = fixture({ prepare: () => ready.promise });
  const starting = connecting.conversation.begin();
  connecting.notify({ type: 'error', callId: CALL_A, code: 'unavailable' });
  await new Promise(resolve => setImmediate(resolve));
  ready.resolve(state());
  await starting;
  assert.equal(connecting.conversation.phase, 'idle');
  assert.equal(connecting.events.at(-1).failed, true);
});

test('a retired call error cannot cancel the next connection attempt', async () => {
  const secondReady = deferred();
  let preparations = 0;
  const f = fixture({
    callIds: [CALL_A, CALL_B],
    prepare: () => ++preparations === 1 ? Promise.resolve(state()) : secondReady.promise,
  });
  await f.conversation.begin();
  await f.conversation.end();
  const reconnecting = f.conversation.begin();
  f.notify({ type: 'error', callId: CALL_A, code: 'unavailable' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.conversation.phase, 'connecting');
  secondReady.resolve(state());
  await reconnecting;
  assert.equal(f.conversation.phase, 'talking');
  assert.equal(f.conversation.callId, CALL_B);
  await f.conversation.end();
});

test('a user-authorized Host stop settles locally without becoming a call failure', async () => {
  const eventStop = fixture();
  await eventStop.conversation.begin();
  eventStop.conversation.expectHostStop();
  await eventStop.conversation.hostStopped('revoked');
  assert.equal(eventStop.conversation.phase, 'idle');
  assert.equal(eventStop.events.at(-1).failed, false);
  assert.match(eventStop.events.at(-1).message, /已结束/u);

  const pollStop = fixture({ state: async () => state('idle') });
  await pollStop.conversation.begin();
  pollStop.conversation.expectHostStop();
  await pollStop.conversation.refresh();
  assert.equal(pollStop.conversation.phase, 'idle');
  assert.equal(pollStop.events.at(-1).failed, false);
});

test('busy is presented as temporary session occupancy without guessing the writer or network', async () => {
  const f = fixture({ prepare: async () => { throw { code: 'busy' }; } });
  await f.conversation.begin();
  assert.equal(f.events.at(-1).message, '会话暂时被占用，请稍后重试');
  assert.doesNotMatch(f.events.at(-1).message, /网络|上一段|谁|自动恢复/u);
});
