const copyRow = row => ({
  ...row,
  body: { ...row.body },
  inputMessageIds: [...row.inputMessageIds],
});

/** In-memory presentation cache for the Host-owned v2 conversation projection. */
export class ConversationHistory {
  constructor({ changed = () => {} } = {}) {
    this.changed = changed;
    this.rows = new Map();
    this.order = [];
    this.latestIds = new Set();
    this.tokens = new Map();
    this.consumed = new Map();
    this.threadTitle = '';
    this.hasMoreOlder = false;
    this.olderCursor = null;
    this.pageStatus = 'idle';
    this.loadedOlder = false;
  }

  loadPage(page, { older = false } = {}) {
    if (page.status !== 'available') {
      this.pageStatus = 'stale';
      this.emit();
      return false;
    }
    this.pageStatus = 'available';
    this.threadTitle = page.threadTitle;
    const pageIds = [];
    for (const value of page.messages) {
      pageIds.push(value.id);
      this.mergeRow(value);
    }
    const inPage = new Set(pageIds);
    if (older) {
      this.order = [...pageIds, ...this.order.filter(id => !inPage.has(id))];
    } else {
      const overlapsLatest = pageIds.some(id => this.latestIds.has(id));
      const keepEarlier = this.latestIds.size === 0 || overlapsLatest || this.loadedOlder;
      this.order = [...(keepEarlier ? this.order.filter(id => !inPage.has(id)) : []), ...pageIds];
      this.latestIds = inPage;
      for (const id of [...this.rows.keys()]) {
        if (!this.order.includes(id)) this.remove(id);
      }
    }
    if (older || !this.loadedOlder) {
      this.hasMoreOlder = page.hasMoreOlder;
      this.olderCursor = page.olderCursor;
    }
    if (older) this.loadedOlder = true;
    this.emit();
    return true;
  }

  mergeRow(value) {
    const previous = this.rows.get(value.id);
    const next = {
      ...value,
      body: { ...value.body },
      inputMessageIds: [...value.inputMessageIds],
      bodyStatus: value.body.complete ? 'complete' : 'loading',
    };
    if (!previous || previous.body.revision !== value.body.revision) {
      this.forgetMessageTokens(value.id);
      this.consumed.set(value.id, new Set());
      this.rows.set(value.id, next);
      this.registerContinuation(next);
      return;
    }

    if (previous.text.startsWith(value.text)) {
      next.text = previous.text;
      next.body = previous.body;
      next.bodyStatus = previous.bodyStatus;
    } else if (!value.text.startsWith(previous.text)) {
      next.text = previous.text;
      next.body = previous.body;
      next.bodyStatus = 'stale';
    }
    this.rows.set(value.id, next);
    this.registerContinuation(next);
  }

  bodyContinuation(messageId) {
    const value = this.rows.get(messageId);
    return value?.bodyStatus === 'loading' ? value.body.continuation : null;
  }

  applyBody(continuation, reply) {
    const binding = this.tokens.get(continuation);
    if (!binding) return false;
    const value = this.rows.get(binding.messageId);
    if (!value || value.body.revision !== binding.revision) return false;
    if (reply.status === 'withdrawn') {
      this.remove(binding.messageId);
      this.emit();
      return true;
    }
    if (reply.status === 'stale') {
      value.bodyStatus = 'stale';
      this.emit();
      return true;
    }
    const used = this.consumed.get(binding.messageId) ?? new Set();
    if (used.has(continuation)) return true;
    if (reply.messageId !== binding.messageId || reply.body.revision !== binding.revision
      || value.body.continuation !== continuation) {
      value.bodyStatus = 'stale';
      this.emit();
      return false;
    }
    used.add(continuation);
    this.consumed.set(binding.messageId, used);
    value.text += reply.text;
    value.body = { ...reply.body };
    value.bodyStatus = reply.body.complete ? 'complete' : 'loading';
    if (!reply.body.complete && used.has(reply.body.continuation)) value.bodyStatus = 'stale';
    this.registerContinuation(value);
    this.emit();
    return value.bodyStatus !== 'stale';
  }

  registerContinuation(value) {
    const continuation = value.body.continuation;
    if (!continuation || value.bodyStatus !== 'loading') return;
    this.tokens.set(continuation, { messageId: value.id, revision: value.body.revision });
  }

  forgetMessageTokens(messageId) {
    for (const [token, binding] of this.tokens) {
      if (binding.messageId === messageId) this.tokens.delete(token);
    }
  }

  remove(messageId) {
    this.rows.delete(messageId);
    this.order = this.order.filter(id => id !== messageId);
    this.forgetMessageTokens(messageId);
    this.consumed.delete(messageId);
  }

  clearProtected(reason) {
    this.rows.clear();
    this.order = [];
    this.latestIds.clear();
    this.tokens.clear();
    this.consumed.clear();
    this.threadTitle = '';
    this.hasMoreOlder = false;
    this.olderCursor = null;
    this.pageStatus = reason;
    this.emit();
  }

  message(messageId) {
    const value = this.rows.get(messageId);
    return value ? copyRow(value) : undefined;
  }

  snapshot() {
    return {
      threadTitle: this.threadTitle,
      messages: this.order.flatMap(id => {
        const value = this.rows.get(id);
        return value ? [copyRow(value)] : [];
      }),
      hasMoreOlder: this.hasMoreOlder,
      olderCursor: this.olderCursor,
      pageStatus: this.pageStatus,
    };
  }

  emit() { this.changed(this.snapshot()); }
}
