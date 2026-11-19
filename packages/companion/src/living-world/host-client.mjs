// F336 Phase C: the living body's side of the companion bridge (contract livingBody, bridge 1.8).
// The body window may send only body.* and scene.* commands; the Host owns everything else.
// - Scene: one scene.get per body. found restores the saved scene and not_found starts a new one.
//   Anything else (error reply, rejected call, malformed answer) leaves the body "unsaved": it keeps
//   playing but never reports, and reads again after 1 s, 2 s, 4 s … up to 30 s.
// - Reports: every semantic change sends the newest snapshot with the fields that differ from the
//   last one sent; a report the Host did not accept hands its fields to the next one. A Host
//   scene-flush is always answered with a fresh snapshot, even when nothing changed.
// - Clicks: body.hit only when the region changes; a 500 ms body.hit.renew timer that does not
//   depend on repainting keeps the lease, and stops while the page is hidden.
// - Size: body-area carries the window size and, from a Host that sizes the cat, standHeight (derived
//   from ballSize, which this window cannot read). A missing or out-of-contract standHeight leaves
//   the cat at the height he already has.
export const SCENE_FIELDS = Object.freeze(['pose', 'ball', 'paper', 'hat', 'activity', 'lastSolo']);
export const RENEW_MS = 500;
export const READ_RETRY_FIRST_MS = 1000;
export const READ_RETRY_MAX_MS = 30000;
/** The contract's bounds on body-area.standHeight (CSS px). */
export const STAND_HEIGHT_MIN = 60;
export const STAND_HEIGHT_MAX = 480;

const rectKeys = ['x', 'y', 'width', 'height'];
const sameRect = (a, b) => Boolean(a && b) && rectKeys.every(key => a[key] === b[key]);
const sameRects = (a, b) => a.length === b.length && a.every((rect, index) => sameRect(rect, b[index]));
const copyRect = rect => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
const encode = value => (value === undefined ? undefined : JSON.stringify(value));
const positiveInteger = value => Number.isInteger(value) && value > 0;
const standHeight = value => (Number.isInteger(value) && value >= STAND_HEIGHT_MIN && value <= STAND_HEIGHT_MAX ? value : undefined);

function documentVisibility(doc) {
  if (!doc) return { hidden: () => false, subscribe: () => () => {} };
  return {
    hidden: () => doc.visibilityState === 'hidden',
    subscribe(callback) {
      doc.addEventListener('visibilitychange', callback);
      return () => doc.removeEventListener('visibilitychange', callback);
    },
  };
}

export function createBodyHostClient({
  bridge,
  timers = globalThis,
  visibility = documentVisibility(globalThis.document),
  log = () => {},
} = {}) {
  const setTimer = (callback, ms) => timers.setTimeout.call(globalThis, callback, ms);
  const clearTimer = id => timers.clearTimeout.call(globalThis, id);
  const setRepeat = (callback, ms) => timers.setInterval.call(globalThis, callback, ms);
  const clearRepeat = id => timers.clearInterval.call(globalThis, id);
  let mode = 'idle'; // idle → reading → saved | unsaved; stopped after stop()
  let world; // {snapshot(), onScene(scene), onArea(width, height, standHeight?)}
  let sent = {}; // field → JSON of the value last sent (or read) for this body
  const carried = new Set(); // fields of reports the Host did not take
  let retryMs = READ_RETRY_FIRST_MS;
  let retryTimer;
  let renewTimer;
  let rects = [];
  let sentRects;
  let anchor;
  let unsubscribeEvents = () => {};
  let unsubscribeVisibility = () => {};

  async function call(command) {
    try {
      return await bridge.request(command);
    } catch {
      return { kind: 'error', code: 'unavailable' };
    }
  }

  const baseline = snapshot => {
    sent = {};
    for (const field of SCENE_FIELDS) if (snapshot && Object.hasOwn(snapshot, field)) sent[field] = encode(snapshot[field]);
    carried.clear();
  };
  function becomeUnsaved(reason) {
    if (mode === 'stopped') return;
    const first = mode !== 'unsaved';
    mode = 'unsaved';
    if (first) world?.onScene({ status: 'unsaved', reason });
    log(`scene unreadable (${reason}); playing unsaved, next read in ${retryMs} ms`);
    retryTimer = setTimer(() => { retryTimer = undefined; void read(); }, retryMs);
    retryMs = Math.min(READ_RETRY_MAX_MS, retryMs * 2);
  }
  async function read() {
    if (mode === 'stopped' || mode === 'saved') return;
    if (mode !== 'unsaved') mode = 'reading';
    const reply = await call({ kind: 'scene.get' });
    if (mode === 'stopped') return;
    if (reply?.kind === 'scene' && reply.status === 'found' && reply.snapshot?.schemaVersion === 1) {
      mode = 'saved';
      retryMs = READ_RETRY_FIRST_MS;
      world?.onScene({ status: 'found', snapshot: reply.snapshot });
      baseline(reply.snapshot);
      return;
    }
    if (reply?.kind === 'scene' && reply.status === 'not_found') {
      mode = 'saved';
      retryMs = READ_RETRY_FIRST_MS;
      world?.onScene({ status: 'not_found' });
      baseline(undefined);
      report(); // the only place a body starts a new saved scene
      return;
    }
    const reason = reply?.kind === 'scene' && reply.status === 'error' ? reply.reason
      : reply?.kind === 'error' ? reply.code : 'malformed';
    becomeUnsaved(reason);
  }

  /** Sends the newest snapshot now; returns false when this body may not or did not report. */
  async function report() {
    if (mode !== 'saved' || !world) return false;
    const snapshot = world.snapshot();
    const dirty = SCENE_FIELDS.filter(field => carried.has(field) || encode(snapshot[field]) !== sent[field]);
    for (const field of SCENE_FIELDS) {
      if (Object.hasOwn(snapshot, field)) sent[field] = encode(snapshot[field]);
      else delete sent[field];
    }
    carried.clear();
    const reply = await call({ kind: 'scene.report', snapshot, dirty });
    if (reply?.kind === 'ok') return true;
    for (const field of dirty) carried.add(field);
    if (reply?.kind === 'error' && reply.code === 'session_required' && mode === 'saved') {
      // The Host no longer counts this body's read (the duty cat changed): read again before reporting.
      mode = 'reading';
      void read();
    }
    return false;
  }

  function stopRenewing() {
    if (renewTimer !== undefined) clearRepeat(renewTimer);
    renewTimer = undefined;
  }
  function syncRenewing() {
    const wanted = mode !== 'stopped' && rects.length > 0 && !visibility.hidden();
    if (!wanted) return stopRenewing();
    renewTimer ??= setRepeat(() => { void call({ kind: 'body.hit.renew' }); }, RENEW_MS);
  }
  function sendRegion() {
    sentRects = rects.map(copyRect);
    void call({ kind: 'body.hit', rects: sentRects });
  }

  function onEvent(event) {
    if (mode === 'stopped' || !event || typeof event !== 'object') return;
    if (event.kind === 'scene-flush') void report();
    else if (event.kind === 'body-area' && positiveInteger(event.width) && positiveInteger(event.height)) {
      world?.onArea(event.width, event.height, standHeight(event.standHeight));
    }
  }
  function onVisibility() {
    if (mode === 'stopped') return;
    if (!visibility.hidden() && rects.length > 0) sendRegion(); // the lease lapsed while hidden
    syncRenewing();
  }

  return {
    get mode() { return mode; },
    /** Mount seam: the world supplies snapshots and receives the scene and area. Reads once. */
    start(attached) {
      if (mode !== 'idle') throw new Error('The body host client starts once');
      world = attached;
      unsubscribeEvents = bridge.subscribe(onEvent) ?? (() => {});
      unsubscribeVisibility = visibility.subscribe(onVisibility) ?? (() => {});
      return read();
    },
    /** A semantic change (paper landed or picked up, hat, activity, pose): report it now. */
    sceneChanged: () => report(),
    /** Where the cat is clickable, in body-window CSS pixels. Sent only when it changes. */
    setHitRects(next) {
      if (mode === 'stopped') return;
      rects = next.map(copyRect);
      if (!sentRects || !sameRects(rects, sentRects)) sendRegion();
      syncRenewing();
    },
    /** The cat's visible body rect; the Host places the panel beside it. */
    setAnchor(rect) {
      if (mode === 'stopped' || sameRect(rect, anchor)) return;
      anchor = copyRect(rect);
      void call({ kind: 'body.anchor', rect: anchor });
    },
    /** A context click on the cat: the Host opens the ordinary menu. */
    async openMenu() {
      if (mode === 'stopped') return false;
      return (await call({ kind: 'body.menu' }))?.kind === 'ok';
    },
    stop() {
      mode = 'stopped';
      stopRenewing();
      if (retryTimer !== undefined) clearTimer(retryTimer);
      retryTimer = undefined;
      unsubscribeEvents();
      unsubscribeVisibility();
    },
  };
}
