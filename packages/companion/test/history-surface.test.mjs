import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { CompanionConversation } from '../src/conversation.mjs';
import { TranscriptView } from '../src/transcript-view.mjs';

const source = readFileSync(process.env.COMPANION_SURFACE_TEST_FILE ?? new URL('../src/surface.mjs', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const nodes = new Map(), calls = [];
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
  let onControls, onVoice, receive, monitor, history = async () => ({ messages: [{ id: 'old', role: 'user', text: '之前的对话', name: '你' }] });
  const controls = { panel: 'none', async show(panel) { this.panel = panel; onControls.changed(panel); }, dismiss() { this.panel = 'none'; } };
  const client = { state: async () => identity, prepare: async () => ({ ...identity, phase: 'ready' }),
    stop: async () => calls.push('stop'), subscribe: callback => { receive = callback; return () => {}; },
    readConversation: () => { calls.push('read'); return history(); } };
  class VoicePeer { constructor(callback) { onVoice = callback; } async connect() { onVoice({ type: 'connected' }); } muteMic() {} muteSpeaker() {} async close() { calls.push('close'); } }
  class ScreenShare { async stop() {} }
  node('message');
  runInNewContext(source.replace(/^import .*;\n/gm, ''), { document, window: { clowderCompanion: {}, addEventListener() {} },
    createCompanionClient: () => client, bindPetControls: (_client, callbacks) => { onControls = callbacks; return controls; },
    CompanionConversation, TranscriptView, VoicePeer, ScreenShare, explainError: () => '未更新',
    setInterval: callback => { monitor = callback; }, clearInterval() {}, crypto: { randomUUID: () => 'fixture' } });
  return { calls, nodes, controls, start: () => onControls.action('begin'), voice: event => onVoice(event),
    tick: () => monitor(), receive: event => receive(event), history: callback => { history = callback; } };
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
