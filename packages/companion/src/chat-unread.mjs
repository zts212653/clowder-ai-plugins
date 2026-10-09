/** Counts new assistant call-message identities only after the owner folds an opened chat. */
export class FoldedChatUnread {
  constructor(changed = () => {}) {
    this.changed = changed;
    this.seen = new Set();
    this.count = 0;
    this.armed = false;
    this.folded = false;
  }

  publish(count) {
    if (this.count === count) return;
    this.count = count;
    this.changed(count);
  }

  open() {
    this.armed = true;
    this.folded = false;
    this.publish(0);
  }

  fold() {
    if (this.armed) this.folded = true;
  }

  receive(message) {
    const { messageId, role } = message ?? {};
    if (!messageId || this.seen.has(messageId)) return;
    this.seen.add(messageId);
    if (role === 'assistant' && this.armed && this.folded) this.publish(this.count + 1);
  }

  receiveMany(messages) {
    for (const message of messages) this.receive(message);
  }

  reset() {
    this.seen.clear();
    this.armed = false;
    this.folded = false;
    this.publish(0);
  }
}
