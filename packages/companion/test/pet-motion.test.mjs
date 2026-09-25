import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PetMotion } from '../src/pet-motion.mjs';

function fixture(reducedMotion = false) {
  let now = 0, nextId = 0;
  const timers = new Map();
  const element = { dataset: {}, style: {} };
  const motion = new PetMotion(element, {
    reducedMotion,
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

test('running actions require actual movement and return to the current work state', () => {
  const f = fixture();
  f.motion.setContext({ skin: 'xianxian-codex', phase: 'talking', nativeActivity: 'tool_running', muted: false });
  f.motion.move(-20, 0); assert.equal(f.element.dataset.action, 'running-left');
  f.motion.move(20, 0); assert.equal(f.element.dataset.action, 'running-right');
  f.motion.move(0, 20); assert.equal(f.element.dataset.action, 'running');
  f.motion.stopMove(); assert.equal(f.element.dataset.action, 'working');
});

test('received, completed and failed signals play once; quiet idle eventually sleeps without claiming work', () => {
  const f = fixture();
  f.motion.setContext({ skin: 'xianxian-codex', phase: 'talking', nativeActivity: 'none', muted: false });
  for (const [signal, action] of [['connected', 'waving'], ['received', 'jumping'], ['answered', 'review'], ['failed', 'failed']]) {
    f.motion.signal(signal); assert.equal(f.element.dataset.action, action);
    f.tick(2_000); assert.equal(f.element.dataset.action, 'waiting');
  }
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
  motion.move(20, 0);
  assert.equal(shown.at(-1).action, 'running-right');
  motion.stopMove();
  assert.equal(shown.at(-1).action, 'pending_decision');
  motion.signal('answered');
  assert.equal(shown.at(-1).action, 'review');
  shown.at(-1).options.onEnded();
  assert.equal(shown.at(-1).action, 'pending_decision');
  motion.setPendingDecision(false);
  motion.signal('answered');
  assert.equal(shown.at(-1).action, 'review');
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
  motion.setContext({ skin: 'xianxian-codex', phase: 'talking', nativeActivity: 'reasoning', muted: false });
  assert.equal(shown.at(-1).action, 'staged_thought');
  motion.close();
});
