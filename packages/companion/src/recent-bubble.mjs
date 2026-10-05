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
  loadTranscript(rows, companionName = '猫猫') {
    this.load(rows.map(row => ({
      role: row.role,
      text: row.text,
      name: row.source?.kind === 'typed' ? '你' : row.role === 'assistant' ? companionName : '语音',
    })));
  }
  append(role, text, name = role === 'user' ? '你' : '猫猫') {
    if (!['user', 'assistant'].includes(role) || typeof text !== 'string') return;
    const previous = this.live.get(role);
    this.live.set(role, { name, text: `${previous?.text ?? ''}${text}`.slice(-240) });
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
  clear() {
    this.history = [];
    this.live.clear();
    this.render();
  }
  hasContent() {
    return this.history.length > 0 || this.live.size > 0;
  }
  render() {
    const live = [...this.live].map(([role, value]) => ({ role, ...value }));
    const entries = [...this.history.slice(-Math.max(0, 2 - live.length)), ...live].slice(-2);
    for (const [index, row] of this.rows.entries()) {
      const entry = entries[index];
      row.hidden = !entry;
      const speaker = entry ? `${String(entry.name).slice(0, 28)}：` : '';
      const message = entry ? String(entry.text).slice(-120) : '';
      row.textContent = `${speaker}${message}`;
      if (entry && row.ownerDocument?.createElement && typeof row.replaceChildren === 'function') {
        const speakerNode = row.ownerDocument.createElement('span');
        const messageNode = row.ownerDocument.createElement('span');
        const messageText = row.ownerDocument.createElement('bdi');
        speakerNode.className = 'recent-speaker';
        messageNode.className = 'recent-message';
        messageText.className = 'recent-message-text';
        messageText.dir = 'auto';
        speakerNode.textContent = speaker;
        // dir=auto resolves the first strong character. Reversing code points for
        // this hidden-in-the-same-tick probe therefore resolves the latest strong
        // character, which is the edge this compact tail projection must retain.
        messageText.textContent = Array.from(message).reverse().join('');
        messageNode.append(messageText);
        row.replaceChildren(speakerNode, messageNode);
        const direction = row.ownerDocument.defaultView?.getComputedStyle(messageText).direction;
        messageText.dir = direction === 'rtl' ? 'rtl' : 'ltr';
        messageText.textContent = message;
        messageNode.dataset.direction = direction === 'rtl' ? 'rtl' : 'ltr';
      }
      row.dataset ??= {};
      row.dataset.role = entry?.role ?? '';
    }
  }
}
