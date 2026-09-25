import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LivingBody } from '../src/living-body.mjs';

function fixture() {
  const root = { dataset: {} };
  const attributes = new Set(['hidden']);
  const sit = { hidden: false,
    toggleAttribute(name, present) { if (present) attributes.add(name); else attributes.delete(name); },
    hasAttribute(name) { return attributes.has(name); } };
  const video = {
    hidden: true, src: '', loop: false, playbackRate: 1, currentTime: 0, paused: true, style: {},
    plays: 0, pauses: 0,
    play() { this.paused = false; this.plays++; return Promise.resolve(); },
    pause() { this.paused = true; this.pauses++; },
  };
  return { root, sit, video, body: new LivingBody({ root, sit, video }) };
}

test('one living body switches from layered sit to real movement and back', () => {
  const f = fixture();
  f.body.show('idle');
  assert.equal(f.sit.hidden, false);
  assert.equal(f.sit.hasAttribute('hidden'), false, 'SVG hidden attribute must be removed, not only an expando property');
  assert.equal(f.video.hidden, true);
  f.body.show('running-left');
  assert.equal(f.sit.hidden, true);
  assert.equal(f.video.hidden, false);
  assert.match(f.video.src, /xianxian-living\/clips\/trot\.webm$/u);
  assert.equal(f.video.loop, true);
  assert.equal(f.root.dataset.direction, 'left');
  f.body.show('idle');
  assert.equal(f.video.hidden, true);
  assert.equal(f.video.paused, true);
  assert.equal(f.sit.hidden, false);
});

test('work, pending decisions and completed answers use distinct real signals', () => {
  const f = fixture();
  f.body.show('working');
  assert.match(f.video.src, /think\.webm$/u);
  f.body.show('pending_decision');
  assert.match(f.video.src, /wait\.webm$/u);
  f.body.show('review');
  assert.match(f.video.src, /carry\.webm$/u);
  assert.equal(f.video.loop, false);
  f.body.show('failed');
  assert.equal(f.sit.hidden, false);
  assert.equal(f.root.dataset.pose, 'scared');
});

test('pounce is a one-shot play action, interruption closes it, reduced motion stays static', () => {
  const f = fixture();
  let ended = 0;
  f.body.show('play', { onEnded: () => ended++ });
  assert.match(f.video.src, /pounce\.webm$/u);
  assert.equal(f.video.playbackRate, 1.5);
  f.body.show('waiting');
  f.video.onended?.();
  assert.equal(ended, 0, 'an interrupted clip cannot complete the old action');
  f.body.show('working', { reducedMotion: true });
  assert.equal(f.video.hidden, true);
  assert.equal(f.sit.hidden, false);
  assert.equal(f.video.paused, true);
});
