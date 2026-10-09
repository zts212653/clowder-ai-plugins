/** Counts stable call-message identities only after the owner folds an opened chat. */
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

  receive(messageId) {
    if (!messageId || this.seen.has(messageId)) return;
    this.seen.add(messageId);
    if (this.armed && this.folded) this.publish(this.count + 1);
  }

  receiveMany(messageIds) {
    for (const messageId of messageIds) this.receive(messageId);
  }

  reset() {
    this.seen.clear();
    this.armed = false;
    this.folded = false;
    this.publish(0);
  }
}
