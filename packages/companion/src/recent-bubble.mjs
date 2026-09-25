/** A compact projection of Host history plus the current unsaved voice caption. */
export class RecentBubble {
  constructor(rows) {
    this.rows = rows;
    this.history = [];
    this.live = new Map();
  }
  load(messages) {
    this.history = messages.slice(-2);
    this.render();
  }
  append(role, text) {
    if (!['user', 'assistant'].includes(role) || typeof text !== 'string') return;
    this.live.set(role, `${this.live.get(role) ?? ''}${text}`.slice(-240));
    this.render();
  }
  finish(role) {
    this.live.delete(role);
    this.render();
  }
  reset() {
    this.live.clear();
    this.render();
  }
  hasContent() {
    return this.history.length > 0 || this.live.size > 0;
  }
  render() {
    const live = [...this.live].map(([role, text]) => ({ role, name: role === 'user' ? '你' : '猫猫', text }));
    const entries = [...this.history.slice(-Math.max(0, 2 - live.length)), ...live].slice(-2);
    for (const [index, row] of this.rows.entries()) {
      const entry = entries[index];
      row.hidden = !entry;
      row.textContent = entry ? `${String(entry.name).slice(0, 28)}：${String(entry.text).slice(-120)}` : '';
      row.dataset ??= {};
      row.dataset.role = entry?.role ?? '';
    }
  }
}
