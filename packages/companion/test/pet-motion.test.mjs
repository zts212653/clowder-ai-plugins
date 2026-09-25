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
