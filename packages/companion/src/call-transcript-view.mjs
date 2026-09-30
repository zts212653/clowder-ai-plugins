const MAX_LIVE_ROWS = 8;

/**
 * Projection of the Host-bound transcript for one trusted call.
 *
 * Durable rows are keyed only by Host messageId. Ephemeral audio is keyed by
 * provider item/turn identity and is discarded when the Host projects the
 * matching durable source. Text equality is deliberately never used.
 */
export class CallTranscriptView {
  constructor(container, { onUnread = () => {} } = {}) {
    this.container = container;
    this.onUnread = onUnread;
    this.durableRows = new Map();
    this.liveRows = new Map();
    this.liveSequence = 0;
    this.optimisticIds = new Set();
    this.unread = 0;
    this.initialized = false;
    container.addEventListener?.('scroll', () => {
      if (this.nearBottom()) this.setUnread(0);
    });
  }

  setCall(callId) {
    if (this.callId === callId) return;
    this.callId = callId ?? null;
    this.scope = undefined;
    this.durableRows.clear();
    this.liveRows.clear();
    this.liveSequence = 0;
    this.optimisticIds.clear();
    this.initialized = false;
    this.container.replaceChildren();
    this.container.dataset.callId = this.callId ?? '';
    this.container.dataset.hasMore = 'false';
    this.setUnread(0);
  }

  reset() { this.setCall(null); }

  nearBottom() {
    return this.container.scrollHeight - this.container.scrollTop - this.container.clientHeight < 32;
  }

  scrollToBottom() {
    this.container.scrollTop = this.container.scrollHeight;
    this.setUnread(0);
  }

  setUnread(count) {
    if (this.unread === count) return;
    this.unread = count;
    this.onUnread(count);
  }

  visibleAnchor() {
    const viewport = this.container.getBoundingClientRect?.();
    if (!viewport) return null;
    for (const [id, row] of this.durableRows) {
      const rect = row.getBoundingClientRect?.();
      if (rect && rect.bottom > viewport.top && rect.top < viewport.bottom) {
        return { id, offset: rect.top - viewport.top };
      }
    }
    return null;
  }

  createRow() {
    return this.container.ownerDocument.createElement('p');
  }

  updateDurable(row, value) {
    row.className = `call-transcript-row ${value.source.kind} ${value.role}`;
    row.textContent = value.text;
    row.dataset.messageId = value.messageId;
    row.dataset.source = value.source.kind;
    row.dataset.role = value.role;
    delete row.dataset.live;
    delete row.dataset.itemId;
    delete row.dataset.turnId;
    delete row.dataset.optimistic;
    if (value.source.kind === 'voice') {
      row.dataset.itemId = value.source.nativeItemId;
      if (value.source.nativeTurnId) row.dataset.turnId = value.source.nativeTurnId;
      delete row.dataset.clientMessageId;
    } else {
      row.dataset.clientMessageId = value.source.clientMessageId;
    }
    row.setAttribute?.('aria-label', value.source.kind === 'typed'
      ? `你打字说：${value.text}`
      : value.role === 'assistant' ? `猫猫：${value.text}` : `语音转写：${value.text}`);
    return row;
  }

  removeReconciledLive(source) {
    if (source.kind !== 'voice') return false;
    let removed = false;
    for (const [key, row] of this.liveRows) {
      if ((row.dataset.itemId && row.dataset.itemId === source.nativeItemId)
        || (source.nativeTurnId && row.dataset.turnId === source.nativeTurnId)) {
        this.liveRows.delete(key);
        removed = true;
      }
    }
    return removed;
  }

  render() {
    this.container.replaceChildren(...this.durableRows.values(), ...this.liveRows.values());
  }

  load(reply) {
    if (!this.callId || reply?.kind !== 'transcript' || reply.scope?.callId !== this.callId) return false;
    const pinned = this.nearBottom();
    const readingPosition = this.container.scrollTop;
    const anchor = pinned ? null : this.visibleAnchor();
    const previous = this.durableRows;
    const previousIds = new Set(previous.keys());
    const next = new Map();
    let added = 0;

    for (const value of reply.rows) {
      const reconciledLive = this.removeReconciledLive(value.source);
      const row = previous.get(value.messageId) ?? this.createRow();
      this.updateDurable(row, value);
      this.optimisticIds.delete(value.messageId);
      next.set(value.messageId, row);
      if (this.initialized && !previousIds.has(value.messageId) && !reconciledLive) added += 1;
    }
    // An accepted delivery already has a durable Host messageId. A transcript
    // read can race the MessageStore projection, so keep that exact row until
    // the same id appears; never fall back to matching its text.
    for (const id of this.optimisticIds) {
      const row = previous.get(id);
      if (row && !next.has(id)) next.set(id, row);
    }

    this.scope = reply.scope;
    this.durableRows = next;
    this.container.dataset.callId = reply.scope.callId;
    this.container.dataset.hasMore = String(reply.hasMore);
    this.render();

    if (pinned) {
      this.container.scrollTop = this.container.scrollHeight;
      this.setUnread(0);
    } else if (anchor) {
      const row = this.durableRows.get(anchor.id) ?? this.durableRows.values().next().value;
      const rect = row?.getBoundingClientRect?.();
      const viewport = this.container.getBoundingClientRect?.();
      this.container.scrollTop = rect && viewport
        ? this.container.scrollTop + rect.top - viewport.top - anchor.offset
        : readingPosition;
      if (added) this.setUnread(this.unread + added);
    } else {
      this.container.scrollTop = readingPosition;
      if (added) this.setUnread(this.unread + added);
    }
    this.initialized = true;
    return true;
  }

  liveKey(event) {
    if (event.itemId) return `item:${event.itemId}`;
    if (event.turnId) return `turn:${event.turnId}`;
    return `ephemeral:${++this.liveSequence}`;
  }

  appendLive(event) {
    if (!this.callId || event?.type !== 'transcript' || event.callId !== this.callId) return false;
    const pinned = this.nearBottom();
    const key = this.liveKey(event);
    let row = this.liveRows.get(key);
    const isNew = !row;
    if (!row) {
      row = this.createRow();
      row.className = `call-transcript-row voice ${event.role}`;
      row.dataset.live = 'true';
      row.dataset.source = 'voice';
      row.dataset.role = event.role;
      if (event.itemId) row.dataset.itemId = event.itemId;
      if (event.turnId) row.dataset.turnId = event.turnId;
      this.liveRows.set(key, row);
      while (this.liveRows.size > MAX_LIVE_ROWS) this.liveRows.delete(this.liveRows.keys().next().value);
    }
    row.textContent = `${row.textContent}${event.text}`.slice(-16000);
    row.setAttribute?.('aria-label', `${event.role === 'assistant' ? '猫猫' : '语音转写'}，实时：${row.textContent}`);
    this.render();
    if (pinned) {
      this.container.scrollTop = this.container.scrollHeight;
      this.setUnread(0);
    } else if (isNew) this.setUnread(this.unread + 1);
    return true;
  }

  appendTyped({ receipt, text }) {
    if (!this.callId || receipt?.delivery !== 'accepted' || receipt.callId !== this.callId) return false;
    const pinned = this.nearBottom();
    let row = this.durableRows.get(receipt.messageId);
    const isNew = !row;
    if (!row) {
      row = this.createRow();
      this.durableRows.set(receipt.messageId, row);
    }
    this.updateDurable(row, {
      messageId: receipt.messageId,
      role: 'user',
      text,
      source: { kind: 'typed', clientMessageId: receipt.clientMessageId, callId: receipt.callId },
    });
    row.dataset.optimistic = 'true';
    this.optimisticIds.add(receipt.messageId);
    while (this.optimisticIds.size > MAX_LIVE_ROWS) {
      const oldest = this.optimisticIds.values().next().value;
      this.optimisticIds.delete(oldest);
      if (this.durableRows.get(oldest)?.dataset.optimistic === 'true') this.durableRows.delete(oldest);
    }
    this.render();
    if (pinned) {
      this.container.scrollTop = this.container.scrollHeight;
      this.setUnread(0);
    } else if (isNew) this.setUnread(this.unread + 1);
    return true;
  }

  finish(event) {
    if (!this.callId || event?.type !== 'turn-done' || event.callId !== this.callId) return false;
    for (const row of this.liveRows.values()) {
      const matchesTurn = event.turnId && row.dataset.turnId === event.turnId;
      const matchesUnkeyedRole = !event.turnId && event.role && !row.dataset.itemId
        && !row.dataset.turnId && row.dataset.role === event.role;
      if (matchesTurn || matchesUnkeyedRole) row.dataset.complete = 'true';
    }
    this.render();
    return true;
  }
}
