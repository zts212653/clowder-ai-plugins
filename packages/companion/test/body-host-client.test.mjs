import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBodyHostClient, RENEW_MS } from '../src/living-world/host-client.mjs';

/** A Host stand-in: records every command, answers scene.get from a queue, everything else ok. */
function fixture({ reads = [{ kind: 'scene', status: 'not_found' }], reply = () => ({ kind: 'ok' }) } = {}) {
  const sent = [];
  const listeners = new Set();
  const queue = [...reads];
  const bridge = {
    async request(command) {
      sent.push(structuredClone(command));
      if (command.kind === 'scene.get') {
        const next = queue.length > 1 ? queue.shift() : queue[0];
        if (next instanceof Error) throw next;
        return next;
      }
      return reply(command);
    },
    subscribe(callback) { listeners.add(callback); return () => listeners.delete(callback); },
  };
  let now = 0, nextId = 0;
  const pending = new Map();
  const timers = {
    setTimeout(callback, ms) { const id = ++nextId; pending.set(id, { at: now + ms, callback }); return id; },
    clearTimeout(id) { pending.delete(id); },
    setInterval(callback, ms) { const id = ++nextId; pending.set(id, { at: now + ms, callback, every: ms }); return id; },
    clearInterval(id) { pending.delete(id); },
  };
  const flush = () => new Promise(resolve => setImmediate(resolve));
  async function advance(ms) {
    const until = now + ms;
    for (;;) {
      const due = [...pending].sort((a, b) => a[1].at - b[1].at).find(([, timer]) => timer.at <= until);
      if (!due) break;
      const [id, timer] = due;
      now = timer.at;
      if (timer.every) timer.at += timer.every; else pending.delete(id);
      timer.callback();
      await flush();
    }
    now = until;
    await flush();
  }
  let hidden = false;
  const visibilityListeners = new Set();
  const visibility = {
    hidden: () => hidden,
    subscribe(callback) { visibilityListeners.add(callback); return () => visibilityListeners.delete(callback); },
  };
  const setHidden = value => { hidden = value; for (const callback of visibilityListeners) callback(); };
  let current = { schemaVersion: 1, pose: { name: 'SS', facing: 'left' }, hat: { askew: false }, activity: { kind: null, frame: 0 } };
  const scenes = [];
  const areas = [];
  const preferences = [];
  const world = {
    snapshot: () => structuredClone(current),
    onScene: scene => scenes.push(scene),
    onArea: (width, height, standHeight) => areas.push(standHeight === undefined ? [width, height] : [width, height, standHeight]),
    onPreferences: value => preferences.push(value),
  };
  const client = createBodyHostClient({ bridge, timers, visibility });
  const emit = event => { for (const callback of listeners) callback(event); };
  const kinds = () => sent.map(command => command.kind);
  const of = kind => sent.filter(command => command.kind === kind);
  const set = next => { current = { ...current, ...next }; };
  return { client, world, sent, kinds, of, emit, advance, flush, setHidden, set, scenes, areas, preferences, now: () => now };
}

test('only not_found starts a new scene, and the body reports it at once with every field', async () => {
  const f = fixture({ reads: [{ kind: 'scene', status: 'not_found' }] });
  await f.client.start(f.world);
  await f.flush();
  assert.deepEqual(f.scenes, [{ status: 'not_found' }]);
  assert.equal(f.client.mode, 'saved');
  assert.deepEqual(f.of('scene.report').map(command => command.dirty), [['pose', 'hat', 'activity']]);
});

test('a found scene is restored and not written back until something changes', async () => {
  const saved = { schemaVersion: 1, pose: { name: 'SS', facing: 'left' }, hat: { askew: false }, activity: { kind: null, frame: 0 } };
  const f = fixture({ reads: [{ kind: 'scene', status: 'found', revision: 7, snapshot: saved }] });
  await f.client.start(f.world);
  assert.deepEqual(f.scenes, [{ status: 'found', snapshot: saved }]);
  assert.deepEqual(f.kinds(), ['scene.get']);
  f.set({ hat: { askew: true } });
  assert.equal(await f.client.sceneChanged(), true);
  assert.deepEqual(f.of('scene.report').at(-1), { kind: 'scene.report', snapshot: { ...saved, hat: { askew: true } }, dirty: ['hat'] });
});

test('a failed read plays unsaved: never reports, never answers a flush, retries 1 s → 30 s, then adopts the archive', async () => {
  const saved = { schemaVersion: 1, hat: { askew: true } };
  const failures = [
    { kind: 'scene', status: 'error', reason: 'corrupt' },
    { kind: 'error', code: 'cancelled' },
    new Error('ipc closed'),
    { kind: 'scene', status: 'found', revision: 2 }, // malformed: no snapshot
    { kind: 'scene', status: 'error', reason: 'unavailable' },
    { kind: 'scene', status: 'error', reason: 'unavailable' },
    { kind: 'scene', status: 'error', reason: 'unavailable' },
  ];
  const f = fixture({ reads: [...failures, { kind: 'scene', status: 'found', revision: 3, snapshot: saved }] });
  await f.client.start(f.world);
  assert.equal(f.client.mode, 'unsaved');
  assert.deepEqual(f.scenes, [{ status: 'unsaved', reason: 'corrupt' }], 'the world hears unsaved once, then plays on');

  f.set({ hat: { askew: false } });
  assert.equal(await f.client.sceneChanged(), false);
  f.emit({ kind: 'scene-flush' });
  await f.flush();
  assert.equal(f.of('scene.report').length, 0, 'an unsaved body never writes a default over the archive');

  const readsAt = [];
  for (const wait of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    const before = f.of('scene.get').length;
    await f.advance(wait - 1);
    assert.equal(f.of('scene.get').length, before, `no read before ${wait} ms`);
    await f.advance(1);
    assert.equal(f.of('scene.get').length, before + 1, `read after ${wait} ms`);
    readsAt.push(f.now());
  }
  assert.deepEqual(readsAt, [1000, 3000, 7000, 15000, 31000, 61000, 91000]);
  assert.equal(f.client.mode, 'saved');
  assert.deepEqual(f.scenes.at(-1), { status: 'found', snapshot: saved });
  assert.equal(f.of('scene.report').length, 0, 'adopting the archive writes nothing by itself');
  await f.advance(60000);
  assert.equal(f.of('scene.get').length, 8, 'reading stops once the archive answered');
});

test('the click lease renews every 500 ms without any repaint and stops while hidden', async () => {
  const f = fixture();
  await f.client.start(f.world);
  const cat = { x: 1100, y: 670, width: 120, height: 130 };
  f.client.setHitRects([cat]);
  f.client.setHitRects([{ ...cat }]);
  assert.equal(f.of('body.hit').length, 1, 'an unchanged region is not sent again');
  await f.advance(RENEW_MS * 4);
  assert.equal(f.of('body.hit.renew').length, 4, 'a still cat stays clickable');

  f.setHidden(true);
  await f.advance(RENEW_MS * 4);
  assert.equal(f.of('body.hit.renew').length, 4, 'a hidden body lets the lease lapse');
  f.setHidden(false);
  await f.flush();
  assert.equal(f.of('body.hit').length, 2, 'coming back re-sends the region the lapsed lease dropped');
  await f.advance(RENEW_MS);
  assert.equal(f.of('body.hit.renew').length, 5);

  f.client.setHitRects([{ ...cat, x: 1000 }]);
  assert.deepEqual(f.of('body.hit').at(-1), { kind: 'body.hit', rects: [{ ...cat, x: 1000 }] });
  f.client.setHitRects([]);
  const renewals = f.of('body.hit.renew').length;
  await f.advance(RENEW_MS * 3);
  assert.equal(f.of('body.hit.renew').length, renewals, 'an empty region has nothing to renew');
  assert.deepEqual(f.of('body.hit').at(-1), { kind: 'body.hit', rects: [] });

  f.client.setHitRects([cat]);
  f.client.stop();
  await f.advance(RENEW_MS * 3);
  assert.equal(f.of('body.hit.renew').length, renewals, 'a stopped body renews nothing');
});

test('a Host flush is answered at once with the newest snapshot, even when nothing changed', async () => {
  const f = fixture();
  await f.client.start(f.world);
  f.set({ activity: { kind: 'draft', frame: 9 } }); // progress the world never flagged as a change
  f.emit({ kind: 'scene-flush' });
  await f.flush();
  assert.deepEqual(f.of('scene.report').at(-1).dirty, ['activity']);
  assert.deepEqual(f.of('scene.report').at(-1).snapshot.activity, { kind: 'draft', frame: 9 });
  f.emit({ kind: 'scene-flush' });
  await f.flush();
  assert.deepEqual(f.of('scene.report').at(-1).dirty, [], 'an unchanged scene still answers so the Host need not wait');
  assert.equal(f.of('scene.report').length, 3);
});

test('fields of a report the Host did not take ride on the next one', async () => {
  let refuse = false;
  const f = fixture({ reply: command => (command.kind === 'scene.report' && refuse
    ? { kind: 'error', code: 'unavailable' } : { kind: 'ok' }) });
  await f.client.start(f.world);
  await f.flush();
  refuse = true;
  f.set({ hat: { askew: true } });
  assert.equal(await f.client.sceneChanged(), false);
  refuse = false;
  f.set({ pose: { name: 'LOAF', facing: 'left' } });
  assert.equal(await f.client.sceneChanged(), true);
  assert.deepEqual(f.of('scene.report').at(-1).dirty, ['pose', 'hat']);
  f.set({ activity: { kind: 'groom', frame: 3 } });
  await f.client.sceneChanged();
  assert.deepEqual(f.of('scene.report').at(-1).dirty, ['activity'], 'accepted fields are not repeated');
});

test('a Host that no longer counts this body\'s read makes it read again before reporting', async () => {
  const saved = { schemaVersion: 1, hat: { askew: true } };
  let session = true;
  const f = fixture({
    reads: [{ kind: 'scene', status: 'not_found' }, { kind: 'scene', status: 'found', revision: 1, snapshot: saved }],
    reply: command => (command.kind === 'scene.report' && !session ? { kind: 'error', code: 'session_required' } : { kind: 'ok' }),
  });
  await f.client.start(f.world);
  await f.flush();
  session = false;
  f.set({ hat: { askew: false } });
  assert.equal(await f.client.sceneChanged(), false);
  await f.flush();
  assert.equal(f.of('scene.get').length, 2);
  assert.deepEqual(f.scenes.at(-1), { status: 'found', snapshot: saved });
});

test('anchor and menu are plain body commands; the work area is passed to the world', async () => {
  const f = fixture({ reply: command => (command.kind === 'body.menu' ? { kind: 'error', code: 'unavailable' } : { kind: 'ok' }) });
  await f.client.start(f.world);
  const rect = { x: 1100, y: 670, width: 120, height: 130 };
  f.client.setAnchor(rect);
  f.client.setAnchor({ ...rect });
  assert.deepEqual(f.of('body.anchor'), [{ kind: 'body.anchor', rect }]);
  assert.equal(await f.client.openMenu(), false, 'a Host that cannot open the menu is reported, not assumed');
  assert.deepEqual(f.of('body.menu'), [{ kind: 'body.menu' }]);
  f.emit({ kind: 'body-area', width: 1280, height: 690 });
  f.emit({ kind: 'body-area', width: 0, height: 690 });
  f.emit({ kind: 'body-area', width: 1280.5, height: 690 });
  f.emit({ kind: 'media-stopped', reason: 'hidden' });
  assert.deepEqual(f.areas, [[1280, 690]]);
  for (const command of f.sent) assert.match(command.kind, /^(?:body|scene)\./u, 'a body speaks only body.* and scene.*');
});

test('body-area hands the world the Host\'s standHeight, and nothing for a missing or out-of-contract one', async () => {
  const f = fixture();
  await f.client.start(f.world);
  f.emit({ kind: 'body-area', width: 1440, height: 860, standHeight: 200 });
  f.emit({ kind: 'body-area', width: 1440, height: 860, standHeight: 60 });
  f.emit({ kind: 'body-area', width: 1440, height: 860, standHeight: 480 });
  f.emit({ kind: 'body-area', width: 1440, height: 860 });
  for (const standHeight of [59, 481, 150.5, '150', null, Number.NaN]) f.emit({ kind: 'body-area', width: 1440, height: 860, standHeight });
  f.emit({ kind: 'body-area', width: 0, height: 860, standHeight: 200 });
  assert.deepEqual(f.areas, [[1440, 860, 200], [1440, 860, 60], [1440, 860, 480], [1440, 860],
    [1440, 860], [1440, 860], [1440, 860], [1440, 860], [1440, 860], [1440, 860]],
    'the area always moves; only an in-contract height changes his size');
});

test('body-preferences hands the world the owner\'s 自主活动 setting, and nothing for a value that is not a boolean', async () => {
  const f = fixture();
  await f.client.start(f.world);
  f.emit({ kind: 'body-preferences', behaviorEnabled: false });
  f.emit({ kind: 'body-preferences', behaviorEnabled: true });
  for (const behaviorEnabled of ['false', 0, null, undefined]) f.emit({ kind: 'body-preferences', behaviorEnabled });
  f.emit({ kind: 'body-preferences' });
  assert.deepEqual(f.preferences, [{ behaviorEnabled: false }, { behaviorEnabled: true }]);
  assert.deepEqual(f.areas, [], 'a preference is not an area');
  f.client.stop();
  f.emit({ kind: 'body-preferences', behaviorEnabled: false });
  assert.equal(f.preferences.length, 2, 'a stopped body hears nothing more');
  for (const command of f.sent) assert.match(command.kind, /^(?:body|scene)\./u, 'the body never reads the setting itself');
});
