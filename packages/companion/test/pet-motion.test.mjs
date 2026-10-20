import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PetMotion } from '../src/pet-motion.mjs';

function fixture(reducedMotion = false, options = {}) {
  let now = 0, nextId = 0;
  const timers = new Map();
  const element = { dataset: {}, style: {} };
  const motion = new PetMotion(element, {
    reducedMotion,
    autoPlay: options.autoPlay,
    now: () => now,
    setTimer(callback, delay) { const id = ++nextId; timers.set(id, { at: now + delay, callback }); return id; },
    clearTimer(id) { timers.delete(id); },
  });
  function tick(ms) {
    const until = now + ms;
    while (true) {
      const due = [...timers].sort((a, b) => a[1].at - b[1].at).find(([, timer]) => timer.at <= until);
      if (!due) break;
      now = due[1].at; timers.delete(due[0]); due[1].callback();
    }
    now = until;
  }
  return { element, motion, tick, timers };
}

test('native tool and reasoning facts choose the matching recorded action and respect exact frame durations', () => {
  const f = fixture();
  f.motion.setContext({ skin: 'xianxian-codex', phase: 'talking', nativeActivity: 'tool_running', muted: false });
  assert.equal(f.element.dataset.action, 'working');
  assert.match(f.element.style.backgroundImage, /xianxian-working-row/);
  assert.equal(f.element.style.backgroundPosition, '0px 0px');
  f.tick(519); assert.equal(f.element.style.backgroundPosition, '0px 0px');
  f.tick(1); assert.equal(f.element.style.backgroundPosition, '-120px 0px');
  f.motion.setContext({ skin: 'xianxian-codex', phase: 'talking', nativeActivity: 'reasoning', muted: false });
  assert.equal(f.element.dataset.action, 'staged_thought');
  f.motion.setContext({ skin: 'xianxian-codex', phase: 'talking', nativeActivity: 'none', muted: false });
  assert.equal(f.element.dataset.action, 'waiting');
});

test('an authoritative empty native-work snapshot disables the identity-free activity fallback', () => {
  const f = fixture();
  f.motion.setContext({ skin: 'xianxian-codex', phase: 'idle', nativeActivity: 'tool_running', muted: false });
  assert.equal(f.element.dataset.action, 'working');
  f.motion.syncSnapshot({ work: null, delivery: null, travel: null });
  assert.equal(f.element.dataset.action, 'idle');
});

test('dragging uses a truthful held candidate, cancels travel, and rereads current work after release', () => {
  const f = fixture();
  f.motion.setContext({ skin: 'xianxian-codex', phase: 'idle', nativeActivity: 'none', muted: false });
  f.motion.syncSnapshot({
    work: null,
    delivery: null,
    travel: { eventId: 'move-1', status: 'active', dx: -20, dy: 0, expiresAt: 10_000 },
  });
  assert.equal(f.element.dataset.action, 'running-left');
  f.motion.move(-20, 0);
  assert.equal(f.element.dataset.action, 'held');
  f.motion.stopMove();
  assert.equal(f.element.dataset.action, 'idle', 'drag cancels the old travel target instead of resuming it');
  f.motion.syncSnapshot({ work: null, delivery: null,
    travel: { eventId: 'move-1', status: 'active', dx: -20, dy: 0, expiresAt: 10_000 } });
  assert.equal(f.element.dataset.action, 'idle', 'the same cancelled travel event remains deduplicated');
  f.motion.syncSnapshot({ work: null, delivery: null,
    travel: { eventId: 'move-2', status: 'active', dx: 20, dy: 0, expiresAt: 10_000 } });
  assert.equal(f.element.dataset.action, 'running-right', 'a new authoritative target can move the body');
  f.motion.syncSnapshot({
    work: { taskId: 'task-1', kind: 'tool', status: 'active', expiresAt: 10_000 },
    delivery: null,
    travel: null,
  });
  assert.equal(f.element.dataset.action, 'working', 'the next Host snapshot restores only current truth');
});

test('observed native travel drives running without replacing Host work truth', () => {
  const f = fixture();
  f.motion.setContext({ skin: 'xianxian-codex', phase: 'idle', nativeActivity: 'none', muted: false });
  f.motion.syncSnapshot({ work: null, delivery: null, travel: null });
  f.motion.syncTravel({ eventId: 'native-1', status: 'active', dx: 12, dy: 0, expiresAt: 1_000 });
  assert.equal(f.element.dataset.action, 'running-right');
  f.motion.syncNativeSnapshot({ work: null, delivery: null, travel: null });
  assert.equal(f.element.dataset.action, 'running-right', 'native work polling cannot erase measured window travel');
  f.motion.syncNativeSnapshot({
    work: { taskId: 'task-1', kind: 'tool', status: 'active', expiresAt: 1_000 },
    delivery: null,
    travel: { eventId: 'native-1', status: 'active', dx: 12, dy: 0, expiresAt: 1_000 },
  });
  assert.equal(f.element.dataset.action, 'working', 'real work remains higher priority than locomotion');
  f.motion.syncTravel(null);
  assert.equal(f.element.dataset.action, 'working');
});

test('structured Host work distinguishes tool, workspace and screen reading and expires without polling tricks', () => {
  const f = fixture();
  f.motion.setContext({ skin: 'xianxian-codex', phase: 'idle', nativeActivity: 'none', muted: false });
  for (const [kind, action] of [['tool', 'working'], ['workspace', 'fetching'], ['screen_reading', 'studying']]) {
    f.motion.syncSnapshot({
      work: { taskId: `task-${kind}`, kind, status: 'active', expiresAt: 1_000 },
      delivery: null,
      travel: null,
    });
    assert.equal(f.element.dataset.action, action);
  }
  f.tick(1_000);
  assert.equal(f.element.dataset.action, 'idle');
});

test('only an applied unexpired result delivers once per result identity', () => {
  const f = fixture();
  const shown = [];
  const body = { show(action, options) { shown.push({ action, options }); }, hide() {}, close() {} };
  f.motion.livingBody = body;
  f.motion.setContext({ skin: 'xianxian-codex', phase: 'idle', nativeActivity: 'none', muted: false });
  const snapshot = status => ({ work: null, travel: null,
    delivery: { resultId: 'result-1', status, expiresAt: 5_000 } });
  f.motion.syncSnapshot(snapshot('requested'));
  assert.notEqual(shown.at(-1)?.action, 'delivering');
  f.motion.syncSnapshot(snapshot('applied'));
  assert.equal(shown.at(-1).action, 'delivering');
  shown.at(-1).options.onEnded();
  assert.equal(shown.at(-1).action, 'idle');
  f.motion.syncSnapshot(snapshot('applied'));
  assert.equal(shown.at(-1).action, 'idle', 'polling the same result cannot replay carry');
  f.motion.syncSnapshot({ work: null, travel: null,
    delivery: { resultId: 'result-2', status: 'applied', expiresAt: 0 } });
  assert.equal(shown.at(-1).action, 'idle', 'expired results never queue behind the current state');
});

test('connection, received and failed signals play once; ordinary completion does not claim a deliverable', () => {
  const f = fixture();
  f.motion.setContext({ skin: 'xianxian-codex', phase: 'talking', nativeActivity: 'none', muted: false });
  for (const [signal, action] of [['connected', 'waving'], ['received', 'jumping'], ['failed', 'failed']]) {
    f.motion.signal(signal); assert.equal(f.element.dataset.action, action);
    f.tick(2_000); assert.equal(f.element.dataset.action, 'waiting');
  }
  f.motion.signal('answered');
  assert.equal(f.element.dataset.action, 'waiting');
  f.motion.setContext({ skin: 'xianxian-codex', phase: 'idle', nativeActivity: 'none', muted: false });
  assert.equal(f.element.dataset.action, 'idle');
  f.tick(45_000); assert.equal(f.element.dataset.action, 'sleeping');
});

test('other skins use their own atlas or static art, and reduced motion freezes on a real frame', () => {
  const f = fixture(true);
  f.motion.setContext({ skin: 'yanyan-codex', phase: 'talking', nativeActivity: 'tool_running', muted: false });
  assert.equal(f.element.dataset.action, 'review');
  assert.match(f.element.style.backgroundImage, /yanyan-codex.webp/);
  assert.equal(f.timers.size, 0);
  f.motion.setContext({ skin: 'ragdoll-v1', phase: 'idle', nativeActivity: 'none', muted: false });
  assert.equal(f.element.dataset.action, 'idle');
  assert.match(f.element.style.backgroundImage, /ragdoll-v1.png/);
});

test('automatic pounce is opt-in, waits 90 seconds, respects a three-minute cooldown, and cancels for work', () => {
  const f = fixture(false, { autoPlay: true });
  f.motion.setContext({ skin: 'xianxian-codex', phase: 'idle', nativeActivity: 'none', muted: false });
  f.tick(89_999);
  assert.notEqual(f.element.dataset.action, 'play');
  f.tick(1);
  assert.equal(f.element.dataset.action, 'play');
  f.motion.syncSnapshot({ work: { taskId: 'task-1', kind: 'tool', status: 'active', expiresAt: 100_000 },
    delivery: null, travel: null });
  assert.equal(f.element.dataset.action, 'working');
  f.motion.syncSnapshot({ work: null, delivery: null, travel: null });
  f.tick(179_999);
  assert.notEqual(f.element.dataset.action, 'play');
  f.tick(1);
  assert.equal(f.element.dataset.action, 'play');
  const reduced = fixture(true, { autoPlay: true });
  reduced.motion.setContext({ skin: 'xianxian-codex', phase: 'idle', nativeActivity: 'none', muted: false });
  reduced.tick(600_000);
  assert.notEqual(reduced.element.dataset.action, 'play');
});

test('persisted autonomous preference can enable later and disabling cancels automatic play immediately', () => {
  const before = fixture(false);
  before.motion.setContext({ skin: 'xianxian-codex', phase: 'idle', nativeActivity: 'none', muted: false });
  before.motion.setBehaviorEnabled(true);
  before.motion.setBehaviorEnabled(false);
  before.tick(600_000);
  assert.notEqual(before.element.dataset.action, 'play');

  const active = fixture(false);
  active.motion.setContext({ skin: 'xianxian-codex', phase: 'idle', nativeActivity: 'none', muted: false });
  active.motion.setBehaviorEnabled(true);
  active.tick(90_000);
  assert.equal(active.element.dataset.action, 'play');
  active.motion.setBehaviorEnabled(false);
  assert.notEqual(active.element.dataset.action, 'play');
});

test('animation timers use the browser global receiver', () => {
  const timers = new Map();
  let nextId = 0;
  const motion = new PetMotion({ dataset: {}, style: {} }, {
    reducedMotion: false,
    setTimer(callback, delay) {
      assert.equal(this, globalThis, 'browser timers reject another receiver');
      const id = ++nextId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimer(id) {
      assert.equal(this, globalThis, 'browser timers reject another receiver');
      timers.delete(id);
    },
  });
  motion.setContext({ skin: 'xianxian-codex', phase: 'idle', nativeActivity: 'none', muted: false });
  assert.equal(timers.size, 2);
  motion.close();
  assert.equal(timers.size, 0);
});

test('living Xianxian consumes real activity, pending decisions, movement and a completed answer', () => {
  const shown = [];
  const body = { show(action, options) { shown.push({ action, options }); }, hide() {}, close() {} };
  const motion = new PetMotion({ dataset: {}, style: {} }, {
    livingBody: body, reducedMotion: false,
    setTimer() { return 1; }, clearTimer() {},
  });
  motion.setContext({ skin: 'xianxian-codex', phase: 'talking', nativeActivity: 'reasoning', muted: false });
  assert.equal(shown.at(-1).action, 'staged_thought');
  motion.setPendingDecision(true);
  assert.equal(shown.at(-1).action, 'pending_decision');
  motion.syncSnapshot({ work: null, delivery: null,
    travel: { eventId: 'move-1', status: 'active', dx: 20, dy: 0, expiresAt: Date.now() + 10_000 } });
  assert.equal(shown.at(-1).action, 'pending_decision', 'a travel target cannot hide a pending decision');
  motion.setPendingDecision(false);
  motion.setContext({ skin: 'xianxian-codex', phase: 'talking', nativeActivity: 'none', muted: false });
  assert.equal(shown.at(-1).action, 'running-right');
  motion.move(20, 0);
  assert.equal(shown.at(-1).action, 'held');
  motion.stopMove();
  assert.equal(shown.at(-1).action, 'waiting');
  motion.syncSnapshot({ work: null, travel: null,
    delivery: { resultId: 'result-1', status: 'applied', expiresAt: Date.now() + 10_000 } });
  assert.equal(shown.at(-1).action, 'delivering');
  motion.setPendingDecision(true);
  assert.equal(shown.at(-1).action, 'pending_decision', 'a new decision preempts result delivery');
  motion.signal('play');
  assert.equal(shown.at(-1).action, 'pending_decision', 'play cannot hide a pending decision');
  motion.close();
});

test('waking and edge peeking yield to listening and real work', () => {
  const shown = [];
  const body = { show(action, options) { shown.push({ action, options }); }, hide() {}, close() {} };
  const motion = new PetMotion({ dataset: {}, style: {} }, { livingBody: body, reducedMotion: false,
    setTimer() { return 1; }, clearTimer() {} });
  motion.setContext({ skin: 'xianxian-codex', phase: 'idle', nativeActivity: 'none', muted: false });
  motion.setDockedEdge('right');
  assert.equal(shown.at(-1).action, 'peek');
  const beforeSwitch = shown.length;
  motion.setDockedEdge('left');
  assert.equal(shown.length, beforeSwitch + 1, 'changing the dock side repaints the same peek clip');
  motion.setDockedEdge(null);
  motion.play('sleeping');
  motion.setContext({ skin: 'xianxian-codex', phase: 'talking', nativeActivity: 'none', muted: false });
  assert.equal(shown.at(-1).action, 'waking');
  motion.signal('connected');
  assert.equal(shown.at(-1).action, 'waking', 'a generic connection signal cannot replace the living wake clip');
  motion.setContext({ skin: 'xianxian-codex', phase: 'talking', nativeActivity: 'reasoning', muted: false });
  assert.equal(shown.at(-1).action, 'staged_thought');
  motion.close();
});

test('edge posture remains visible while listening stays an orthogonal signal', () => {
  const shown = [];
  const body = { show(action, options) { shown.push({ action, options }); }, hide() {}, close() {} };
  const motion = new PetMotion({ dataset: {}, style: {} }, { livingBody: body, reducedMotion: false,
    setTimer() { return 1; }, clearTimer() {} });

  motion.setContext({ skin: 'xianxian-codex', phase: 'talking', nativeActivity: 'none', muted: false });
  assert.equal(motion.element.dataset.listening, 'true');
  assert.equal(shown.at(-1).action, 'waiting');

  motion.setDockedEdge({ edge: 'right', zone: 'mid' });
  assert.equal(shown.at(-1).action, 'peek', 'docking remains a body posture during an active call');
  assert.equal(motion.element.dataset.listening, 'true', 'voice state remains independently visible');

  motion.setContext({ skin: 'xianxian-codex', phase: 'talking', nativeActivity: 'reasoning', muted: false });
  assert.equal(shown.at(-1).action, 'staged_thought', 'truthful work still preempts the edge posture');
  motion.close();
});
