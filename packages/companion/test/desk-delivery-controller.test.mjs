import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DESK_BUNDLE_MIN_MS, DESK_SAVED_TAG_MS, DeskDeliveryController, deskHeader, deskThumbnailUrl, deskVisibleDuration,
} from '../src/desk-delivery-controller.mjs';
import { replyVisibleDuration } from '../src/reply-letter-controller.mjs';

const watcher = { catId: 'codex61-sol', displayName: '小太阳', role: 'watcher' };
const sheet = {
  itemRef: 'item-sheet', kind: 'work', title: '六猫岛 · 单采肖像参考', sentence: '鲸鲸那三格，照他的头像画就行。',
  source: { conversationTitle: '「视频」自媒体视频运营' }, action: 'open', thumbnail: true,
};
const northstar = { itemRef: 'item-northstar', kind: 'work', title: '守望猫北极星稿 v1.5', source: { conversationTitle: '守望猫' },
  action: 'open', thumbnail: false };
const notes = { itemRef: 'item-notes', kind: 'suggestion', title: '添加 7 条视频批注', source: { conversationTitle: '守望猫' },
  action: 'add', thumbnail: false };
const single = (deliveryRef = 'delivery-1', item = sheet) => ({ deliveryRef, mode: 'single', from: watcher, items: [item], more: 0 });
const bundle = (items = [sheet, northstar, notes], more = 0) => ({ deliveryRef: 'delivery-b', mode: 'bundle', from: null, items, more });
const state = (revision, delivery, { scopeRef = 'desk-scope', status = 'ready' } = {}) => ({ scopeRef, revision, status, delivery });
const flush = () => new Promise(resolve => setImmediate(resolve));

function clock() {
  let now = 1_000;
  let id = 0;
  const timers = new Map();
  return {
    now: () => now,
    schedule: (callback, delay) => { timers.set(++id, { callback, at: now + delay }); return id; },
    cancel: handle => timers.delete(handle),
    advance(ms) {
      const until = now + ms;
      for (;;) {
        const [next] = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at);
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].callback();
      }
      now = until;
    },
    pending: () => timers.size,
  };
}

function fixture({ settle, thumbnail } = {}) {
  const time = clock();
  const calls = [];
  const renders = [];
  const client = {
    settleDesk: async (scopeRef, deliveryRef, action, itemRef) => {
      calls.push(itemRef === undefined ? [action, deliveryRef] : [action, deliveryRef, itemRef]);
      if (settle) return settle({ scopeRef, deliveryRef, action, itemRef });
      return { kind: 'desk-settlement', scopeRef, revision: 50, deliveryRef, action,
        ...(itemRef === undefined ? {} : { itemRef }), outcome: 'settled', ...(action === 'timeout' ? { saved: true } : {}) };
    },
    readDeskThumbnail: async (scopeRef, deliveryRef, itemRef) => {
      calls.push(['thumbnail', deliveryRef, itemRef]);
      return thumbnail ? thumbnail({ scopeRef, deliveryRef, itemRef })
        : { kind: 'desk-thumbnail', scopeRef, deliveryRef, itemRef, image: null };
    },
  };
  const controller = new DeskDeliveryController({ client, render: value => renders.push(value), now: time.now,
    schedule: time.schedule, cancel: time.cancel });
  return { controller, calls, renders, time, last: () => renders.at(-1),
    settled: () => calls.filter(call => call[0] !== 'thumbnail') };
}

test('visible time reuses the reply-letter formula; bundles hold at least 12 seconds and at most 30', () => {
  assert.equal(deskVisibleDuration(single()), replyVisibleDuration(`${sheet.sentence}${sheet.title}`));
  assert.equal(deskVisibleDuration(single('d', { ...sheet, sentence: undefined })), replyVisibleDuration(sheet.title));
  assert.equal(deskVisibleDuration(bundle([northstar])), DESK_BUNDLE_MIN_MS);
  const long = Array.from({ length: 8 }, (_, index) => ({ ...northstar, itemRef: `n-${index}`, title: '很长的标题'.repeat(8) }));
  assert.equal(deskVisibleDuration(bundle(long)), 30_000);
});

test('the header names the watcher role, a single cat, or the desk cat itself for several cats', () => {
  assert.equal(deskHeader(watcher, '宪宪'), '守望猫 · 小太阳');
  assert.equal(deskHeader({ catId: 'codex61-sol', displayName: '小太阳' }, '宪宪'), '小太阳');
  assert.equal(deskHeader(null, '宪宪'), '宪宪');
});

test('a delivery settles shown exactly once and only after it is actually visible', async () => {
  const f = fixture();
  assert.equal(f.controller.consume(state(1, single())), true);
  assert.equal(f.last().presentation, 'bubble');
  assert.deepEqual(f.settled(), [], 'a delivery waiting behind another panel has not been shown');
  assert.equal(f.last().timer.running, false);
  f.controller.setVisible(true);
  await flush();
  assert.deepEqual(f.settled(), [['shown', 'delivery-1']]);
  assert.equal(f.last().timer.running, true);
  f.controller.setVisible(false);
  f.controller.setVisible(true);
  assert.equal(f.controller.consume(state(2, single())), true, 'a newer revision of the same delivery');
  await flush();
  assert.deepEqual(f.settled(), [['shown', 'delivery-1']], 'hiding, reshowing and refreshing never repeat shown');
});

test('scope and revision fencing ignore stale, repeated and foreign snapshots', () => {
  const f = fixture();
  f.controller.consume(state(5, single()));
  assert.equal(f.controller.consume(state(5, null)), false, 'an equal revision is a repeated read');
  assert.equal(f.controller.consume(state(4, null)), false, 'an older revision cannot withdraw a newer delivery');
  assert.equal(f.controller.consume(state(9, null, { scopeRef: 'foreign-scope' })), false);
  assert.equal(f.last().delivery.deliveryRef, 'delivery-1');
  assert.equal(f.controller.consume(state(6, single(), { status: 'suspended' })), true);
  assert.equal(f.last().presentation, 'none', 'a suspended desk shows nothing even if a delivery is attached');
  assert.equal(f.controller.consume(state(7, null, { status: 'off' })), true);
  assert.equal(f.last().presentation, 'none');
});

test('hover, focus, pointer and scroll pause one countdown; the ring pins it like a reply letter', async () => {
  const f = fixture();
  f.controller.consume(state(1, single()));
  f.controller.setVisible(true);
  const total = f.last().timer.totalMs;
  f.time.advance(2_000);
  f.controller.pause('hover');
  f.controller.pause('focus');
  assert.equal(f.last().timer.running, false);
  assert.equal(f.last().timer.remainingMs, total - 2_000);
  f.time.advance(60_000);
  f.controller.resume('hover');
  assert.equal(f.last().timer.running, false, 'focus still holds the countdown');
  f.controller.resume('focus');
  assert.equal(f.last().timer.running, true);
  f.controller.pause('pointer');
  f.controller.pause('scroll');
  f.controller.resume('pointer');
  f.controller.resume('scroll');
  f.time.advance(1_000);
  f.controller.pin();
  assert.equal(f.last().retained, true);
  assert.equal(f.last().timer.running, false);
  f.time.advance(60_000);
  await flush();
  assert.equal(f.last().presentation, 'bubble', 'a retained delivery never times out');
  assert.deepEqual(f.settled(), [['shown', 'delivery-1']]);
});

test('the countdown runs only while visible and ends with a timeout settlement', async () => {
  const f = fixture();
  f.controller.consume(state(1, single()));
  f.controller.setVisible(true);
  const total = f.last().timer.totalMs;
  f.time.advance(total - 1_000);
  f.controller.setVisible(false);
  f.time.advance(120_000);
  assert.equal(f.last().presentation, 'bubble', 'a delivery hidden behind another panel keeps its remaining time');
  f.controller.setVisible(true);
  f.time.advance(1_000);
  await flush();
  assert.deepEqual(f.settled(), [['shown', 'delivery-1'], ['timeout', 'delivery-1']]);
});

test('a timeout shows the saved name tag for four seconds only when the Host says saved:true', async () => {
  for (const [saved, expectTag] of [[true, true], [false, false], [undefined, false]]) {
    const f = fixture({ settle: ({ scopeRef, deliveryRef, action }) => ({
      kind: 'desk-settlement', scopeRef, revision: 9, deliveryRef, action, outcome: 'settled',
      ...(action === 'timeout' && saved !== undefined ? { saved } : {}),
    }) });
    f.controller.consume(state(1, single()));
    f.controller.setVisible(true);
    f.time.advance(f.last().timer.totalMs);
    assert.equal(f.last().presentation, 'none', 'the bubble leaves as soon as its time is up');
    await flush();
    assert.equal(f.last().presentation, expectTag ? 'tag' : 'none', `saved=${saved}`);
    if (!expectTag) continue;
    assert.equal(f.last().tag, 'saved');
    f.time.advance(DESK_SAVED_TAG_MS - 1);
    assert.equal(f.last().presentation, 'tag');
    f.time.advance(1);
    assert.equal(f.last().presentation, 'none');
  }
  const failed = fixture({ settle: ({ scopeRef, deliveryRef, action }) => ({
    kind: 'desk-settlement', scopeRef, revision: 9, deliveryRef, action, outcome: 'failed', saved: true,
  }) });
  failed.controller.consume(state(1, single()));
  failed.controller.setVisible(true);
  failed.time.advance(failed.last().timer.totalMs);
  await flush();
  assert.equal(failed.last().presentation, 'none', 'a failed timeout never claims the delivery was saved');
});

test('add settles one row: settled disables it, failed keeps it with a note, stale removes it', async () => {
  const outcomes = { 'item-notes': 'failed', 'item-sheet': 'stale_delivery', 'item-northstar': 'settled' };
  const f = fixture({ settle: ({ scopeRef, deliveryRef, action, itemRef }) => ({
    kind: 'desk-settlement', scopeRef, revision: 9, deliveryRef, action, ...(itemRef ? { itemRef } : {}),
    outcome: itemRef ? outcomes[itemRef] : 'settled',
  }) });
  f.controller.consume(state(1, bundle()));
  f.controller.setVisible(true);
  const row = itemRef => f.last().delivery.rows.find(value => value.item.itemRef === itemRef);

  const adding = f.controller.act('item-notes');
  assert.equal(row('item-notes').state, 'pending');
  assert.equal(await f.controller.act('item-notes'), false, 'a pending row cannot be sent twice');
  assert.equal(await adding, false);
  assert.equal(row('item-notes').state, 'failed', 'a failed add keeps its button and says so');
  outcomes['item-notes'] = 'settled';
  assert.equal(await f.controller.act('item-notes'), true, 'a failed add can be tried again');
  assert.equal(row('item-notes').state, 'added');
  assert.equal(await f.controller.act('item-notes'), false, 'an added row is a receipt, not a button');

  await f.controller.act('item-sheet');
  assert.equal(row('item-sheet').state, 'removed');
  assert.equal(f.last().presentation, 'bubble');
  await f.controller.act('item-northstar');
  assert.equal(f.last().presentation, 'none', 'a bundle closes once every row is settled');
  assert.deepEqual(f.settled().slice(1), [
    ['add', 'delivery-b', 'item-notes'], ['add', 'delivery-b', 'item-notes'],
    ['open', 'delivery-b', 'item-sheet'], ['open', 'delivery-b', 'item-northstar'],
  ]);
  assert.equal(f.controller.consume(state(2, bundle())), true);
  assert.equal(f.last().presentation, 'none', 'the same finished delivery is not revived by a later read');
});

test('a thrown or mismatched reply leaves the item actionable instead of claiming success', async () => {
  let reply = () => { throw new Error('lost'); };
  const f = fixture({ settle: value => reply(value) });
  f.controller.consume(state(1, single('delivery-1', notes)));
  f.controller.setVisible(true);
  assert.equal(await f.controller.act('item-notes'), false);
  assert.equal(f.last().delivery.rows[0].state, 'failed');
  reply = ({ scopeRef, deliveryRef }) => ({ kind: 'desk-settlement', scopeRef, revision: 9, deliveryRef, action: 'add',
    itemRef: 'other-item', outcome: 'settled' });
  assert.equal(await f.controller.act('item-notes'), false);
  assert.equal(f.last().delivery.rows[0].state, 'failed');
});

test('opening a single item closes it; dismiss settles the whole delivery and closes at once', async () => {
  const f = fixture();
  f.controller.consume(state(1, single()));
  f.controller.setVisible(true);
  assert.equal(await f.controller.act('item-sheet'), true);
  assert.equal(f.last().presentation, 'none');

  f.controller.consume(state(2, single('delivery-2')));
  assert.equal(f.last().presentation, 'bubble');
  const dismissing = f.controller.dismiss();
  assert.equal(f.last().presentation, 'none', 'dismiss hides before the Host replies');
  assert.equal(await dismissing, true);
  f.controller.consume(state(3, single('delivery-2')));
  assert.equal(f.last().presentation, 'none');
  assert.deepEqual(f.settled(), [
    ['shown', 'delivery-1'], ['open', 'delivery-1', 'item-sheet'], ['shown', 'delivery-2'], ['dismiss', 'delivery-2'],
  ]);
});

test('Host refreshes keep receipts the person made and drop rows the Host withdrew', async () => {
  const f = fixture();
  f.controller.consume(state(1, bundle()));
  f.controller.setVisible(true);
  await f.controller.act('item-notes');
  f.controller.consume(state(2, bundle([northstar])));
  assert.deepEqual(f.last().delivery.rows.map(row => [row.item.itemRef, row.state]),
    [['item-northstar', 'idle'], ['item-notes', 'added']]);
});

test('thumbnails are fetched for thumbnail items only and become data: URLs only for exact raster replies', async () => {
  const image = { mediaType: 'image/jpeg', dataBase64: 'AAAA', width: 320, height: 200 };
  const f = fixture({ thumbnail: ({ scopeRef, deliveryRef, itemRef }) => ({ kind: 'desk-thumbnail', scopeRef, deliveryRef, itemRef, image }) });
  f.controller.consume(state(1, bundle()));
  await flush();
  assert.deepEqual(f.calls.filter(call => call[0] === 'thumbnail'), [['thumbnail', 'delivery-b', 'item-sheet']]);
  assert.equal(f.last().delivery.rows[0].thumbnail, 'data:image/jpeg;base64,AAAA');
  assert.equal(f.last().delivery.rows[1].thumbnail, null);

  const expected = { scopeRef: 's', deliveryRef: 'd', itemRef: 'i' };
  const reply = value => ({ kind: 'desk-thumbnail', ...expected, image: { ...image, ...value } });
  assert.equal(deskThumbnailUrl(reply({}), expected), 'data:image/jpeg;base64,AAAA');
  assert.equal(deskThumbnailUrl(reply({ mediaType: 'text/html' }), expected), null);
  assert.equal(deskThumbnailUrl(reply({ mediaType: 'image/svg+xml' }), expected), null);
  assert.equal(deskThumbnailUrl(reply({ dataBase64: 'AA"><script>' }), expected), null);
  assert.equal(deskThumbnailUrl(reply({ dataBase64: 'AAA' }), expected), null);
  assert.equal(deskThumbnailUrl({ ...reply({}), itemRef: 'other' }, expected), null);
  assert.equal(deskThumbnailUrl({ ...reply({}), image: null }, expected), null);
});

test('a newer delivery replaces the old one; late replies for the old delivery change nothing', async () => {
  const release = new Map();
  const f = fixture({ settle: ({ scopeRef, deliveryRef, action, itemRef }) => new Promise(resolve => {
    release.set(`${action}:${deliveryRef}`, () => resolve({ kind: 'desk-settlement', scopeRef, revision: 9, deliveryRef, action,
      ...(itemRef ? { itemRef } : {}), outcome: 'settled', ...(action === 'timeout' ? { saved: true } : {}) }));
  }) });
  f.controller.consume(state(1, single()));
  f.controller.setVisible(true);
  release.get('shown:delivery-1')();
  f.time.advance(f.last().timer.totalMs);
  f.controller.consume(state(2, single('delivery-2')));
  release.get('timeout:delivery-1')();
  await flush();
  assert.equal(f.last().delivery.deliveryRef, 'delivery-2');
  assert.equal(f.last().presentation, 'bubble', 'a saved tag for an old delivery never covers a new one');
  f.controller.close();
  f.controller.consume(state(3, single('delivery-3')));
  assert.equal(f.time.pending(), 0, 'closing the renderer releases every timer');
});
