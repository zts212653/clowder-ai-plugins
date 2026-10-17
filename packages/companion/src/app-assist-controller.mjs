const ACTIONS = new Set(['dismiss', 'timeout', 'accept']);

/**
 * Renderer projection only. The Host owns offer creation, expiry and clearing;
 * this controller merely keeps stale reads and replies from reviving UI or
 * turning an old accept into a new action.
 */
export class AppAssistController {
  constructor({
    client,
    changed = () => {},
    accepted = () => {},
    scheduleTimeout = setTimeout,
    cancelTimeout = clearTimeout,
    timeoutMs = 15_000,
  }) {
    this.client = client;
    this.changed = changed;
    this.accepted = accepted;
    this.scheduleTimeout = scheduleTimeout;
    this.cancelTimeout = cancelTimeout;
    this.timeoutMs = timeoutMs;
    this.operation = 0;
    this.timer = null;
    this.timerOfferRef = null;
    this.state = {
      scopeRef: null,
      revision: -1,
      status: null,
      offer: null,
      hiddenRef: null,
      pending: null,
    };
  }

  publish(patch) {
    this.state = { ...this.state, ...patch };
    this.changed(this.state);
  }

  clearTimer() {
    if (this.timer !== null) this.cancelTimeout(this.timer);
    this.timer = null;
    this.timerOfferRef = null;
  }

  armTimer(offerRef) {
    if (this.timer !== null && this.timerOfferRef === offerRef) return;
    this.clearTimer();
    this.timerOfferRef = offerRef;
    this.timer = this.scheduleTimeout(() => {
      this.timer = null;
      this.timerOfferRef = null;
      if (this.state.offer?.offerRef === offerRef) void this.settle('timeout');
    }, this.timeoutMs);
    this.timer?.unref?.();
  }

  consume(snapshot) {
    if (!snapshot || typeof snapshot.scopeRef !== 'string' || !Number.isSafeInteger(snapshot.revision)) return false;
    if (this.state.scopeRef !== null && snapshot.scopeRef !== this.state.scopeRef) return false;
    if (snapshot.revision <= this.state.revision) return false;

    const scopeRef = this.state.scopeRef ?? snapshot.scopeRef;
    const incomingRef = snapshot.offer?.offerRef ?? null;
    const sameHiddenOffer = incomingRef !== null && incomingRef === this.state.hiddenRef;
    const hiddenRef = incomingRef === null || (this.state.hiddenRef && incomingRef !== this.state.hiddenRef)
      ? null
      : this.state.hiddenRef;
    const offer = sameHiddenOffer ? null : snapshot.offer;
    const pending = incomingRef && this.state.pending?.offerRef !== incomingRef ? null : this.state.pending;
    this.publish({ scopeRef, revision: snapshot.revision, status: snapshot.status, offer, hiddenRef, pending });
    if (offer) this.armTimer(offer.offerRef);
    else this.clearTimer();
    return true;
  }

  async settle(action) {
    if (!ACTIONS.has(action) || !this.state.offer || !this.state.scopeRef) return false;
    const pending = {
      id: ++this.operation,
      scopeRef: this.state.scopeRef,
      revision: this.state.revision,
      offerRef: this.state.offer.offerRef,
      action,
    };
    this.clearTimer();
    this.publish({ offer: null, hiddenRef: pending.offerRef, pending });

    let reply;
    try {
      reply = await this.client.settleAppAssist(pending.scopeRef, pending.offerRef, action);
    } catch {
      if (this.state.pending?.id === pending.id) this.publish({ pending: null });
      return false;
    }
    if (this.state.pending?.id !== pending.id) return false;
    const matching = reply?.kind === 'app-assist-settlement'
      && reply.scopeRef === pending.scopeRef
      && reply.offerRef === pending.offerRef
      && reply.action === pending.action
      && Number.isSafeInteger(reply.revision)
      && reply.revision > pending.revision
      && reply.revision >= this.state.revision
      && this.state.status === 'ready';
    if (!matching || reply.outcome !== 'settled') {
      this.publish({ pending: null });
      return false;
    }

    this.publish({ revision: reply.revision, hiddenRef: null, pending: null });
    if (action === 'accept') this.accepted({
      scopeRef: reply.scopeRef,
      revision: reply.revision,
      offerRef: reply.offerRef,
    });
    return true;
  }

  close() {
    this.operation++;
    this.clearTimer();
    this.state = { ...this.state, offer: null, pending: null };
  }
}
