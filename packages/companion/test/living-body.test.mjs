import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LivingBody } from '../src/living-body.mjs';

function fixture() {
  const root = { dataset: {} };
  const attributes = new Set(['hidden']);
  const sit = { hidden: false,
    toggleAttribute(name, present) { if (present) attributes.add(name); else attributes.delete(name); },
    hasAttribute(name) { return attributes.has(name); } };
  const makeVideo = () => ({
    hidden: true, src: '', loop: false, playbackRate: 1, currentTime: 0, paused: true,
    style: { setProperty(name, value) { this[name] = value; } },
    plays: 0, pauses: 0,
    play() { this.paused = false; this.plays++; return Promise.resolve(); },
    pause() { this.paused = true; this.pauses++; },
  });
  const video = makeVideo(), transitionVideo = makeVideo();
  let now = 0, nextId = 0;
  const timers = new Map();
  const body = new LivingBody({ root, sit, video, transitionVideo,
    setTimer(callback, delay) { const id = ++nextId; timers.set(id, { at: now + delay, callback }); return id; },
    clearTimer(id) { timers.delete(id); } });
  const tick = ms => {
    const until = now + ms;
    for (;;) {
      const due = [...timers].sort((a, b) => a[1].at - b[1].at).find(([, timer]) => timer.at <= until);
      if (!due) break;
      now = due[1].at; timers.delete(due[0]); due[1].callback();
    }
    now = until;
  };
  return { root, sit, video, transitionVideo, body, tick };
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

test('video clips share the layered identity centre and ground without a second CSS inset', () => {
  const f = fixture();
  const scale = 120 / 290;
  const centreX = 145 * scale;
  const groundY = 262.5 * scale;
  const anchors = new Map([
    ['running-right', { centre: 132.5, ground: 234.8 }],
    ['play', { centre: 201.9, ground: 303.9 }],
    ['sleeping', { centre: 133.2, ground: 161 }],
    ['delivering', { centre: 198.3, ground: 263 }],
    ['pending_decision', { centre: 98.4, ground: 249.6 }],
    ['working', { centre: 132.1, ground: 253.7 }],
  ]);

  for (const [action, anchor] of anchors) {
    f.body.show(action);
    const active = [f.video, f.transitionVideo].find(video => !video.hidden);
    assert.ok(active, `${action}: one clip is visible`);
    assert.ok(Math.abs(Number.parseFloat(active.style.left) + anchor.centre * scale - centreX) < 1e-9,
      `${action}: pendant/identity centre stays fixed`);
    assert.ok(Math.abs(Number.parseFloat(active.style.top) + anchor.ground * scale - groundY) < 1e-9,
      `${action}: ground stays on the layered baseline`);
  }

  f.body.show('waking');
  const wake = [f.video, f.transitionVideo].find(video => /wake\.webm$/u.test(video.src));
  assert.ok(Math.abs(Number.parseFloat(wake.style.left) + 200.5 * scale - centreX) < 1e-9);
  assert.ok(Math.abs(Number.parseFloat(wake.style.top) + 244.2 * scale - groundY) < 1e-9);
  assert.ok(Math.abs(Number.parseFloat(wake.style['--living-left-end']) + 197.7 * scale - centreX) < 1e-9);
  assert.ok(Math.abs(Number.parseFloat(wake.style['--living-top-end']) + 277.4 * scale - groundY) < 1e-9);
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

test('v3 sleep and wake use their own anchors and crossfade for 250ms', () => {
  const f = fixture();
  f.body.show('sleeping');
  assert.match(f.video.src, /sleep\.webm$/u);
  assert.equal(f.video.style.width, `${271.2 * (120 / 290)}px`);
  f.body.show('waking');
  const visible = [f.video, f.transitionVideo].filter(video => !video.hidden);
  assert.equal(visible.length, 2, 'sleep remains under wake during the hand-off');
  assert.ok(visible.some(video => /wake\.webm$/u.test(video.src)));
  f.tick(249);
  assert.equal([f.video, f.transitionVideo].filter(video => !video.hidden).length, 2);
  f.tick(1);
  assert.equal([f.video, f.transitionVideo].filter(video => !video.hidden).length, 1);
});

test('interrupting the sleep-to-wake crossfade retires the hidden sleep video', () => {
  const f = fixture();
  f.body.show('sleeping');
  f.body.show('waking');
  const sleeping = [f.video, f.transitionVideo].find(video => /sleep\.webm$/u.test(video.src));

  f.body.show('working');

  assert.equal(sleeping.hidden, true);
  assert.equal(sleeping.paused, true, 'a hidden crossfade layer must not keep decoding and playing');
  assert.equal([f.video, f.transitionVideo].filter(video => !video.hidden).length, 1);
  assert.match([f.video, f.transitionVideo].find(video => !video.hidden).src, /think\.webm$/u);
});

test('mid-edge docking uses the faded peek while a bottom corner preserves the original clip', () => {
  const f = fixture();
  f.root.dataset.dockZone = 'mid';
  f.body.show('peek');
  assert.match(f.video.src, /peek_fade\.webm$/u);
  f.root.dataset.dockZone = 'corner';
  f.body.show('peek');
  assert.match([f.video.src, f.transitionVideo.src].join(' '), /peek\.webm/u);
  assert.doesNotMatch([f.video.src, f.transitionVideo.src].join(' '), /peek_fade\.webm .*peek_fade\.webm/u);
});

test('held is an explicit static candidate and semantic work states stay truthful under reduced motion', () => {
  const f = fixture();
  f.body.show('held');
  assert.equal(f.video.hidden, true);
  assert.equal(f.sit.hidden, false);
  assert.equal(f.root.dataset.pose, 'held');
  for (const action of ['working', 'fetching', 'studying']) {
    f.body.show(action, { reducedMotion: true });
    assert.equal(f.root.dataset.pose, action);
    assert.equal(f.video.hidden, true);
    assert.equal(f.sit.hidden, false);
  }
});
