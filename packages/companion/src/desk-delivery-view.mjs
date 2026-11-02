import { deskHeader } from './desk-delivery-controller.mjs';

const ACTION_LABEL = { open: '打开', add: '添加' };
const DONE_LABEL = { opened: '已打开', added: '已添加' };
const FAILED_LABEL = { open: '没打开', add: '没加上' };
const RING_LENGTH = 40.84;

const setText = (node, text) => { if (node.textContent !== text) node.textContent = text; };

/** DOM projection of one desk delivery: text only, data: thumbnails only, actions go back to the controller. */
export class DeskDeliveryView {
  constructor({ document, controller, displayName = () => '猫猫', reducedMotion = () => false,
    schedule = setTimeout, cancel = clearTimeout }) {
    this.document = document;
    this.$ = id => document.getElementById(id);
    Object.assign(this, { controller, displayName, reducedMotion });
    this.schedule = (...args) => Reflect.apply(schedule, globalThis, args);
    this.cancel = (...args) => Reflect.apply(cancel, globalThis, args);
    this.rows = new Map();
    this.rowsRef = null;
    this.ringRef = null;
    this.animation = null;
    this.bind();
  }

  bind() {
    const bubble = this.$('desk-bubble');
    bubble.addEventListener('pointerenter', () => this.controller.pause('hover'));
    bubble.addEventListener('pointerleave', () => this.controller.resume('hover'));
    bubble.addEventListener('focusin', () => this.controller.pause('focus'));
    bubble.addEventListener('focusout', event => {
      if (!event.relatedTarget || !bubble.contains?.(event.relatedTarget)) this.controller.resume('focus');
    });
    const pauseScroll = () => {
      this.controller.pause('scroll');
      if (this.scrollTimer !== undefined) this.cancel(this.scrollTimer);
      this.scrollTimer = this.schedule(() => {
        this.scrollTimer = undefined;
        this.controller.resume('scroll');
      }, 500);
      this.scrollTimer?.unref?.();
    };
    bubble.addEventListener('wheel', pauseScroll);
    bubble.addEventListener('scroll', pauseScroll);
    bubble.addEventListener('pointerdown', () => this.controller.pause('pointer'));
    bubble.addEventListener('pointerup', () => this.controller.resume('pointer'));
    bubble.addEventListener('pointercancel', () => this.controller.resume('pointer'));
    this.$('desk-retain').onclick = () => this.controller.pin();
    this.$('desk-close').onclick = () => { void this.controller.dismiss(); };
    this.$('desk-dismiss').onclick = () => { void this.controller.dismiss(); };
    this.$('desk-open').onclick = () => {
      const row = this.value?.delivery?.rows[0];
      if (row) void this.controller.act(row.item.itemRef);
    };
  }

  render(value) {
    this.value = value;
    const root = this.$('desk');
    const delivery = value.delivery;
    root.dataset.presentation = value.presentation;
    this.$('desk-bubble').hidden = !delivery;
    this.$('desk-tag').hidden = value.presentation !== 'tag';
    this.syncRing(delivery?.deliveryRef ?? null, value);
    if ((delivery?.deliveryRef ?? null) !== this.rowsRef) {
      for (const nodes of this.rows.values()) nodes.row.remove();
      this.rows.clear();
      this.rowsRef = delivery?.deliveryRef ?? null;
    }
    if (!delivery) return;
    root.dataset.mode = delivery.mode;
    setText(this.$('desk-name'), deskHeader(delivery.from, this.displayName()));
    this.$('desk-retain').hidden = value.retained;
    this.$('desk-close').hidden = !value.retained;
    const rows = delivery.rows.filter(row => row.state !== 'removed');
    const single = delivery.mode === 'single';
    if (single && rows[0]) this.renderSingle(rows[0]);
    this.$('desk-open').hidden = !single || !rows[0];
    this.$('desk-list').hidden = single;
    if (!single) this.renderBundle(rows);
    const more = !single && delivery.more > 0;
    this.$('desk-more').hidden = !more;
    setText(this.$('desk-more'), more ? `还有 ${delivery.more} 件在 Cat Café` : '');
  }

  renderSingle({ item, state, thumbnail }) {
    const text = this.$('desk-text');
    setText(text, item.sentence ?? item.title);
    text.hidden = false;
    const thumb = this.$('desk-thumb');
    thumb.hidden = !thumbnail;
    const image = this.$('desk-thumb-image');
    if (thumbnail && image.getAttribute('src') !== thumbnail) image.setAttribute('src', thumbnail);
    if (image.alt !== item.title) image.alt = item.title;
    // Without the picture the person still needs to know what 打开 would open.
    const title = this.$('desk-title');
    title.hidden = Boolean(thumbnail) || item.sentence === undefined;
    setText(title, title.hidden ? '' : item.title);
    const button = this.$('desk-open');
    const label = ACTION_LABEL[item.action];
    setText(button, label);
    button.setAttribute('aria-label', `${label}「${item.title}」`);
    button.disabled = state === 'pending';
    const note = this.$('desk-note');
    note.hidden = state !== 'failed';
    setText(note, state === 'failed' ? FAILED_LABEL[item.action] : '');
  }

  renderBundle(rows) {
    for (const id of ['desk-text', 'desk-thumb', 'desk-title', 'desk-note']) this.$(id).hidden = true;
    const list = this.$('desk-list');
    const keep = new Set(rows.map(row => row.item.itemRef));
    for (const [itemRef, nodes] of this.rows) {
      if (!keep.has(itemRef)) { nodes.row.remove(); this.rows.delete(itemRef); }
    }
    rows.forEach((row, index) => {
      const nodes = this.rows.get(row.item.itemRef) ?? this.createRow(row.item.itemRef);
      if (list.children[index] !== nodes.row) list.insertBefore(nodes.row, list.children[index] ?? null);
      this.renderRow(nodes, row);
    });
  }

  createRow(itemRef) {
    const row = this.$('desk-row-template').content.firstElementChild.cloneNode(true);
    const nodes = {
      row,
      tile: row.querySelector('.desk-row-thumb'),
      icon: row.querySelector('.desk-row-thumb use'),
      title: row.querySelector('.desk-row-text b'),
      source: row.querySelector('.desk-row-text small'),
      note: row.querySelector('.desk-note'),
      button: row.querySelector('button'),
      image: null,
    };
    nodes.button.onclick = () => { void this.controller.act(itemRef); };
    this.rows.set(itemRef, nodes);
    return nodes;
  }

  renderRow(nodes, { item, state, thumbnail }) {
    nodes.tile.dataset.kind = item.thumbnail ? 'image' : item.kind;
    if (thumbnail && !nodes.image) {
      nodes.image = this.document.createElement('img');
      nodes.image.alt = '';
      nodes.tile.append(nodes.image);
    }
    if (nodes.image && thumbnail && nodes.image.getAttribute('src') !== thumbnail) nodes.image.setAttribute('src', thumbnail);
    nodes.icon.setAttribute('href', item.kind === 'suggestion' ? '#i-desk-note' : '#i-desk-doc');
    setText(nodes.title, item.title);
    const source = item.source.conversationTitle ?? '';
    setText(nodes.source, source);
    nodes.source.hidden = !source;
    const label = DONE_LABEL[state] ?? ACTION_LABEL[item.action];
    setText(nodes.button, label);
    nodes.button.setAttribute('aria-label', `${label}「${item.title}」`);
    nodes.button.disabled = !['idle', 'failed'].includes(state);
    nodes.note.hidden = state !== 'failed';
    setText(nodes.note, state === 'failed' ? FAILED_LABEL[item.action] : '');
  }

  /** The ring mirrors the controller's own clock, so pausing, hiding and resuming never restart it. */
  syncRing(deliveryRef, value) {
    if (deliveryRef !== this.ringRef) {
      this.animation?.cancel();
      this.animation = null;
      this.ringRef = deliveryRef;
    }
    const progress = this.$('desk-retain').querySelector('.reply-ring-progress');
    if (!deliveryRef || value.retained || typeof progress?.animate !== 'function') return;
    this.animation ??= progress.animate(
      [{ strokeDashoffset: 0 }, { strokeDashoffset: RING_LENGTH }],
      { duration: value.timer.totalMs, fill: 'forwards', easing: this.reducedMotion() ? 'steps(15, end)' : 'linear' },
    );
    this.animation.currentTime = value.timer.totalMs - value.timer.remainingMs;
    if (value.timer.running) this.animation.play();
    else this.animation.pause();
  }
}
