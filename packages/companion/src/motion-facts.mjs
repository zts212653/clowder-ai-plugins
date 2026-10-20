const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const validExpiry = (value, now) => Number.isFinite(value) && value > now;
const workKinds = new Set(['reasoning', 'tool', 'workspace', 'screen_reading']);
const normalizeTravel = (travel, now, suppressed) => travel && validId(travel.eventId)
  && travel.status === 'active' && Number.isFinite(travel.dx) && Number.isFinite(travel.dy)
  && Math.hypot(travel.dx, travel.dy) >= 1 && validExpiry(travel.expiresAt, now)
  && !suppressed.has(travel.eventId)
  ? { eventId: travel.eventId, dx: travel.dx, dy: travel.dy, expiresAt: travel.expiresAt } : null;

/** A bounded, expiring projection of Host-owned motion facts. */
export class MotionFacts {
  constructor({ now, setTimer, clearTimer, changed }) {
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.changed = changed;
    this.snapshot = { work: null, delivery: null, travel: null };
    this.seenResults = new Map();
    this.suppressedTravel = new Map();
  }

  sync(value, suppressTravel = false) {
    const now = this.now();
    this.prune(now);
    const input = value && typeof value === 'object' ? value : {};
    const work = input.work;
    const delivery = input.delivery;
    const travel = input.travel;
    this.snapshot = {
      work: work && validId(work.taskId) && work.status === 'active' && workKinds.has(work.kind)
        && validExpiry(work.expiresAt, now)
        ? { taskId: work.taskId, kind: work.kind, expiresAt: work.expiresAt } : null,
      delivery: delivery && validId(delivery.resultId) && delivery.status === 'applied'
        && validExpiry(delivery.expiresAt, now)
        ? { resultId: delivery.resultId, expiresAt: delivery.expiresAt } : null,
      travel: normalizeTravel(travel, now, this.suppressedTravel),
    };
    if (suppressTravel) this.suppressTravel();
    this.scheduleExpiry();
  }

  syncNative(value) {
    const now = this.now();
    this.prune(now);
    const input = value && typeof value === 'object' ? value : {};
    const work = input.work;
    const delivery = input.delivery;
    const travel = this.snapshot.travel?.expiresAt > now ? this.snapshot.travel : null;
    this.snapshot = {
      work: work && validId(work.taskId) && work.status === 'active' && workKinds.has(work.kind)
        && validExpiry(work.expiresAt, now)
        ? { taskId: work.taskId, kind: work.kind, expiresAt: work.expiresAt } : null,
      delivery: delivery && validId(delivery.resultId) && delivery.status === 'applied'
        && validExpiry(delivery.expiresAt, now)
        ? { resultId: delivery.resultId, expiresAt: delivery.expiresAt } : null,
      travel,
    };
    this.scheduleExpiry();
  }

  syncTravel(value, suppressTravel = false) {
    const now = this.now();
    this.prune(now);
    this.snapshot.travel = normalizeTravel(value, now, this.suppressedTravel);
    if (suppressTravel) this.suppressTravel();
    this.scheduleExpiry();
  }

  consumeDelivery() {
    const delivery = this.snapshot.delivery;
    if (!delivery || this.seenResults.has(delivery.resultId)) return null;
    this.seenResults.set(delivery.resultId, this.now() + 3_600_000);
    return delivery;
  }

  suppressTravel() {
    if (!this.snapshot.travel) return;
    this.suppressedTravel.set(this.snapshot.travel.eventId, this.now() + 3_600_000);
    this.snapshot.travel = null;
    this.scheduleExpiry();
  }

  close() {
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
  }

  scheduleExpiry() {
    this.close();
    const expiries = Object.values(this.snapshot).filter(Boolean).map(value => value.expiresAt);
    if (!expiries.length) return;
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      const now = this.now();
      for (const key of ['work', 'delivery', 'travel']) {
        if (this.snapshot[key]?.expiresAt <= now) this.snapshot[key] = null;
      }
      this.scheduleExpiry();
      this.changed();
    }, Math.max(0, Math.min(...expiries) - this.now()));
  }

  prune(now) {
    for (const collection of [this.seenResults, this.suppressedTravel]) {
      for (const [id, expiresAt] of collection) if (expiresAt <= now) collection.delete(id);
    }
  }
}
