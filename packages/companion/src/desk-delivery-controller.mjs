import { replyVisibleDuration } from './reply-letter-controller.mjs';

export const DESK_BUNDLE_MIN_MS = 12_000;
export const DESK_MAX_MS = 30_000;
export const DESK_SAVED_TAG_MS = 4_000;
const OUTCOMES = new Set(['settled', 'stale_delivery', 'failed']);
const SETTLED_ROWS = new Set(['opened', 'added', 'removed']);
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u;
const REMEMBERED = 64;

/** Single: the reply-letter formula over sentence and title. Bundle: at least 12s, never above 30s. */
export function deskVisibleDuration(delivery) {
  if (delivery.mode === 'single') {
    const [item] = delivery.items;
    return replyVisibleDuration(`${item.sentence ?? ''}${item.title}`);
  }
  const titles = delivery.items.map(item => item.title).join('');
  return Math.min(DESK_MAX_MS, Math.max(DESK_BUNDLE_MIN_MS, replyVisibleDuration(titles)));
}

/** from:null means several cats brought the items, so the desk cat speaks with its own name. */
export function deskHeader(from, deskCatName) {
  if (!from) return deskCatName;
  return from.role === 'watcher' ? `守望猫 · ${from.displayName}` : from.displayName;
}

const rasterUrl = (image, maxLength) => {
  if (!image || !IMAGE_TYPES.has(image.mediaType) || typeof image.dataBase64 !== 'string'
    || image.dataBase64.length > maxLength || image.dataBase64.length % 4 !== 0 || !BASE64.test(image.dataBase64)) return null;
  return `data:${image.mediaType};base64,${image.dataBase64}`;
};

/** Only bounded raster bytes for the exact item become an image; everything else stays a neutral tile. */
export function deskThumbnailUrl(reply, { scopeRef, deliveryRef, itemRef }) {
  return rasterUrl(reply?.kind === 'desk-thumbnail' && reply.scopeRef === scopeRef
    && reply.deliveryRef === deliveryRef && reply.itemRef === itemRef ? reply.image : null, 400_000);
}

/** The delivering cat's avatar for this exact delivery, or null so the header keeps only its text. */
export function deskAvatarUrl(reply, { scopeRef, deliveryRef }) {
  return rasterUrl(reply?.kind === 'desk-avatar' && reply.scopeRef === scopeRef
    && reply.deliveryRef === deliveryRef ? reply.image : null, 60_000);
}

const remember = (set, value) => {
  set.delete(value);
  set.add(value);
  if (set.size > REMEMBERED) set.delete(set.values().next().value);
};

/**
 * Renderer projection of Host-owned desk deliveries. The Host decides what is
 * brought, where it lives and what opening or adding does; this controller only
 * fences stale state, keeps the reply-letter pause/retain countdown while the
 * bubble is actually visible, and returns opaque references with one action.
 */
export class DeskDeliveryController {
  constructor({ client, render = () => {}, now = Date.now, schedule = setTimeout, cancel = clearTimeout,
    savedTagMs = DESK_SAVED_TAG_MS }) {
    Object.assign(this, { client, render, now, savedTagMs });
    this.schedule = (...args) => Reflect.apply(schedule, globalThis, args);
    this.cancel = (...args) => Reflect.apply(cancel, globalThis, args);
    this.scopeRef = null;
    this.revision = -1;
    this.current = null;
    this.epoch = 0;
    this.visible = false;
    this.retained = false;
    this.pauseReasons = new Set();
    this.timerHandle = null;
    this.timerStartedAt = null;
    this.remainingMs = 0;
    this.totalMs = 0;
    this.tag = null;
    this.tagHandle = null;
    this.shown = new Set();
    this.finished = new Set();
    this.closed = false;
  }

  consume(snapshot) {
    if (this.closed || !snapshot || typeof snapshot.scopeRef !== 'string' || !Number.isSafeInteger(snapshot.revision)) return false;
    if (this.scopeRef !== null && snapshot.scopeRef !== this.scopeRef) return false;
    if (snapshot.revision <= this.revision) return false;
    this.scopeRef = snapshot.scopeRef;
    this.revision = snapshot.revision;
    const delivery = snapshot.status === 'ready' ? snapshot.delivery : null;
    const presented = Boolean(delivery) && !this.finished.has(delivery.deliveryRef)
      && this.current?.deliveryRef !== delivery.deliveryRef;
    if (!delivery || this.finished.has(delivery.deliveryRef)) this.drop();
    else if (presented) this.present(delivery);
    else this.update(delivery);
    this.emit();
    // A replacement is reported shown only after its own content has rendered; a first
    // delivery still waits for setVisible(), i.e. for the Host to place the panel.
    if (presented && this.current && this.visible) {
      this.reveal();
      this.emit();
    }
    return true;
  }

  present(delivery) {
    this.drop();
    this.clearTag();
    this.current = {
      epoch: ++this.epoch, deliveryRef: delivery.deliveryRef, mode: delivery.mode, from: delivery.from,
      more: delivery.more, rows: new Map(), avatar: null, avatarKey: null, avatarRead: null,
    };
    this.totalMs = deskVisibleDuration(delivery);
    this.remainingMs = this.totalMs;
    this.update(delivery);
  }

  update(delivery) {
    const current = this.current;
    Object.assign(current, { mode: delivery.mode, from: delivery.from, more: delivery.more });
    const incoming = new Map(delivery.items.map(item => [item.itemRef, item]));
    const rows = new Map();
    // Rows the person already opened or added stay as receipts until the bubble closes,
    // even when the Host has dropped them; anything else the Host withdrew disappears.
    for (const [itemRef, row] of current.rows) {
      const item = incoming.get(itemRef);
      if (item) rows.set(itemRef, { ...row, item });
      else if (row.state === 'opened' || row.state === 'added') rows.set(itemRef, row);
    }
    for (const item of delivery.items) {
      if (!rows.has(item.itemRef)) rows.set(item.itemRef, { item, state: 'idle', thumbnail: null, thumbnailRead: null });
    }
    current.rows = rows;
    for (const [itemRef, row] of rows) {
      if (!incoming.has(itemRef)) continue;
      if (!row.item.thumbnail) rows.set(itemRef, { ...row, thumbnail: null, thumbnailRead: null });
      else if (!row.thumbnail && this.readStale(row.thumbnailRead)) void this.loadThumbnail(current, itemRef);
    }
    // A different bringer never inherits the previous face; its own read starts at this revision.
    const avatarKey = delivery.from ? `${delivery.from.catId}\u0000${delivery.from.role ?? ''}` : null;
    if (avatarKey !== current.avatarKey) Object.assign(current, { avatarKey, avatar: null, avatarRead: null });
    if (avatarKey && !current.avatar && this.readStale(current.avatarRead)) void this.loadAvatar(current);
    if ([...rows.values()].every(row => SETTLED_ROWS.has(row.state))) this.finish();
  }

  /** A read needs (re)issuing unless one finished or is still in flight for the current revision. */
  readStale(read) {
    return !read || (!read.done && read.revision !== this.revision);
  }

  /** Replies apply only to the exact scope, delivery and Host revision they were requested at. */
  readCurrent(current, read) {
    return this.current === current && this.scopeRef === read.scopeRef
      && current.deliveryRef === read.deliveryRef && this.revision === read.revision;
  }

  setVisible(visible) {
    if (this.visible === visible) return;
    this.visible = visible;
    if (visible) this.reveal();
    else this.pauseTimer();
    this.emit();
  }

  reveal() {
    const current = this.current;
    if (!current || !this.visible) return;
    if (!this.shown.has(current.deliveryRef)) {
      remember(this.shown, current.deliveryRef);
      void this.settleWhole('shown');
    }
    this.startTimer();
  }

  pause(reason) {
    if (this.pauseReasons.has(reason)) return;
    this.pauseReasons.add(reason);
    this.pauseTimer();
    this.emit();
  }

  resume(reason) {
    if (!this.pauseReasons.delete(reason)) return;
    this.startTimer();
    this.emit();
  }

  pin() {
    if (!this.current || this.retained) return;
    this.retained = true;
    this.pauseTimer();
    this.emit();
  }

  dismiss() { return this.settleWhole('dismiss'); }

  async act(itemRef) {
    const current = this.current;
    const row = current?.rows.get(itemRef);
    if (!row || !['idle', 'failed'].includes(row.state)) return false;
    const { scopeRef, revision } = this;
    const action = row.item.action;
    const before = row.state;
    this.setRow(current, itemRef, { state: 'pending' });
    this.emit();
    let reply = null;
    try {
      reply = await this.client.settleDesk(scopeRef, current.deliveryRef, action, itemRef);
    } catch {
      // A lost reply leaves the item actionable; the Host remains the only truth.
    }
    if (this.current !== current || !current.rows.has(itemRef)) return false;
    // No reply at all reads as a failed attempt; a reply for another item or an older Host
    // revision is ignored and the row goes back to what it was, claiming nothing.
    const matched = this.matches(reply, { scopeRef, revision, deliveryRef: current.deliveryRef, action, itemRef });
    const state = reply === null ? 'failed' : !matched ? before
      : reply.outcome === 'failed' ? 'failed' : reply.outcome === 'stale_delivery' ? 'removed'
        : action === 'add' ? 'added' : 'opened';
    this.setRow(current, itemRef, { state });
    if ([...current.rows.values()].every(value => SETTLED_ROWS.has(value.state))) this.finish();
    this.emit();
    return state === 'added' || state === 'opened';
  }

  async settleWhole(action) {
    const current = this.current;
    if (!current) return false;
    const { scopeRef, revision, epoch } = this;
    if (action !== 'shown') {
      this.finish();
      this.emit();
    }
    let reply;
    try {
      reply = await this.client.settleDesk(scopeRef, current.deliveryRef, action);
    } catch {
      return false;
    }
    if (!this.matches(reply, { scopeRef, revision, deliveryRef: current.deliveryRef, action })) return false;
    if (action === 'shown' && reply.outcome === 'stale_delivery' && this.current === current) {
      this.finish();
      this.emit();
    }
    // The Host alone decides whether an unanswered delivery was kept; never claim it otherwise.
    if (action === 'timeout' && reply.outcome === 'settled' && reply.saved === true
      && this.epoch === epoch && !this.current && !this.closed) this.showTag('saved');
    return reply.outcome === 'settled';
  }

  matches(reply, { scopeRef, revision, deliveryRef, action, itemRef }) {
    return reply?.kind === 'desk-settlement' && reply.scopeRef === scopeRef && reply.deliveryRef === deliveryRef
      && reply.action === action && reply.itemRef === itemRef && OUTCOMES.has(reply.outcome)
      && Number.isSafeInteger(reply.revision) && reply.revision >= revision && reply.revision >= this.revision;
  }

  async loadThumbnail(current, itemRef) {
    const read = { scopeRef: this.scopeRef, deliveryRef: current.deliveryRef, revision: this.revision, done: false };
    this.setRow(current, itemRef, { thumbnailRead: read });
    let reply;
    try {
      reply = await this.client.readDeskThumbnail(read.scopeRef, read.deliveryRef, itemRef);
    } catch {
      return; // A lost read leaves the neutral tile and stays unfinished, so a later revision asks again.
    }
    if (!this.readCurrent(current, read) || current.rows.get(itemRef)?.thumbnailRead !== read) return;
    read.done = true;
    const thumbnail = deskThumbnailUrl(reply, { ...read, itemRef });
    if (!thumbnail) return;
    this.setRow(current, itemRef, { thumbnail });
    this.emit();
  }

  async loadAvatar(current) {
    const read = { scopeRef: this.scopeRef, deliveryRef: current.deliveryRef, revision: this.revision, done: false };
    current.avatarRead = read;
    let reply;
    try {
      reply = await this.client.readDeskAvatar(read.scopeRef, read.deliveryRef);
    } catch {
      return; // Without an answer the header keeps its text and a later revision asks again.
    }
    if (!this.readCurrent(current, read) || current.avatarRead !== read) return;
    read.done = true;
    current.avatar = deskAvatarUrl(reply, read);
    if (current.avatar) this.emit();
  }

  setRow(current, itemRef, patch) {
    current.rows.set(itemRef, { ...current.rows.get(itemRef), ...patch });
  }

  finish() {
    if (this.current) remember(this.finished, this.current.deliveryRef);
    this.drop();
  }

  drop() {
    this.pauseTimer();
    this.remainingMs = 0;
    this.current = null;
    this.retained = false;
    this.pauseReasons.clear();
  }

  startTimer() {
    if (this.timerHandle !== null || !this.current || !this.visible || this.retained
      || this.pauseReasons.size > 0 || this.remainingMs <= 0) return;
    const epoch = this.current.epoch;
    this.timerStartedAt = this.now();
    this.timerHandle = this.schedule(() => {
      this.timerHandle = null;
      this.timerStartedAt = null;
      this.remainingMs = 0;
      if (this.current?.epoch === epoch) void this.settleWhole('timeout');
    }, this.remainingMs);
    this.timerHandle?.unref?.();
  }

  pauseTimer() {
    if (this.timerHandle === null) return;
    this.remainingMs = Math.max(0, this.remainingMs - (this.now() - this.timerStartedAt));
    this.cancel(this.timerHandle);
    this.timerHandle = null;
    this.timerStartedAt = null;
  }

  showTag(tag) {
    this.clearTag();
    this.tag = tag;
    this.tagHandle = this.schedule(() => {
      this.tagHandle = null;
      this.tag = null;
      this.emit();
    }, this.savedTagMs);
    this.tagHandle?.unref?.();
    this.emit();
  }

  clearTag() {
    if (this.tagHandle !== null) this.cancel(this.tagHandle);
    this.tagHandle = null;
    this.tag = null;
  }

  close() {
    this.closed = true;
    this.drop();
    this.clearTag();
  }

  snapshot() {
    const current = this.current;
    const elapsed = this.timerHandle === null ? 0 : this.now() - this.timerStartedAt;
    return {
      presentation: current ? 'bubble' : this.tag ? 'tag' : 'none',
      tag: this.tag,
      delivery: current && {
        deliveryRef: current.deliveryRef, mode: current.mode, from: current.from, more: current.more,
        avatar: current.from ? current.avatar : null,
        rows: [...current.rows.values()].map(row => ({ ...row })),
      },
      retained: this.retained,
      timer: {
        running: this.timerHandle !== null,
        remainingMs: Math.max(0, this.remainingMs - elapsed),
        totalMs: this.totalMs,
      },
    };
  }

  emit() { this.render(this.snapshot()); }
}
