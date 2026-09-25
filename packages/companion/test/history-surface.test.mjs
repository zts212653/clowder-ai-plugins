import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { CompanionConversation } from '../src/conversation.mjs';
import { TranscriptView } from '../src/transcript-view.mjs';
import { RecentBubble } from '../src/recent-bubble.mjs';
import { decisionBadge, decisionRows } from '../src/decision-view.mjs';

const source = readFileSync(process.env.COMPANION_SURFACE_TEST_FILE ?? new URL('../src/surface.mjs', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const nodes = new Map(), calls = [], motionCalls = [];
  const document = { getElementById: id => nodes.get(id) ?? node(id), querySelectorAll: () => [],
    createElement: () => node(), addEventListener() {} };
  function node(id) {
    const value = { dataset: {}, textContent: '', hidden: false, children: [], style: {}, value: '',
      ownerDocument: document, scrollTop: 0, scrollHeight: 100, clientHeight: 100,
      setAttribute() {}, querySelector(selector) { return selector === '.empty' ? null : document.getElementById(`${id}${selector}`); },
      append(...rows) { this.children.push(...rows); }, replaceChildren(...rows) { this.children = rows; },
      remove() { const parent = nodes.get('transcript'); parent.children = parent.children.filter(row => row !== this); } };
    if (id) nodes.set(id, value); return value;
  }
  const identity = { phase: 'talking', displayName: '宪宪', skin: 'xianxian-codex',
    duty: { catId: 'cat', displayName: '宪宪' }, carrier: { catId: 'cat' } };
  let onControls, onVoice, receive, history = async () => ({ threadTitle: '猫猫球 · 伴随对话', messages: [{ id: 'old', role: 'user', text: '之前的对话', name: '你' }] });
  let decisions = async (offset, limit) => ({ kind: 'decisions', status: 'available', approvalCount: 0,
    needsMeCount: 0, otherNeedsMeCount: 0, approvals: [], otherNeedsMe: [],
    page: { offset, limit, hasMoreApprovals: false, hasMoreNeedsMe: false } });
  const monitors = [];
  const controls = { panel: 'none', ambient: false, async show(panel) { this.panel = panel === 'none' && this.ambient ? 'bubble' : panel; onControls.changed(this.panel); },
    async setAmbient(value) { this.ambient = value; if (['none', 'bubble'].includes(this.panel)) await this.show('none'); }, dismiss() { this.panel = 'none'; } };
  const client = { state: async () => identity, prepare: async () => ({ ...identity, phase: 'ready' }),
    stop: async () => calls.push('stop'), subscribe: callback => { receive = callback; return () => {}; },
    inspectF221: async proposalId => { calls.push(`inspect:${proposalId}`); return { kind: 'decision-trial', status: 'trial_confirmed' }; },
    readDecisions: (offset, limit) => decisions(offset, limit),
    readConversation: () => { calls.push('read'); return history(); } };
  class VoicePeer { constructor(callback) { onVoice = callback; } async connect() { onVoice({ type: 'connected' }); } muteMic() {} muteSpeaker() {} async close() { calls.push('close'); } }
  class ScreenShare { async stop() {} async start() { calls.push('screen-pick'); } }
  class PetMotion { setContext(value) { motionCalls.push(value); } signal(value) { motionCalls.push(value); } move() {} stopMove() {} close() {} }
  node('message');
  node('decisions');
  runInNewContext(source.replace(/^import .*;\n/gm, ''), { document, window: { clowderCompanion: {}, addEventListener() {} },
    createCompanionClient: () => client, bindPetControls: (_client, callbacks) => { onControls = callbacks; return controls; },
    CompanionConversation, TranscriptView, RecentBubble, PetMotion, VoicePeer, ScreenShare,
    decisionBadge, decisionRows, explainError: () => '未更新',
    setInterval: callback => { monitors.push(callback); }, clearInterval() {}, crypto: { randomUUID: () => 'fixture' } });
  return { calls, motionCalls, nodes, controls, action: kind => onControls.action(kind), start: () => onControls.action('begin'), voice: event => onVoice(event),
    tick: () => monitors.forEach(callback => callback()), receive: event => receive(event),
    history: callback => { history = callback; }, decisions: callback => { decisions = callback; } };
}

test('opening history during voice and refreshing it preserves speech without closing audio', async () => {
  const f = fixture(); await flush(); f.start(); await flush();
  await f.controls.show('chat'); await flush();
  assert.ok(f.calls.includes('read'), 'an active voice call must not suppress history');
  assert.equal(f.nodes.get('transcript').children[0].textContent, '之前的对话');
  f.voice({ type: 'transcript', role: 'assistant', text: '正在说' });
  f.tick(); await flush();
  assert.equal(f.nodes.get('transcript').children.at(-1).textContent, '正在说');
  assert.ok(!f.calls.includes('stop')); assert.ok(!f.calls.includes('close'));
});

test('voice keeps the latest two Host messages beside the cat while history stays closed', async () => {
  const f = fixture(); await flush(); f.start(); await flush(); f.tick(); await flush();
  assert.equal(f.controls.panel, 'bubble');
  assert.match(f.nodes.get('bubble-first').textContent, /之前的对话/);
  f.voice({ type: 'transcript', role: 'assistant', text: '正在查' });
  assert.match(f.nodes.get('bubble-second').textContent, /正在查/);
  assert.ok(!f.calls.includes('stop'));
});

test('screen entry explains its scope before voice and opens the picker only after connection', async () => {
  const f = fixture(); await flush();
  f.action('share'); await flush();
  assert.match(f.nodes.get('status').textContent, /先点语音聊/);
  assert.ok(!f.calls.includes('screen-pick'));
  f.start(); await flush();
  f.action('share'); await flush();
  assert.ok(f.calls.includes('screen-pick'));
});

test('history requested before a call is still displayed when it arrives during voice', async () => {
  const f = fixture(); await flush(); let resolve;
  f.history(() => new Promise(done => { resolve = done; }));
  await f.controls.show('chat'); f.start(); await flush();
  resolve({ messages: [{ id: 'late', role: 'user', text: '迟到的历史', name: '你' }] }); await flush();
  assert.equal(f.nodes.get('transcript').children[0]?.textContent, '迟到的历史');
  assert.ok(!f.calls.includes('stop'));
});

test('a failed history refresh preserves existing history and live audio', async () => {
  const f = fixture(); await flush(); f.start(); await flush(); await f.controls.show('chat'); await flush();
  f.history(async () => { throw new Error('unavailable'); }); f.tick(); await flush();
  assert.equal(f.nodes.get('transcript').children[0]?.textContent, '之前的对话');
  assert.match(f.nodes.get('chat-status').textContent, /暂未更新/);
  assert.ok(!f.calls.includes('stop')); assert.ok(!f.calls.includes('close'));
});
test('unexpected media revocation exposes a persistent retry without clearing the draft', async () => {
  const f = fixture(); await flush(); f.start(); await flush();
  f.nodes.get('message').value = '还没发出去';
  f.receive({ kind: 'media-stopped', reason: 'closed' }); await flush(); f.tick(); await flush();
  assert.match(f.nodes.get('status').textContent, /中断/);
  assert.equal(f.nodes.get('begin.label').textContent, '重试语音');
  assert.equal(f.controls.panel, 'actions');
  assert.equal(f.nodes.get('message').value, '还没发出去');
});

test('passive decision badge and panel keep the live call while preserving unknown source state', async () => {
  const f = fixture(); await flush(); f.start(); await flush();
  f.decisions(async (offset, limit) => ({ kind: 'decisions', status: 'available', approvalCount: 2,
    needsMeCount: 2, otherNeedsMeCount: 1,
    approvals: [{ proposalId: '11111111-1111-4111-8111-111111111111', sourceFeatureId: 'F221', summary: '品味提案',
      resolution: 'open', materializationState: 'not_started', linkedNeedsMe: true }],
    otherNeedsMe: [{ subjectRef: 'task:one', summary: '看看任务' }],
    page: { offset, limit, hasMoreApprovals: false, hasMoreNeedsMe: false } }));
  f.tick(); await flush();
  assert.equal(f.nodes.get('pending-count').textContent, '3');
  await f.controls.show('decisions'); await flush();
  assert.equal(f.nodes.get('decision-list').children.length, 2);
  await f.nodes.get('decision-list').children[0].children[2].onclick();
  assert.ok(f.calls.includes('inspect:11111111-1111-4111-8111-111111111111'));
  assert.match(f.nodes.get('decision-status').textContent, /没有写回/);
  assert.ok(!f.calls.includes('stop')); assert.ok(!f.calls.includes('close'));
  f.decisions(async () => { throw new Error('source unavailable'); });
  f.nodes.get('decision-reload').onclick(); await flush();
  assert.equal(f.nodes.get('pending-count').textContent, '?');
  assert.match(f.nodes.get('decision-status').textContent, /暂不可读/);
});
