export class TranscriptView {
  constructor(container) {
    this.container = container;
    this.activeRows = new Map();
    this.historyRows = new Map();
    this.completed = new Set();
  }
  append(role, text, chunk = false) {
    const pinned = this.nearBottom();
    this.container.querySelector('.empty')?.remove();
    let row = chunk ? this.activeRows.get(role) : undefined;
    if (!row) {
      row = this.container.ownerDocument.createElement('p');
      row.className = role;
      if (chunk) { row.dataset.live = 'true'; row.dataset.author = `实时语音 · ${role === 'user' ? '你' : '猫猫'}`; }
      this.container.append(row);
      if (chunk) this.activeRows.set(role, row);
    }
    row.textContent = (row.textContent + text).slice(-16000);
    if (pinned) this.container.scrollTop = this.container.scrollHeight;
  }
  finish({ role, transcript, turnId }) {
    if (!['user', 'assistant'].includes(role) || (turnId && this.completed.has(turnId))) return;
    const pinned = this.nearBottom();
    // A provider caption is ephemeral. Only Host history can create a saved row.
    this.activeRows.get(role)?.remove();
    this.activeRows.delete(role);
    if (turnId) this.completed.add(turnId);
    if (this.completed.size > 256) this.completed.delete(this.completed.values().next().value);
    if (pinned) this.container.scrollTop = this.container.scrollHeight;
  }
  nearBottom() {
    return this.container.scrollHeight - this.container.scrollTop - this.container.clientHeight < 32;
  }
  visibleHistoryAnchor() {
    const viewport = this.container.getBoundingClientRect?.();
    if (!viewport) return null;
    for (const [id, row] of this.historyRows) {
      const rect = row.getBoundingClientRect?.();
      if (rect && rect.bottom > viewport.top && rect.top < viewport.bottom)
        return { id, offset: rect.top - viewport.top };
    }
    return null;
  }
  reset() {
    for (const row of this.activeRows.values()) row.remove();
    this.activeRows.clear();
    this.completed.clear();
  }
  load(messages) {
    const pinned = this.nearBottom();
    const readingPosition = this.container.scrollTop;
    const anchor = pinned ? null : this.visibleHistoryAnchor();
    const previous = this.historyRows;
    this.historyRows = new Map();
    const rows = messages.map(message => {
      const row = previous.get(message.id) ?? this.container.ownerDocument.createElement('p');
      row.className = message.role; row.dataset.messageId = message.id;
      if (row.textContent !== message.text) row.textContent = message.text;
      row.title = message.name; row.dataset.author = message.name;
      this.historyRows.set(message.id, row);
      return row;
    });
    this.container.replaceChildren(...rows, ...this.activeRows.values());
    if (pinned) this.container.scrollTop = this.container.scrollHeight;
    else if (anchor) {
      const row = this.historyRows.get(anchor.id) ?? rows[0];
      const rect = row?.getBoundingClientRect?.();
      const viewport = this.container.getBoundingClientRect?.();
      this.container.scrollTop = rect && viewport
        ? this.container.scrollTop + rect.top - viewport.top - anchor.offset
        : readingPosition;
    } else this.container.scrollTop = readingPosition;
  }
}
