import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NativeWindowTravel } from '../src/native-window-travel.mjs';

function clock() {
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  return {
    clearTimer: id => timers.delete(id),
    now: () => now,
    setTimer(callback, delay) {
      const id = ++nextId;
      timers.set(id, { at: now + delay, callback });
      return id;
    },
    tick(ms) {
      const until = now + ms;
      while (true) {
        const due = [...timers].sort((left, right) => left[1].at - right[1].at).find(([, timer]) => timer.at <= until);
        if (!due) break;
        now = due[1].at;
        timers.delete(due[0]);
        due[1].callback();
      }
      now = until;
    },
  };
}

test('actual native coordinates create one expiring travel episode with truthful deltas', () => {
  const time = clock();
  const position = { x: 100, y: 200 };
  const changes = [];
  const travel = new NativeWindowTravel({
    readPosition: () => ({ ...position }),
    changed: value => changes.push(value),
    now: time.now,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
    intervalMs: 80,
    expiresMs: 160,
  });
  travel.start();
  position.x = 112;
  time.tick(80);
  const first = changes.at(-1);
  assert.deepEqual({ status: first.status, dx: first.dx, dy: first.dy }, { status: 'active', dx: 12, dy: 0 });
  position.x = 120;
  time.tick(80);
  assert.equal(changes.at(-1).eventId, first.eventId, 'continuous native movement keeps one episode identity');
  assert.deepEqual({ dx: changes.at(-1).dx, dy: changes.at(-1).dy }, { dx: 8, dy: 0 });
  time.tick(159);
  assert.notEqual(changes.at(-1), null);
  time.tick(1);
  assert.equal(changes.at(-1), null, 'travel expires when native coordinates stop changing');
  travel.close();
});

test('manual drag is suppressed and the next autonomous movement gets a new identity', () => {
  const time = clock();
  const position = { x: 100, y: 200 };
  const changes = [];
  const travel = new NativeWindowTravel({
    readPosition: () => ({ ...position }),
    changed: value => changes.push(value),
    now: time.now,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
    intervalMs: 50,
    expiresMs: 150,
  });
  travel.start();
  position.x = 110;
  time.tick(50);
  const firstId = changes.at(-1).eventId;
  travel.setManual(true);
  assert.equal(changes.at(-1), null);
  position.x = 300;
  time.tick(100);
  assert.equal(changes.at(-1), null, 'user drag cannot masquerade as autonomous travel');
  travel.setManual(false);
  position.x = 312;
  time.tick(50);
  assert.notEqual(changes.at(-1).eventId, firstId);
  travel.close();
});
