import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { CompanionConversation } from '../src/conversation.mjs';
import { TranscriptView } from '../src/transcript-view.mjs';
import { CallTranscriptView } from '../src/call-transcript-view.mjs';
import { SettingsView } from '../src/settings-view.mjs';
import { RecentBubble } from '../src/recent-bubble.mjs';
import { decisionBadge, decisionPresentation, decisionRows } from '../src/decision-view.mjs';
import { nativeWorkLabel, normalizeNativeWork } from '../src/native-work-motion.mjs';
import { currentCompanionIdentity } from '../src/companion-identity.mjs';

const source = readFileSync(process.env.COMPANION_SURFACE_TEST_FILE ?? new URL('../src/surface.mjs', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
const CALL_A = '11111111-1111-4111-8111-111111111111';
const CALL_B = '22222222-2222-4222-8222-222222222222';
function fixture() {
  const nodes = new Map(), calls = [], motionCalls = [];
  const document = { getElementById: id => nodes.get(id) ?? node(id), querySelectorAll: () => [],
    createElement: () => node(), addEventListener() {} };
  function node(id) {
    const value = { dataset: {}, attributes: {}, textContent: '', hidden: false, children: [], style: {}, value: '', listeners: {},
      ownerDocument: document, scrollTop: 0, scrollHeight: 100, clientHeight: 100,
      setAttribute(name, attributeValue) { this.attributes[name] = String(attributeValue); },
      removeAttribute(name) { delete this.attributes[name]; },
      addEventListener(name, callback) { this.listeners[name] = callback; },
      querySelector(selector) { return selector === '.empty' ? null : document.getElementById(`${id}${selector}`); },
      querySelectorAll() { return []; },
      append(...rows) { this.children.push(...rows); }, replaceChildren(...rows) { this.children = rows; },
      remove() { const parent = nodes.get('chat-transcript'); parent.children = parent.children.filter(row => row !== this); } };
    if (id) nodes.set(id, value); return value;
  }
  let identity = { phase: 'talking', displayName: '宪宪', skin: 'xianxian-codex', behaviorEnabled: true,
    nativeActivity: 'none', liveTransport: { kind: 'gpt_live_v3', verifiedModel: null },
    nativeWork: { scopeId: '0123456789abcdef', revision: 0, active: [], recent: [] },
    duty: { catId: 'cat', displayName: '宪宪' }, carrier: { catId: 'cat', displayName: '宪宪' } };
  let onControls, onVoice, receive, shareState, travelObserver, history = async () => ({ threadTitle: '猫猫球 · 伴随对话', messages: [{ id: 'old', role: 'user', text: '之前的对话', name: '你' }] });
  let callTranscript = async () => ({ kind: 'transcript', scope: { callId: CALL_A, realtimeSessionId: 'rtc-a' }, hasMore: false, rows: [
    { messageId: 'voice-1', role: 'user', text: 'It is like an assistant.', source: {
      kind: 'voice', nativeThreadId: 'thread-native', realtimeSessionId: 'rtc-a', nativeItemId: 'input-1',
    } },
  ] });
  let decisions = async (offset, limit) => ({ kind: 'decisions', status: 'available', approvalCount: 0,
    needsMeCount: 0, otherNeedsMeCount: 0, approvals: [], otherNeedsMe: [],
    page: { offset, limit, hasMoreApprovals: false, hasMoreNeedsMe: false } });
  let settings = { kind: 'settings', status: 'available', values: {
    dutyCatProfileId: 'fable-5', skin: 'xianxian-codex', ballSize: 72, behaviorEnabled: true,
    proactivePolicy: 'quiet-badge', personaTone: '温暖、简短、不啰嗦', householdReadsAllowed: true,
  }, companions: [{ catProfileId: 'fable-5', displayName: '宪宪', available: true }], selectedCompanionStatus: 'available' };
  let settingsReader = async () => settings;
  let settingUpdate = async (field, value) => {
    settings = { ...settings, values: { ...settings.values, [field]: value } };
    return { kind: 'settings-update', field, outcome: 'saved', callStatus: 'unchanged',
      applies: field === 'personaTone' ? 'next_call' : 'now' };
  };
  const monitors = [];
  const controls = { panel: 'none', ambient: 'none', async show(panel) {
    const previous = this.panel;
    this.panel = panel === 'none' && this.ambient !== 'none' ? this.ambient : panel;
    if (previous !== this.panel) onControls.changed(this.panel);
  },
    async setAmbient(value) { this.ambient = value === true ? 'bubble' : value === false ? 'none' : value; if (['none', 'bubble', 'actions'].includes(this.panel)) await this.show('none'); },
    dismiss() { void this.show('none'); } };
  const client = { state: async () => identity, prepare: async () => ({ ...identity, phase: 'ready' }),
    stop: async () => calls.push('stop'), subscribe: callback => { receive = callback; return () => {}; },
    text: async (text, clientMessageId) => {
      calls.push(['text', text, clientMessageId]);
      return { kind: 'delivery', delivery: 'accepted', clientMessageId, messageId: `message-${clientMessageId}`, callId: CALL_A };
    },
    inspectF221: async proposalId => { calls.push(`inspect:${proposalId}`); return { kind: 'decision-trial', status: 'trial_confirmed' }; },
    openDecision: async (variantRef, target) => {
      calls.push(`open:${variantRef}:${target}`); return { kind: 'navigation', delivery: 'requested' };
    },
    readDecisions: (offset, limit) => decisions(offset, limit),
    readConversation: () => { calls.push('read'); return history(); },
    readTranscript: () => { calls.push('transcript-read'); return callTranscript(); },
    readSettings: async () => { calls.push('settings-read'); return settingsReader(); },
    updateSetting: async (field, value) => {
      calls.push(['settings-update', field, value]);
      return settingUpdate(field, value);
    },
    resetPosition: async () => { calls.push('position-reset'); return { kind: 'ok' }; },
    disableCompanion: async () => { calls.push('companion-disable'); return { kind: 'companion-lifecycle', action: 'disable', outcome: 'disabled' }; } };
  class VoicePeer { constructor(callback) { onVoice = callback; }
    async connect(mode) { calls.push(['connect', mode]); onVoice({ type: 'connected', callId: CALL_A }); }
    muteMic(value) { calls.push(['microphone', value]); } muteSpeaker() {} async close() { calls.push('close'); } }
  class ScreenShare { constructor(_api, changed) { shareState = changed; }
    async stop() {} async start() { calls.push('screen-pick'); } }
  class PetMotion { setContext(value) { motionCalls.push(value); } syncSnapshot(value) { motionCalls.push({ snapshot: value }); }
    syncNativeSnapshot(value) { motionCalls.push({ snapshot: value }); }
    syncTravel(value) { motionCalls.push({ travel: value }); }
    setPendingDecision(value) { motionCalls.push({ pendingDecision: value }); } signal(value) { motionCalls.push(value); }
    setBehaviorEnabled(value) { motionCalls.push({ behaviorEnabled: value }); }
    move() {} stopMove() {} close() {} }
  class NativeWindowTravel { constructor(options) { travelObserver = options; } start() {} setManual() {} close() {} }
  class LivingBody {}
  node('message');
  node('call-message');
  node('decisions');
  runInNewContext(source.replace(/^import .*;\n/gm, ''), { document, window: { clowderCompanion: {}, addEventListener() {} },
    createCompanionClient: () => client, bindPetControls: (_client, callbacks) => { onControls = callbacks; return controls; },
    CompanionConversation, TranscriptView, CallTranscriptView, SettingsView, RecentBubble, PetMotion, LivingBody, NativeWindowTravel, VoicePeer, ScreenShare,
    decisionBadge, decisionPresentation, decisionRows, normalizeNativeWork, nativeWorkLabel, currentCompanionIdentity, explainError: () => '未更新',
    setInterval: callback => { monitors.push(callback); }, clearInterval() {}, crypto: { randomUUID: () => 'fixture' } });
  return { calls, motionCalls, nodes, controls, action: kind => onControls.action(kind), start: () => onControls.action('begin'), voice: event => onVoice(event),
    tick: () => monitors.forEach(callback => callback()), receive: event => receive(event), share: value => shareState(value),
    travel: value => travelObserver.changed(value),
    history: callback => { history = callback; }, transcript: callback => { callTranscript = callback; }, decisions: callback => { decisions = callback; },
    settingsRead: callback => { settingsReader = callback; }, settingsUpdate: callback => { settingUpdate = callback; },
    identity: value => { identity = value; } };
}

test('actual native travel is delivered separately from the Host work snapshot', async () => {
  const f = fixture();
  await flush();
  f.travel({ eventId: 'native-1', status: 'active', dx: -12, dy: 0, expiresAt: Date.now() + 500 });
  assert.ok(f.motionCalls.some(value => value.travel?.eventId === 'native-1'));
});

test('opening history during voice and refreshing it preserves speech without closing audio', async () => {
  const f = fixture(); await flush(); f.start(); await flush();
  await f.controls.show('chat'); await flush();
  assert.ok(f.calls.includes('read'), 'an active voice call must not suppress history');
  assert.equal(f.nodes.get('chat-transcript').children[0].textContent, '之前的对话');
  f.voice({ type: 'transcript', callId: CALL_A, role: 'assistant', text: '正在说', itemId: 'output-1' });
  f.tick(); await flush();
  assert.equal(f.nodes.get('chat-transcript').children.at(-1).textContent, '正在说');
  assert.ok(!f.calls.includes('stop')); assert.ok(!f.calls.includes('close'));
});

test('native history renders the saved companion separately from the real message author', async () => {
  const f = fixture();
  f.history(async () => ({ threadTitle: '猫猫球 · 伴随对话', messages: [{
    id: 'identity-history', role: 'assistant', text: '查到了', name: '砚砚',
    companionIdentity: {
      v: 1, name: '猫猫球',
      partner: { catId: 'fable-5', displayName: '宪宪', skin: 'xianxian-codex' },
      live: { catId: 'codex-sol', displayName: '砚砚', transport: 'gpt_live_v3', verifiedModel: null },
      deep: { catId: 'fable-5', displayName: '宪宪', verifiedModel: null },
    },
  }], hasMore: false }));
  await flush(); f.tick(); await flush();
  const row = f.nodes.get('chat-transcript').children[0];
  assert.equal(row.dataset.author, '砚砚');
  assert.equal(row.dataset.companion, '当时由宪宪陪伴');
  assert.match(row.dataset.companionLive, /Live 快端：砚砚/u);
  assert.match(row.dataset.companionDeep, /深思端：宪宪/u);
});

test('voice keeps a persistent call bar and only call-scoped messages while history stays closed', async () => {
  const f = fixture(); await flush(); f.start(); await flush(); f.tick(); await flush();
  assert.equal(f.controls.panel, 'actions');
  assert.equal(f.nodes.get('call-bubble-first').textContent, '语音：It is like an assistant.');
  f.voice({ type: 'transcript', callId: CALL_A, role: 'assistant', text: '正在查', itemId: 'output-live' });
  assert.equal(f.nodes.get('call-bubble-second').textContent, '宪宪：正在查');
  assert.match(f.nodes.get('call-state').textContent, /通话中/u);
  assert.equal(f.nodes.get('call-mic-state').textContent, '麦克风已开启');
  assert.ok(!f.calls.includes('stop'));
});

test('recovering is a first-class call state and recovery restores the live status', async () => {
  const f = fixture(); await flush(); f.start(); await flush();
  f.voice({ type: 'recovering', callId: CALL_A });
  assert.equal(f.nodes.get('call-state').textContent, '连接不稳定');
  assert.equal(f.nodes.get('call-mic-state').textContent, '正在等待原连接恢复 · 麦克风已开启');
  assert.equal(f.nodes.get('actions').dataset.connectionState, 'recovering');
  assert.match(f.nodes.get('status').textContent, /恢复后通话继续，无需重新连接/u);

  f.voice({ type: 'recovered', callId: CALL_A });
  assert.equal(f.nodes.get('call-state').textContent, '通话中');
  assert.equal(f.nodes.get('call-mic-state').textContent, '麦克风已开启');
  assert.equal(f.nodes.get('actions').dataset.connectionState, 'connected');
});

test('the visible work label comes from the bounded native work source', async () => {
  const f = fixture(); await flush();
  f.identity({ phase: 'talking', displayName: '宪宪', skin: 'xianxian-codex', behaviorEnabled: true,
    nativeActivity: 'none', liveTransport: { kind: 'gpt_live_v3', verifiedModel: null },
    nativeWork: { scopeId: '0123456789abcdef', revision: 1, active: [{
      eventId: 'work-1', taskId: 'task-1', kind: 'workspace_dispatch', startedAt: Date.now(),
      expiresAt: Date.now() + 10_000,
    }], recent: [] },
    duty: { catId: 'cat', displayName: '宪宪' }, carrier: { catId: 'cat', displayName: '宪宪' } });
  f.tick(); await flush();
  assert.equal(f.nodes.get('call-work').textContent, '宪宪正在处理家里的事务');

  f.identity({ phase: 'talking', displayName: '宪宪', skin: 'xianxian-codex', behaviorEnabled: true,
    nativeActivity: 'none', liveTransport: { kind: 'gpt_live_v3', verifiedModel: null },
    nativeWork: { scopeId: '0123456789abcdef', revision: 2, active: [{
      eventId: 'work-2', taskId: 'task-2', kind: 'screen_read', startedAt: Date.now(),
      expiresAt: Date.now() + 10_000,
    }], recent: [] },
    duty: { catId: 'cat', displayName: '宪宪' }, carrier: { catId: 'cat', displayName: '宪宪' } });
  f.tick(); await flush();
  assert.equal(f.nodes.get('call-work').textContent, '宪宪正在查看共享画面');
});

test('an authoritative empty native-work snapshot suppresses the legacy activity fallback', async () => {
  const f = fixture(); await flush();
  f.identity({ phase: 'talking', displayName: '宪宪', skin: 'xianxian-codex', behaviorEnabled: true,
    nativeActivity: 'tool_running', liveTransport: { kind: 'gpt_live_v3', verifiedModel: null },
    nativeWork: { scopeId: '0123456789abcdef', revision: 3, active: [], recent: [] },
    duty: { catId: 'cat', displayName: '宪宪' }, carrier: { catId: 'cat', displayName: '宪宪' } });
  f.tick(); await flush();
  assert.equal(f.nodes.get('call-work').hidden, true);
  assert.equal(f.nodes.get('call-work').textContent, '');
});

test('sharing keeps the exact target visible in the call bar and settings header', async () => {
  const f = fixture(); await flush(); f.start(); await flush();
  f.share({ sharing: true, pending: false, label: 'Blender' });

  assert.equal(f.nodes.get('call-share-context').hidden, false);
  assert.equal(f.nodes.get('call-share-target').textContent, '共享中：Blender');
  assert.equal(f.nodes.get('settings-share-context').hidden, false);
  assert.equal(f.nodes.get('settings-share-target').textContent, '共享中：Blender');
  assert.equal(f.nodes.get('settings-share.label').textContent, '停止共享');
});

test('Host-bound call transcript polls only while active and merges typed receipts by durable id', async () => {
  const f = fixture();
  await flush();
  f.tick(); await flush();
  assert.equal(f.calls.filter(call => call === 'transcript-read').length, 0);

  f.start(); await flush();
  f.tick(); await flush();
  assert.equal(f.calls.filter(call => call === 'transcript-read').length, 1);
  assert.equal(f.nodes.get('call-transcript-log').children[0].dataset.messageId, 'voice-1');

  f.voice({ type: 'transcript', callId: CALL_B, role: 'assistant', text: 'late old call', itemId: 'old-output' });
  f.voice({ type: 'transcript', callId: CALL_A, role: 'assistant', text: '当前实时', itemId: 'current-output' });
  assert.deepEqual(f.nodes.get('call-transcript-log').children.map(row => row.textContent), ['It is like an assistant.', '当前实时']);

  f.nodes.get('call-message').value = '哪个 API？';
  await f.nodes.get('call-compose').onsubmit({ preventDefault() {} });
  const typed = f.nodes.get('call-transcript-log').children.find(row => row.dataset.source === 'typed');
  const textCall = f.calls.find(call => Array.isArray(call) && call[0] === 'text');
  assert.equal(typed.dataset.messageId, `message-${textCall[2]}`);
  assert.equal(typed.textContent, '哪个 API？');

  f.action('stop'); await flush();
  const reads = f.calls.filter(call => call === 'transcript-read').length;
  f.tick(); await flush();
  assert.equal(f.calls.filter(call => call === 'transcript-read').length, reads);
});

test('opening and dismissing another panel during voice returns to the persistent call bar', async () => {
  const f = fixture(); await flush(); f.start(); await flush();
  await f.controls.show('chat'); await flush();
  assert.equal(f.controls.panel, 'chat');
  f.controls.dismiss(); await flush();
  assert.equal(f.controls.panel, 'actions');
});

test('microphone icons follow mute truth and hangup closes the call-only transcript panel', async () => {
  const f = fixture(); await flush(); f.start(); await flush();
  assert.equal(f.nodes.get('mic-icon').attributes.href, '#i-mic');
  assert.equal(f.nodes.get('transcript-mic-icon').attributes.href, '#i-mic');
  f.action('mute');
  assert.equal(f.nodes.get('mic-icon').attributes.href, '#i-mic-off');
  assert.equal(f.nodes.get('transcript-mic-icon').attributes.href, '#i-mic-off');
  await f.controls.show('transcript'); await flush();
  f.action('stop'); await flush();
  assert.equal(f.controls.panel, 'menu');
});

test('cat-side settings read Host truth, save one field, and confirm call-sensitive changes', async () => {
  const f = fixture(); await flush();
  assert.ok(f.calls.includes('settings-read'));
  await f.controls.show('settings'); await flush();
  assert.equal(f.controls.panel, 'settings');
  assert.equal(f.nodes.get('settings-partner-value').textContent, '宪宪');
  assert.equal(f.nodes.get('settings-behavior').attributes['aria-checked'], 'true');
  assert.equal(f.nodes.get('settings-tone-count').textContent, '9 / 200');

  await f.nodes.get('settings-behavior').onclick(); await flush();
  assert.ok(f.calls.some(call => Array.isArray(call) && call[0] === 'settings-update'
    && call[1] === 'behaviorEnabled' && call[2] === false));
  assert.equal(f.nodes.get('settings-behavior').attributes['aria-checked'], 'false');

  f.start(); await flush();
  await f.controls.show('settings'); await flush();
  const updates = f.calls.filter(call => Array.isArray(call) && call[0] === 'settings-update').length;
  f.nodes.get('settings-documents').onclick(); await flush();
  assert.equal(f.nodes.get('settings-page-confirm').hidden, false);
  assert.equal(f.calls.filter(call => Array.isArray(call) && call[0] === 'settings-update').length, updates);
  await f.nodes.get('settings-confirm-apply').onclick(); await flush();
  assert.ok(f.calls.some(call => Array.isArray(call) && call[0] === 'settings-update'
    && call[1] === 'householdReadsAllowed' && call[2] === false));
});

test('settings distinguish stop-then-save failure from an unknown settlement', async () => {
  const stopped = fixture(); await flush(); stopped.start(); await flush();
  await stopped.controls.show('settings'); await flush();
  stopped.settingsUpdate(async (field) => ({
    kind: 'settings-update', field, outcome: 'rejected', callStatus: 'stopped', reason: 'save_failed',
  }));
  stopped.nodes.get('settings-documents').onclick(); await flush();
  await stopped.nodes.get('settings-confirm-apply').onclick(); await flush();
  assert.equal(stopped.nodes.get('settings-notice').textContent, '通话已结束，资料查询未更改');
  assert.equal(stopped.nodes.get('settings-retry').hidden, false);
  assert.equal(stopped.controls.panel, 'settings');
  assert.equal(stopped.nodes.get('begin.label').textContent, '语音通话');
  assert.equal(stopped.motionCalls.includes('failed'), false);
  stopped.receive({ kind: 'media-stopped', reason: 'revoked' }); await flush();
  assert.equal(stopped.controls.panel, 'settings');
  assert.equal(stopped.motionCalls.includes('failed'), false);

  const uncertain = fixture(); await flush();
  await uncertain.controls.show('settings'); await flush();
  uncertain.settingsUpdate(async () => { throw new Error('reply lost'); });
  uncertain.settingsRead(async () => { throw new Error('readback unavailable'); });
  uncertain.nodes.get('settings-behavior').onclick(); await flush();
  assert.equal(uncertain.nodes.get('settings-notice').textContent, '自主活动的保存结果未确认');
  assert.equal(uncertain.nodes.get('settings-behavior').dataset.settlement, 'unconfirmed');
  assert.equal(uncertain.nodes.get('settings-reread').hidden, false);
});

test('a call-sensitive retry uses confirmation and the authorised stop handshake', async () => {
  const f = fixture(); await flush(); f.start(); await flush();
  await f.controls.show('settings'); await flush();
  f.settingsUpdate(async field => ({ kind: 'settings-update', field, outcome: 'rejected',
    callStatus: 'stop_failed', reason: 'call_stop_failed' }));
  f.nodes.get('settings-documents').onclick(); await flush();
  await f.nodes.get('settings-confirm-apply').onclick(); await flush();
  const before = f.calls.filter(call => Array.isArray(call) && call[0] === 'settings-update').length;

  f.nodes.get('settings-retry').onclick(); await flush();
  assert.equal(f.nodes.get('settings-page-confirm').hidden, false);
  assert.equal(f.calls.filter(call => Array.isArray(call) && call[0] === 'settings-update').length, before);
  f.settingsUpdate(async field => ({ kind: 'settings-update', field, outcome: 'saved',
    callStatus: 'stopped', applies: 'now' }));
  const confirming = f.nodes.get('settings-confirm-apply').onclick(); await flush();
  f.receive({ kind: 'media-stopped', reason: 'revoked' }); await flush();
  await confirming; await flush();
  assert.equal(f.controls.panel, 'settings');
  assert.equal(f.motionCalls.includes('failed'), false);
  assert.match(f.nodes.get('settings-notice').textContent, /通话已结束，资料查询已保存/u);
});

test('settings keep one-line tone input and mark uncertain subpage values in place', async () => {
  const f = fixture(); await flush(); await f.controls.show('settings'); await flush();
  f.nodes.get('settings-partner-open').onclick();
  const tone = f.nodes.get('settings-tone');
  tone.value = '温暖\n直接';
  tone.oninput({ target: tone });
  assert.equal(tone.value, '温暖 直接');
  let prevented = false;
  tone.onkeydown({ key: 'Enter', preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  tone.onchange({ target: tone }); await flush();
  assert.ok(f.calls.some(call => Array.isArray(call) && call[0] === 'settings-update'
    && call[1] === 'personaTone' && call[2] === '温暖 直接'));

  f.settingsUpdate(async () => { throw new Error('reply lost'); });
  f.settingsRead(async () => { throw new Error('readback unavailable'); });
  f.nodes.get('settings-look-open').onclick();
  const size = f.nodes.get('settings-size');
  size.value = '120';
  size.onchange({ target: size }); await flush();
  assert.equal(f.nodes.get('settings-size-field').dataset.settlement, 'unconfirmed');
  assert.equal(f.nodes.get('settings-notice').hidden, false);
});

test('screen entry explains its scope before voice and opens the picker only after connection', async () => {
  const f = fixture(); await flush();
  f.action('share'); await flush();
  assert.match(f.nodes.get('status').textContent, /先开始语音通话/);
  assert.ok(!f.calls.includes('screen-pick'));
  f.start(); await flush();
  f.action('share'); await flush();
  assert.ok(f.calls.includes('screen-pick'));
});

test('receive-only is capability-gated and keeps microphone controls out of the episode', async () => {
  const f = fixture(); await flush();
  assert.equal(f.nodes.get('listen').hidden, true, 'an old Host has no receive-only control');
  f.identity({ phase: 'idle', displayName: '宪宪', skin: 'xianxian-codex',
    nativeActivity: 'none', liveTransport: { kind: 'gpt_live_v3', verifiedModel: null },
    nativeWork: { scopeId: null, revision: 0, active: [], recent: [] },
    duty: { catId: 'cat', displayName: '宪宪' }, carrier: { catId: 'cat', displayName: '宪宪' },
    audio: { supportedModes: ['duplex', 'receive_only'], activeMode: null } });
  f.tick(); await flush();
  assert.equal(f.nodes.get('listen').hidden, false);
  f.action('listen'); await flush();
  assert.ok(f.calls.some(call => Array.isArray(call) && call[0] === 'connect' && call[1] === 'receive_only'));
  assert.equal(f.calls.some(call => Array.isArray(call) && call[0] === 'microphone'), false);
  assert.equal(f.nodes.get('mic').hidden, true);
  assert.match(f.nodes.get('call-state').textContent, /只听中/u);
  assert.match(f.nodes.get('status').textContent, /麦克风未启用/u);
});

test('an interrupted receive-only episode keeps no-mic retry visible and primary', async () => {
  const f = fixture();
  f.identity({ phase: 'idle', displayName: '宪宪', skin: 'xianxian-codex',
    nativeActivity: 'none', liveTransport: { kind: 'gpt_live_v3', verifiedModel: null },
    nativeWork: { scopeId: null, revision: 0, active: [], recent: [] },
    duty: { catId: 'cat', displayName: '宪宪' }, carrier: { catId: 'cat', displayName: '宪宪' },
    audio: { supportedModes: ['duplex', 'receive_only'], activeMode: null } });
  await flush(); f.tick(); await flush();
  f.action('listen'); await flush();
  f.receive({ kind: 'media-stopped', reason: 'closed' }); await flush();

  assert.equal(f.nodes.get('status').hidden, false);
  assert.match(f.nodes.get('status').textContent, /麦克风未启用.*点击只听重试/u);
  assert.equal(f.nodes.get('listen.label').textContent, '重试只听');
  assert.equal(f.nodes.get('listen').className, 'primary');
  assert.equal(f.nodes.get('begin.label').textContent, '语音通话');
  assert.equal(f.nodes.get('begin').className, '');
  assert.equal(f.controls.panel, 'menu');
});

test('history requested before a call is still displayed when it arrives during voice', async () => {
  const f = fixture(); await flush(); let resolve;
  f.history(() => new Promise(done => { resolve = done; }));
  await f.controls.show('chat'); f.start(); await flush();
  resolve({ messages: [{ id: 'late', role: 'user', text: '迟到的历史', name: '你' }] }); await flush();
  assert.equal(f.nodes.get('chat-transcript').children[0]?.textContent, '迟到的历史');
  assert.ok(!f.calls.includes('stop'));
});

test('a failed history refresh preserves existing history and live audio', async () => {
  const f = fixture(); await flush(); f.start(); await flush(); await f.controls.show('chat'); await flush();
  f.history(async () => { throw new Error('unavailable'); }); f.tick(); await flush();
  assert.equal(f.nodes.get('chat-transcript').children[0]?.textContent, '之前的对话');
  assert.match(f.nodes.get('chat-status').textContent, /暂未更新/);
  assert.ok(!f.calls.includes('stop')); assert.ok(!f.calls.includes('close'));
});
test('unexpected media revocation exposes a persistent retry without clearing the draft', async () => {
  const f = fixture(); await flush(); f.start(); await flush();
  f.nodes.get('message').value = '还没发出去';
  f.receive({ kind: 'media-stopped', reason: 'closed' }); await flush(); f.tick(); await flush();
  assert.match(f.nodes.get('status').textContent, /中断/);
  assert.equal(f.nodes.get('begin.label').textContent, '重试语音通话');
  assert.equal(f.controls.panel, 'menu');
  assert.equal(f.nodes.get('message').value, '还没发出去');
});

test('passive decision badge and panel keep the live call while preserving unknown source state', async () => {
  const f = fixture(); await flush(); f.start(); await flush();
  f.decisions(async (offset, limit) => ({ kind: 'decisions', status: 'available', approvalCount: 2,
    needsMeCount: 2, otherNeedsMeCount: 1,
    approvals: [{ proposalId: 'proposal_mgf2abc12345678', sourceFeatureId: 'F221', summary: '品味提案',
      resolution: 'open', materializationState: 'not_started', linkedNeedsMe: true }],
    otherNeedsMe: [{ subjectRef: 'task:one', summary: '看看任务' }],
    page: { offset, limit, hasMoreApprovals: false, hasMoreNeedsMe: false } }));
  f.tick(); await flush();
  assert.equal(f.nodes.get('pending-count').textContent, '有待办');
  await f.controls.show('decisions'); await flush();
  assert.equal(f.nodes.get('decision-list').children.length, 2);
  assert.equal(f.nodes.get('decision-status').textContent, '已显示读取到的待办 · 暂无总数');
  assert.equal(f.nodes.get('decision-reload').textContent, '刷新');
  await f.nodes.get('decision-list').children[0].children[2].onclick();
  assert.ok(f.calls.includes('inspect:proposal_mgf2abc12345678'));
  assert.match(f.nodes.get('decision-status').textContent, /没有写回/);
  assert.ok(!f.calls.includes('stop')); assert.ok(!f.calls.includes('close'));
  f.decisions(async () => { throw new Error('source unavailable'); });
  f.nodes.get('decision-reload').onclick(); await flush();
  assert.equal(f.nodes.get('pending-count').textContent, '?');
  assert.match(f.nodes.get('decision-status').textContent, /暂不可读/);
  assert.match(f.nodes.get('decision-status').textContent, /上次读到/,
    'retained rows must be labelled stale instead of looking like the current read');
  assert.equal(f.nodes.get('decision-list').children.length, 2);
  assert.equal(f.nodes.get('decision-reload').textContent, '重试');
});

test('a partial unified inbox keeps known variants, missing-source truth, and safe navigation', async () => {
  const f = fixture(); await flush(); f.start(); await flush();
  f.decisions(async (offset, limit) => ({
    kind: 'decisions', version: 1, status: 'partial', observedAt: 42,
    sources: {
      approvals: { status: 'available', coverage: 'complete' },
      needsMe: { status: 'unavailable', coverage: 'unknown' },
    },
    items: [
      { variantRef: 'variant-a', kind: 'repair', summary: '修复第一处',
        navigation: { targets: ['action', 'origin'] } },
      { variantRef: 'variant-b', kind: 'repair', summary: '修复冲突版本',
        navigation: { targets: ['origin'] } },
    ],
    page: { offset, limit, scope: 'known_rows', hasMore: false },
  }));
  f.tick(); await flush();
  assert.equal(f.nodes.get('pending-count').textContent, '•');
  await f.controls.show('decisions'); await flush();
  assert.equal(f.nodes.get('decision-list').children.length, 2);
  assert.equal(f.nodes.get('decision-status').textContent, '仅部分读取 · 其余待办未能读取');
  assert.equal(f.nodes.get('decision-reload').textContent, '重试');
  await f.nodes.get('decision-list').children[0].children[2].onclick();
  assert.ok(f.calls.includes('open:variant-a:action'));
  assert.ok(!f.calls.includes('stop')); assert.ok(!f.calls.includes('close'));
});

test('known-row pagination deduplicates the same concrete variant without collapsing distinct variants', async () => {
  const f = fixture(); await flush();
  const item = variantRef => ({ variantRef, kind: 'repair', summary: variantRef, navigation: { targets: [] } });
  f.decisions(async (offset, limit) => ({
    kind: 'decisions', version: 1, status: 'partial', observedAt: 42 + offset,
    sources: {
      approvals: { status: 'available', coverage: 'complete' },
      needsMe: { status: 'unavailable', coverage: 'unknown' },
    },
    items: offset === 0
      ? Array.from({ length: limit }, (_, index) => item(`variant-${index}`))
      : [item('variant-0'), item('variant-new')],
    page: { offset, limit, scope: 'known_rows', hasMore: offset === 0 },
  }));
  await f.controls.show('decisions'); await flush();
  assert.equal(f.nodes.get('decision-list').children.length, 10);
  assert.equal(f.nodes.get('decision-more').hidden, false);
  f.nodes.get('decision-more').onclick(); await flush();
  assert.equal(f.nodes.get('decision-list').children.length, 11);
});

test('an unavailable follow-up page keeps earlier rows only as explicitly stale evidence', async () => {
  const f = fixture(); await flush();
  const item = variantRef => ({ variantRef, kind: 'repair', summary: variantRef, navigation: { targets: [] } });
  f.decisions(async (offset, limit) => offset === 0 ? ({
    kind: 'decisions', version: 1, status: 'partial', observedAt: 42,
    sources: {
      approvals: { status: 'available', coverage: 'complete' },
      needsMe: { status: 'unavailable', coverage: 'unknown' },
    },
    items: Array.from({ length: limit }, (_, index) => item(`variant-${index}`)),
    page: { offset, limit, scope: 'known_rows', hasMore: true },
  }) : ({
    kind: 'decisions', version: 1, status: 'unavailable', observedAt: 43,
    sources: {
      approvals: { status: 'unavailable', coverage: 'unknown' },
      needsMe: { status: 'unavailable', coverage: 'unknown' },
    },
    items: [], page: { offset, limit, scope: 'known_rows', hasMore: false },
  }));
  await f.controls.show('decisions'); await flush();
  f.nodes.get('decision-more').onclick(); await flush();
  assert.equal(f.nodes.get('decision-list').children.length, 10);
  assert.match(f.nodes.get('decision-status').textContent, /上次读到/);
  assert.equal(f.nodes.get('decision-more').hidden, true);
});

test('a fresh exact zero clears rows retained from an earlier independent page read', async () => {
  const f = fixture(); await flush();
  const sources = {
    approvals: { status: 'available', coverage: 'complete' },
    needsMe: { status: 'available', coverage: 'complete' },
  };
  f.decisions(async (offset, limit) => ({
    kind: 'decisions', version: 1, status: 'available', observedAt: 42 + offset, sources,
    totalCount: offset === 0 ? 11 : 0,
    items: offset === 0
      ? Array.from({ length: limit }, (_, index) => ({
        variantRef: `variant-${index}`, kind: 'repair', summary: `old ${index}`, navigation: { targets: ['origin'] },
      })) : [],
    page: { offset, limit, scope: 'known_rows', hasMore: offset === 0 },
  }));
  await f.controls.show('decisions'); await flush();
  f.nodes.get('decision-more').onclick(); await flush();
  assert.equal(f.nodes.get('decision-list').children.length, 0);
  assert.equal(f.nodes.get('decision-status').textContent, '暂无待办');
  assert.equal(f.nodes.get('pending-count').textContent, '0');
  assert.equal(f.nodes.get('decision-more').hidden, true);
});

test('an exact total change invalidates the mixed pagination view until a fresh first page', async () => {
  const f = fixture(); await flush();
  const sources = {
    approvals: { status: 'available', coverage: 'complete' },
    needsMe: { status: 'available', coverage: 'complete' },
  };
  f.decisions(async (offset, limit) => ({
    kind: 'decisions', version: 1, status: 'available', observedAt: 42 + offset, sources,
    totalCount: offset === 0 ? 11 : 10,
    items: offset === 0
      ? Array.from({ length: limit }, (_, index) => ({
        variantRef: `variant-${index}`, kind: 'repair', summary: `old ${index}`, navigation: { targets: [] },
      })) : [],
    page: { offset, limit, scope: 'known_rows', hasMore: offset === 0 },
  }));
  await f.controls.show('decisions'); await flush();
  f.nodes.get('decision-more').onclick(); await flush();
  assert.equal(f.nodes.get('decision-list').children.length, 0);
  assert.equal(f.nodes.get('decision-status').textContent, '待办已变化 · 请刷新查看最新列表');
  assert.equal(f.nodes.get('decision-reload').textContent, '刷新');
  assert.equal(f.nodes.get('decision-more').hidden, true);
});

test('a source coverage change also invalidates rows from the prior independent read', async () => {
  const f = fixture(); await flush();
  f.decisions(async (offset, limit) => ({
    kind: 'decisions', version: 1, status: 'partial', observedAt: 42 + offset,
    sources: {
      approvals: { status: 'available', coverage: offset === 0 ? 'complete' : 'partial' },
      needsMe: { status: 'unavailable', coverage: 'unknown' },
    },
    items: offset === 0
      ? Array.from({ length: limit }, (_, index) => ({
        variantRef: `variant-${index}`, kind: 'repair', summary: `old ${index}`, navigation: { targets: [] },
      })) : [],
    page: { offset, limit, scope: 'known_rows', hasMore: offset === 0 },
  }));
  await f.controls.show('decisions'); await flush();
  f.nodes.get('decision-more').onclick(); await flush();
  assert.equal(f.nodes.get('decision-list').children.length, 0);
  assert.equal(f.nodes.get('decision-status').textContent, '待办已变化 · 请刷新查看最新列表');
  assert.equal(f.nodes.get('decision-more').hidden, true);
});

test('unknown assistant history stays readable without becoming an unsolicited idle preview or deliverable', async () => {
  const f = fixture(); await flush();
  assert.ok(!f.motionCalls.includes('answered'));
  f.history(async () => ({ threadTitle: '猫猫球 · 伴随对话', messages: [
    { id: 'old', role: 'user', text: '之前的对话', name: '你' },
    { id: 'new-answer', role: 'assistant', text: '查询完成', name: '宪宪' },
  ], hasMore: false }));
  f.tick(); await flush();
  assert.equal(f.motionCalls.filter(value => value === 'answered').length, 0);
  assert.equal(f.controls.panel, 'none', 'an assistant id change alone cannot authorize proactive text');
  assert.equal(f.nodes.get('chat-transcript').children.at(-1).textContent, '查询完成');
  f.identity({ phase: 'idle', displayName: '宪宪', skin: 'xianxian-codex',
    nativeActivity: 'none', liveTransport: { kind: 'gpt_live_v3', verifiedModel: null },
    duty: { catId: 'cat', displayName: '宪宪' }, carrier: { catId: 'cat', displayName: '宪宪' },
    nativeWork: { scopeId: '0123456789abcdef', revision: 1, active: [], recent: [{
      eventId: 'scope:1', taskId: 'scope/turn', kind: 'result', phase: 'result_handed_to_voice',
      occurredAt: Date.now(), expiresAt: Date.now() + 10_000, resultId: 'result-1', nativeCarrierCatId: 'cat',
    }] } });
  f.tick(); await flush();
  assert.ok(f.motionCalls.some(value => value.snapshot?.delivery?.resultId === 'result-1'));
});

test('unknown assistant history never enters the active call glance', async () => {
  const f = fixture(); await flush(); f.start(); await flush();
  f.history(async () => ({ threadTitle: '猫猫球 · 伴随对话', messages: [
    { id: 'unknown-answer', role: 'assistant', text: '后台查询完成', name: '宪宪' },
  ], hasMore: false }));
  f.tick(); await flush();
  const glance = [f.nodes.get('call-bubble-first').textContent, f.nodes.get('call-bubble-second').textContent];
  assert.equal(glance.some(text => text.includes('后台查询完成')), false);
  assert.equal(f.nodes.get('chat-transcript').children.at(-1).textContent, '后台查询完成');
});

test('native identity display keeps the selected companion separate from its live carrier', async () => {
  const f = fixture(); await flush();
  f.identity({ phase: 'talking', displayName: '旧配置名字', skin: 'xianxian-codex', nativeActivity: 'none',
    liveTransport: { kind: 'gpt_live_v3', verifiedModel: null },
    nativeWork: { scopeId: '0123456789abcdef', revision: 0, active: [], recent: [] },
    duty: { catId: 'fable-5', displayName: '宪宪' }, carrier: { catId: 'codex-sol', displayName: '砚砚' } });
  f.tick(); await flush();
  assert.equal(f.nodes.get('menu-name').textContent, '猫猫球 · 宪宪陪伴中');
  assert.match(f.nodes.get('connection-scope').textContent, /宪宪陪伴中/u);
  assert.match(f.nodes.get('connection-scope').textContent, /Live 快端：砚砚 · 型号未核实/u);
  assert.match(f.nodes.get('connection-scope').textContent, /深思端：宪宪 · 型号未核实/u);
  assert.doesNotMatch(f.nodes.get('connection-scope').textContent, /5\.6|配置型号/u);
});
