const validPosition = value => value && Number.isFinite(value.x) && Number.isFinite(value.y);

/** Observe the native window itself. Running animation follows measured desktop
 * movement; renderer state never invents a target or claims a move succeeded. */
export class NativeWindowTravel {
  constructor({
    readPosition,
    changed,
    now = Date.now,
    setTimer = globalThis.setTimeout,
    clearTimer = globalThis.clearTimeout,
    intervalMs = 80,
    expiresMs = 240,
  }) {
    this.readPosition = readPosition;
    this.changed = changed;
    this.now = now;
    this.setTimer = (callback, delay) => setTimer.call(globalThis, callback, delay);
    this.clearTimer = id => clearTimer.call(globalThis, id);
    this.intervalMs = Math.max(32, intervalMs);
    this.expiresMs = Math.max(this.intervalMs, expiresMs);
    this.sequence = 0;
    this.manual = false;
    this.closed = false;
    this.active = null;
  }

  start() {
    if (this.closed || this.timer !== undefined) return;
    this.previous = this.read();
    this.schedule();
  }

  setManual(value) {
    const manual = value === true;
    if (manual === this.manual) return;
    this.manual = manual;
    this.previous = this.read();
    if (manual) this.clearActive();
  }

  tick() {
    this.timer = undefined;
    if (this.closed) return;
    const next = this.read();
    const now = this.now();
    if (next && this.previous) {
      const dx = next.x - this.previous.x;
      const dy = next.y - this.previous.y;
      if (!this.manual && Math.hypot(dx, dy) >= 1) {
        const eventId = this.active?.eventId ?? `native-${Math.trunc(now)}-${++this.sequence}`;
        this.active = { eventId, status: 'active', dx, dy, expiresAt: now + this.expiresMs };
        this.changed({ ...this.active });
      } else if (this.active && this.active.expiresAt <= now) {
        this.clearActive();
      }
    }
    this.previous = next;
    this.schedule();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
    this.clearActive();
  }

  read() {
    try {
      const value = this.readPosition();
      return validPosition(value) ? { x: value.x, y: value.y } : null;
    } catch {
      return null;
    }
  }

  schedule() {
    if (this.closed || this.timer !== undefined) return;
    this.timer = this.setTimer(() => this.tick(), this.intervalMs);
  }

  clearActive() {
    if (!this.active) return;
    this.active = null;
    this.changed(null);
  }
}
