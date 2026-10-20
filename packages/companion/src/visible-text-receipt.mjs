const MAX_PENDING = 64;
const MAX_REPORT_ATTEMPTS = 3;
const REPORT_RETRY_DELAYS_MS = [1_000, 2_000];
const CLIPPING_OVERFLOW = new Set(['auto', 'clip', 'hidden', 'scroll']);

function referenceKey(reference) {
  if (reference?.kind === 'message' && typeof reference.messageId === 'string')
    return `message:${reference.messageId}`;
  if (reference?.kind === 'native-item' && typeof reference.nativeItemId === 'string')
    return `native-item:${reference.nativeItemId}`;
  return null;
}

function intersect(bounds, rect) {
  return {
    left: Math.max(bounds.left, rect.left),
    top: Math.max(bounds.top, rect.top),
    right: Math.min(bounds.right, rect.right),
    bottom: Math.min(bounds.bottom, rect.bottom),
  };
}

function nodeIsVisible(document, node) {
  if (document.visibilityState !== 'visible' || node?.isConnected !== true) return false;
  const view = document.defaultView;
  if (!view) return false;
  const rects = node.getClientRects?.();
  if (!rects || rects.length === 0) return false;
  const viewport = {
    left: 0,
    top: 0,
    right: document.documentElement?.clientWidth ?? view.innerWidth,
    bottom: document.documentElement?.clientHeight ?? view.innerHeight,
  };
  let visible = intersect(viewport, node.getBoundingClientRect());
  for (let current = node; current; current = current.parentElement) {
    if (current.hidden || current.getAttribute?.('aria-hidden') === 'true') return false;
    const style = view.getComputedStyle?.(current);
    if (style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse'
      || style?.opacity === '0') return false;
    const clipsX = CLIPPING_OVERFLOW.has(style?.overflowX ?? style?.overflow);
    const clipsY = CLIPPING_OVERFLOW.has(style?.overflowY ?? style?.overflow);
    if ((clipsX || clipsY) && current !== node) {
      const bounds = current.getBoundingClientRect?.();
      if (bounds) visible = intersect(visible, {
        left: clipsX ? bounds.left : visible.left,
        right: clipsX ? bounds.right : visible.right,
        top: clipsY ? bounds.top : visible.top,
        bottom: clipsY ? bounds.bottom : visible.bottom,
      });
    }
  }
  return visible.right > visible.left && visible.bottom > visible.top;
}

function currentNodes(candidate) {
  try {
    const nodes = typeof candidate.nodes === 'function' ? candidate.nodes() : candidate.nodes;
    return Array.isArray(nodes) ? nodes.filter(Boolean) : [];
  } catch {
    return [];
  }
}

function errorCode(value) {
  return typeof value?.code === 'string' ? value.code : undefined;
}

/**
 * Reports the first assistant text that reaches a visible renderer surface.
 * A post-mutation animation frame plus DOM/document/viewport checks is not a
 * claim that the compositor painted, the window was unoccluded, or a person read it.
 */
export class FirstVisibleTextReceipt {
  constructor({ document, report, now = Date.now, frame } = {}) {
    this.document = document;
    this.report = report;
    this.now = now;
    this.frame = frame ?? document?.defaultView?.requestAnimationFrame?.bind(document.defaultView);
    this.pending = new Map();
    this.rejected = new Set();
    this.onVisibilityChange = () => this.retry();
    this.onGeometryChange = () => this.retry();
    document?.addEventListener?.('visibilitychange', this.onVisibilityChange);
    document?.addEventListener?.('scroll', this.onGeometryChange, true);
    document?.defaultView?.addEventListener?.('resize', this.onGeometryChange);
  }

  setCall(callId) {
    callId ??= null;
    if (callId === this.callId) return;
    this.callId = callId;
    this.pending.clear();
    this.rejected.clear();
    this.reported = false;
    this.exhausted = false;
  }

  observe({ callId, reference, nodes } = {}) {
    const key = referenceKey(reference);
    if (!key || !callId || callId !== this.callId || this.reported || this.exhausted
      || this.rejected.has(key)
      || (!Array.isArray(nodes) && typeof nodes !== 'function')) return false;
    const existing = this.pending.get(key);
    const candidate = existing ?? { callId, reference, nodes, attempts: 0, retryAt: 0 };
    candidate.nodes = nodes;
    if (!existing && currentNodes(candidate).length === 0) return false;
    this.pending.set(key, candidate);
    while (this.pending.size > MAX_PENDING) this.pending.delete(this.pending.keys().next().value);
    this.retry();
    return true;
  }

  retry() {
    if (this.scheduled || this.inFlight || this.reported || this.exhausted || !this.callId || this.pending.size === 0
      || typeof this.frame !== 'function') return;
    this.scheduled = true;
    this.frame(() => {
      this.scheduled = false;
      void this.flush();
    });
  }

  async flush() {
    if (this.inFlight || this.reported || this.exhausted || !this.callId) return;
    const entry = [...this.pending].find(([, candidate]) => currentNodes(candidate).some(node =>
      nodeIsVisible(this.document, node)));
    if (!entry) return;
    const [key, candidate] = entry;
    if (candidate.retryAt > this.now()) return;
    const callId = this.callId;
    const attempt = { callId, key };
    this.inFlight = attempt;
    candidate.attempts += 1;
    let continueWithNext = false;
    try {
      const reply = await this.report({
        event: 'first_text_visible', observedAt: this.now(), callId, reference: candidate.reference,
      });
      if (reply?.kind === 'ok' && this.callId === callId && this.pending.get(key) === candidate) {
        this.reported = true;
        this.pending.clear();
      } else if (reply?.kind !== 'ok') {
        continueWithNext = this.rejectCandidate(callId, key, candidate, reply);
      }
    } catch (error) {
      continueWithNext = this.rejectCandidate(callId, key, candidate, error);
    } finally {
      if (this.inFlight === attempt) {
        this.inFlight = undefined;
        if (this.callId !== callId || continueWithNext) this.retry();
      }
    }
  }

  rejectCandidate(callId, key, candidate, failure) {
    if (this.callId !== callId || this.pending.get(key) !== candidate) return false;
    if (errorCode(failure) === 'invalid_request') {
      this.pending.delete(key);
      if (this.rejected.size >= MAX_PENDING) {
        this.exhausted = true;
        this.pending.clear();
        return false;
      }
      this.rejected.add(key);
      return true;
    }
    if (candidate.attempts >= MAX_REPORT_ATTEMPTS) {
      // The first visible candidate was plausible but the Host never confirmed it.
      // Preserve that result as unknown instead of reporting later text as the first.
      this.exhausted = true;
      this.pending.clear();
      return false;
    }
    candidate.retryAt = this.now() + REPORT_RETRY_DELAYS_MS[candidate.attempts - 1];
    return false;
  }

  close() {
    this.document?.removeEventListener?.('visibilitychange', this.onVisibilityChange);
    this.document?.removeEventListener?.('scroll', this.onGeometryChange, true);
    this.document?.defaultView?.removeEventListener?.('resize', this.onGeometryChange);
    this.pending.clear();
    this.rejected.clear();
  }
}

/** Owns the official companion's four subtitle projections and their receipt nodes. */
export class VisibleTextPresentation {
  constructor({ document, report, transcript, callTranscript, bubble, callBubble }) {
    this.receipt = new FirstVisibleTextReceipt({ document, report });
    Object.assign(this, { transcript, callTranscript, bubble, callBubble });
  }

  setCall(callId) {
    this.callTranscript.setCall(callId);
    this.receipt.setCall(callId);
  }

  appendLive(event, speaker) {
    const reference = event.itemId
      ? { kind: 'native-item', nativeItemId: event.itemId }
      : undefined;
    const stableNodes = [
      this.transcript.append(event.role, event.text, true),
      this.callTranscript.appendLive(event),
    ];
    this.bubble.append(event.role, event.text, speaker, reference);
    this.callBubble.append(event.role, event.text, speaker, reference);
    if (event.role === 'assistant' && reference && typeof event.text === 'string'
      && event.text.trim().length > 0) this.receipt.observe({
      callId: event.callId,
      reference,
      nodes: () => [
        ...stableNodes,
        ...this.bubble.rowsForReference(reference),
        ...this.callBubble.rowsForReference(reference),
      ],
    });
  }

  loadTranscript(callId, reply, companionName) {
    if (!this.callTranscript.load(reply)) return false;
    this.callBubble.loadTranscript(reply.rows, companionName);
    for (const row of reply.rows) {
      if (row.role !== 'assistant' || row.text.trim().length === 0) continue;
      const reference = { kind: 'message', messageId: row.messageId };
      const transcriptRow = this.callTranscript.rowForMessage(row.messageId);
      this.receipt.observe({
        callId,
        reference,
        nodes: () => [transcriptRow, ...this.callBubble.rowsForReference(reference)],
      });
    }
    this.receipt.retry();
    return true;
  }

  retry() { this.receipt.retry(); }
  close() { this.receipt.close(); }
}
