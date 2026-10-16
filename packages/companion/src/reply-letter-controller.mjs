const MIN_VISIBLE_MS = 6_000;
const MAX_VISIBLE_MS = 30_000;

export function replyVisibleDuration(text) {
  return Math.min(MAX_VISIBLE_MS, MIN_VISIBLE_MS + Math.ceil([...text].length / 8) * 1_000);
}

const rowBody = row => ({
  revision: row.body?.revision ?? '',
  complete: row.body?.complete === true,
  continuation: row.body?.continuation ?? null,
});

/**
 * Transient presentation state for a Host-owned conversation.
 *
 * Inputs are normalized bridge rows. In particular, inputMessageIds must be
 * supplied by the trusted Host projection; this controller never guesses a
 * relationship from timestamps, call ids, adjacency or equal text.
 */
export class ReplyLetterController {
  constructor({ render, requestContinuation = () => {}, now = Date.now,
    schedule = setTimeout, cancel = clearTimeout }) {
    Object.assign(this, { render, requestContinuation, now });
    this.schedule = (...args) => Reflect.apply(schedule, globalThis, args);
    this.cancel = (...args) => Reflect.apply(cancel, globalThis, args);
    this.mode = 'idle';
    this.pending = new Map();
    this.settled = [];
    this.pairs = new Map();
    this.history = [];
    this.draft = null;
    this.letter = null;
    this.reply = null;
    this.retained = false;
    this.hasNewer = false;
    this.selectedMessageId = null;
    this.pauseReasons = new Set();
    this.requestedContinuations = new Set();
    this.dismissedReplies = new Set();
    this.timerHandle = null;
    this.timerStartedAt = null;
    this.timerRemainingMs = 0;
    this.blockedReason = null;
    this.draftNotice = null;
  }

  recordDelivery(receipt, text, context = {}) {
    this.blockedReason = null;
    if (receipt.delivery !== 'accepted') {
      this.draft = {
        text,
        clientMessageId: receipt.clientMessageId,
        ...(context.submissionRevision === undefined ? {} : { submissionRevision: context.submissionRevision }),
        ...(context.scopeRef === undefined ? {} : { scopeRef: context.scopeRef }),
        settlement: receipt.delivery === 'rejected' ? receipt.reason : 'unconfirmed',
      };
      if (this.mode !== 'history') this.mode = 'compose';
      this.emit();
      return;
    }
    const letter = { text, clientMessageId: receipt.clientMessageId, inputMessageId: receipt.messageId };
    const known = this.pending.get(receipt.messageId) ?? this.pairs.get(receipt.messageId)?.letter;
    if (known?.clientMessageId === receipt.clientMessageId) {
      if (this.draft?.clientMessageId === receipt.clientMessageId) this.draft = null;
      this.emit();
      return;
    }
    this.pending.set(receipt.messageId, letter);
    if (context.restored === false || this.draft?.clientMessageId === receipt.clientMessageId) this.draft = null;
    if (this.mode !== 'history') {
      this.stopTimer();
      this.reply = null;
      this.letter = letter;
      this.retained = false;
      this.mode = 'sent';
    }
    this.emit();
  }

  invalidateDraft(value) {
    this.draft = {
      text: value.text,
      clientMessageId: value.clientMessageId,
      submissionRevision: value.submissionRevision,
      scopeRef: value.scopeRef,
      settlement: value.reason ?? 'scope_changed',
    };
    if (this.mode !== 'history') this.mode = 'compose';
    this.emit();
  }

  setDraftNotice(value) {
    if (this.draftNotice === value) return;
    this.draftNotice = value;
    this.emit();
  }

  openCompose() {
    this.stopTimer();
    this.mode = 'compose';
    this.retained = false;
    this.hasNewer = false;
    this.emit();
  }

  loadHistory(rows) {
    this.history = rows.map(row => ({
      id: row.id,
      role: row.role,
      text: row.text,
      body: rowBody(row),
      inputMessageIds: [...(row.inputMessageIds ?? [])],
      responsePhase: row.responsePhase ?? 'unknown',
      deliveryReceipt: row.deliveryReceipt ? { ...row.deliveryReceipt } : undefined,
    }));
    let restoredLetter = null;
    for (const row of this.history) {
      const receipt = row.deliveryReceipt;
      if (row.role !== 'user' || receipt?.delivery !== 'accepted' || receipt.messageId !== row.id) continue;
      if (this.pending.has(row.id) || this.pairs.has(row.id)) continue;
      restoredLetter = {
        text: row.text,
        clientMessageId: receipt.clientMessageId,
        inputMessageId: row.id,
      };
      this.pending.set(row.id, restoredLetter);
    }
    let newestPair = null;
    for (const row of this.history) {
      if (row.role !== 'assistant') continue;
      if (row.responsePhase === 'completed') this.requestMissingBody(row);
      for (const inputMessageId of row.inputMessageIds) {
        const pending = this.pending.get(inputMessageId);
        const existing = this.pairs.get(inputMessageId);
        if (!pending && !existing) continue;
        if (row.responsePhase !== 'completed') {
          if (pending) {
            const updated = { ...pending, responsePhase: row.responsePhase };
            this.pending.set(inputMessageId, updated);
            if (this.letter?.inputMessageId === inputMessageId) this.letter = updated;
          }
          continue;
        }
        const letter = pending ?? existing.letter;
        const pair = { inputMessageId, replyId: row.id, letter, reply: this.replyValue(row) };
        if (!existing) {
          this.pending.delete(inputMessageId);
          this.settled.push({ inputMessageId, replyId: row.id });
        }
        this.pairs.set(inputMessageId, pair);
        newestPair = pair;
      }
    }

    if (newestPair && this.mode === 'history') {
      if (newestPair.replyId !== this.selectedMessageId) this.hasNewer = true;
    } else if (newestPair && !this.dismissedReplies.has(newestPair.replyId)) {
      const changedReply = this.reply?.id !== newestPair.replyId;
      const becameComplete = this.reply?.id === newestPair.replyId
        && this.reply.complete === false && newestPair.reply.complete === true;
      this.letter = newestPair.letter;
      this.reply = newestPair.reply;
      this.selectedMessageId = newestPair.replyId;
      this.mode = 'reply';
      if (changedReply) {
        this.retained = false;
        this.pauseReasons.clear();
        this.stopTimer();
      }
      if ((changedReply || becameComplete) && newestPair.reply.complete) {
        this.timerRemainingMs = replyVisibleDuration(newestPair.reply.text);
        this.startTimer();
      }
    } else if (this.mode === 'sent') {
      this.letter = [...this.pending.values()].at(-1) ?? null;
      if (!this.letter) this.mode = 'idle';
    } else if (restoredLetter && this.mode === 'idle') {
      this.letter = restoredLetter;
      this.mode = 'sent';
    }
    this.emit();
  }

  replyValue(row) {
    return { id: row.id, text: row.text, complete: row.body.complete,
      responsePhase: row.responsePhase };
  }

  requestMissingBody(row) {
    const reference = row.body.continuation;
    if (row.body.complete || !reference) {
      for (const key of this.requestedContinuations) {
        if (key.startsWith(`${row.id}\u0000`)) this.requestedContinuations.delete(key);
      }
      return;
    }
    const key = `${row.id}\u0000${reference}`;
    if (this.requestedContinuations.has(key)) return;
    this.requestedContinuations.add(key);
    this.requestContinuation({ messageId: row.id, continuation: reference });
  }

  releaseContinuation(messageId, continuation) {
    this.requestedContinuations.delete(`${messageId}\u0000${continuation}`);
  }

  pause(reason) {
    if (this.pauseReasons.has(reason)) return;
    this.pauseReasons.add(reason);
    if (this.timerHandle !== null) {
      this.timerRemainingMs = Math.max(0, this.timerRemainingMs - (this.now() - this.timerStartedAt));
      this.stopTimer(false);
    }
    this.emit();
  }

  resume(reason) {
    if (!this.pauseReasons.delete(reason)) return;
    if (this.pauseReasons.size === 0) this.startTimer();
    this.emit();
  }

  pin() {
    if (this.mode !== 'reply') return;
    this.retained = true;
    this.stopTimer();
    this.emit();
  }

  close() {
    if (this.reply) this.dismissedReplies.add(this.reply.id);
    this.stopTimer();
    this.reply = null;
    this.retained = false;
    this.selectedMessageId = null;
    this.letter = [...this.pending.values()].at(-1) ?? null;
    this.mode = this.letter ? 'sent' : 'idle';
    this.emit();
  }

  withdrawReply(replyId) {
    let restored = null;
    for (const [inputMessageId, pair] of this.pairs) {
      if (pair.replyId !== replyId) continue;
      restored = { ...pair.letter, responsePhase: 'withdrawn' };
      this.pairs.delete(inputMessageId);
      this.pending.set(inputMessageId, restored);
    }
    this.settled = this.settled.filter(value => value.replyId !== replyId);
    this.history = this.history.filter(value => value.id !== replyId);
    this.dismissedReplies.delete(replyId);
    for (const key of this.requestedContinuations) {
      if (key.startsWith(`${replyId}\u0000`)) this.requestedContinuations.delete(key);
    }
    if (this.reply?.id === replyId) {
      this.stopTimer();
      this.reply = null;
      this.retained = false;
      this.selectedMessageId = null;
      this.letter = restored ?? [...this.pending.values()].at(-1) ?? null;
      this.mode = this.letter ? 'sent' : 'idle';
    }
    this.emit();
  }

  clearProtected(reason) {
    this.stopTimer();
    this.pending.clear();
    this.settled = [];
    this.pairs.clear();
    this.history = [];
    this.letter = null;
    this.reply = null;
    this.retained = false;
    this.hasNewer = false;
    this.selectedMessageId = null;
    this.requestedContinuations.clear();
    this.dismissedReplies.clear();
    this.blockedReason = reason;
    this.mode = this.draft ? 'compose' : 'idle';
    this.emit();
  }

  openHistory(messageId = this.selectedMessageId) {
    this.stopTimer();
    this.mode = 'history';
    this.retained = true;
    this.selectedMessageId = messageId;
    this.hasNewer = false;
    this.emit();
  }

  returnLatest() {
    this.selectedMessageId = this.settled.at(-1)?.replyId ?? this.history.at(-1)?.id ?? null;
    this.hasNewer = false;
    this.emit();
  }

  startTimer() {
    if (this.timerHandle !== null || this.timerRemainingMs <= 0 || this.retained
      || this.mode !== 'reply' || !this.reply?.complete || this.pauseReasons.size > 0) return;
    this.timerStartedAt = this.now();
    this.timerHandle = this.schedule(() => {
      this.timerHandle = null;
      this.timerStartedAt = null;
      this.timerRemainingMs = 0;
      this.close();
    }, this.timerRemainingMs);
  }

  stopTimer(reset = true) {
    if (this.timerHandle !== null) this.cancel(this.timerHandle);
    this.timerHandle = null;
    this.timerStartedAt = null;
    if (reset) this.timerRemainingMs = 0;
  }

  snapshot() {
    const elapsed = this.timerHandle === null ? 0 : this.now() - this.timerStartedAt;
    return {
      mode: this.mode,
      draft: this.draft,
      letter: this.letter,
      reply: this.reply,
      retained: this.retained,
      selectedMessageId: this.selectedMessageId,
      hasNewer: this.hasNewer,
      blockedReason: this.blockedReason,
      draftNotice: this.draftNotice,
      pendingInputMessageIds: [...this.pending.keys()],
      settled: this.settled.map(value => ({ ...value })),
      history: this.history.map(row => ({ ...row, body: { ...row.body }, inputMessageIds: [...row.inputMessageIds] })),
      timer: {
        running: this.timerHandle !== null,
        remainingMs: Math.max(0, this.timerRemainingMs - elapsed),
      },
    };
  }

  emit() { this.render(this.snapshot()); }
}
