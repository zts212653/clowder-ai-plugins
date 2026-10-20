import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CallControlsPresentation } from '../src/call-controls-presentation.mjs';

class FakeNode {
  constructor() {
    this.dataset = {};
    this.value = '';
    this.children = new Set();
    this.listeners = new Map();
  }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  removeEventListener(name, listener) {
    if (this.listeners.get(name) === listener) this.listeners.delete(name);
  }
  emit(name) { this.listeners.get(name)?.({ target: this }); }
  contains(node) { return node === this || this.children.has(node); }
}

function fixture() {
  const root = new FakeNode();
  const pet = new FakeNode();
  const input = new FakeNode();
  const document = { activeElement: null };
  root.children.add(input);
  const callbacks = new Map();
  const cancelled = [];
  const changes = [];
  let sequence = 0;
  const view = new CallControlsPresentation({
    document, root, pet, input, collapseDelay: 20,
    changed: value => changes.push(value),
    schedule(callback) { const id = ++sequence; callbacks.set(id, callback); return id; },
    cancel(id) { cancelled.push(id); callbacks.delete(id); },
  });
  return {
    view, root, pet, input, document, changes, cancelled,
    runTimers() {
      const pending = [...callbacks.values()];
      callbacks.clear();
      for (const callback of pending) callback();
    },
    timerCount: () => callbacks.size,
  };
}

test('an active call starts lite and pet hover reveals controls until pointer leave settles', () => {
  const f = fixture();
  f.view.setActive(true);
  f.view.setPanel('actions');
  assert.equal(f.root.dataset.presentation, 'lite');

  f.pet.emit('pointerenter');
  assert.equal(f.root.dataset.presentation, 'controls');
  f.pet.emit('pointerleave');
  assert.equal(f.timerCount(), 1);
  f.runTimers();
  assert.equal(f.root.dataset.presentation, 'lite');
  assert.deepEqual(f.changes, ['controls', 'lite']);
});

test('focus, editing, pet hover and control hover each prevent automatic folding', () => {
  const f = fixture();
  f.view.setActive(true);
  f.view.setPanel('actions');
  f.view.activate();

  f.document.activeElement = f.input;
  f.view.reevaluate();
  assert.equal(f.timerCount(), 0);
  f.document.activeElement = null;
  f.input.value = '保留草稿';
  f.input.emit('input');
  assert.equal(f.timerCount(), 0);
  f.input.value = '';
  f.root.emit('pointerenter');
  f.input.emit('input');
  assert.equal(f.timerCount(), 0);
  f.root.emit('pointerleave');
  f.pet.emit('pointerenter');
  assert.equal(f.timerCount(), 0);
  f.pet.emit('pointerleave');
  assert.equal(f.timerCount(), 1);
  f.runTimers();
  assert.equal(f.root.dataset.presentation, 'lite');
});

test('sharing or screen selection forces controls and fences both Escape and the timer', () => {
  const f = fixture();
  f.view.setActive(true);
  f.view.setPanel('actions');
  f.view.setMediaLocked(true);
  assert.equal(f.root.dataset.presentation, 'controls');
  assert.equal(f.view.escape('actions'), true);
  assert.equal(f.root.dataset.presentation, 'controls');
  assert.equal(f.timerCount(), 0);

  f.view.setMediaLocked(false);
  assert.equal(f.timerCount(), 1);
  f.runTimers();
  assert.equal(f.root.dataset.presentation, 'lite');
});

test('idle pet activation remains available to the name card owner', () => {
  const f = fixture();
  assert.equal(f.view.activate(), false);
  f.view.setActive(true);
  assert.equal(f.view.activate(), true);
  f.view.setActive(false);
  assert.equal(f.root.dataset.presentation, 'lite');
});
