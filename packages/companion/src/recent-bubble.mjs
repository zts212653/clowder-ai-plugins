/** A compact projection of Host history plus the current unsaved voice caption. */
function referenceKey(reference) {
  if (reference?.kind === 'message') return `message:${reference.messageId}`;
  if (reference?.kind === 'native-item') return `native-item:${reference.nativeItemId}`;
  return null;
}

export class RecentBubble {
  constructor(rows, { showSpeaker = true } = {}) {
    this.rows = rows;
    this.showSpeaker = showSpeaker;
    this.history = [];
    this.live = new Map();
    this.rowReferences = new WeakMap();
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
      reference: { kind: 'message', messageId: row.messageId },
    })));
  }
  append(role, text, name = role === 'user' ? '你' : '猫猫', reference) {
    if (!['user', 'assistant'].includes(role) || typeof text !== 'string') return;
    const previous = this.live.get(role);
    this.live.set(role, { name, text: `${previous?.text ?? ''}${text}`.slice(-240),
      reference: reference ?? previous?.reference });
    this.render();
    return reference ? this.rowsForReference(reference)[0] : this.rows.find(row => row.dataset?.role === role);
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
  rowsForReference(reference) {
    const key = referenceKey(reference);
    return key ? this.rows.filter(row => this.rowReferences.get(row) === key) : [];
  }
  render() {
    const live = [...this.live].map(([role, value]) => ({ role, ...value }));
    const entries = [...this.history.slice(-Math.max(0, 2 - live.length)), ...live].slice(-2);
    for (const [index, row] of this.rows.entries()) {
      const entry = entries[index];
      row.hidden = !entry;
      const speaker = entry && this.showSpeaker ? `${String(entry.name).slice(0, 28)}：` : '';
      const message = entry ? String(entry.text).slice(-120) : '';
      row.textContent = `${speaker}${message}`;
      if (entry && row.ownerDocument?.createElement && typeof row.replaceChildren === 'function') {
        const speakerNode = row.ownerDocument.createElement('span');
        const messageNode = row.ownerDocument.createElement('span');
        const messageText = row.ownerDocument.createElement('bdi');
        speakerNode.className = 'recent-speaker';
        speakerNode.hidden = !speaker;
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
      const key = referenceKey(entry?.reference);
      if (key) this.rowReferences.set(row, key);
      else this.rowReferences.delete(row);
    }
  }
}
