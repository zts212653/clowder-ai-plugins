import { isLivingClip } from './living-body.mjs';
import { MotionFacts } from './motion-facts.mjs';

// F229 pet.json frame durations, plus the three F258 rows pinned in source-lock.json.
const atlas = {
  idle: { row: 0, frames: [1200, 400, 400, 500, 500, 800] },
  'running-right': { row: 1, frames: [120, 120, 120, 120, 120, 120, 120, 220] },
  'running-left': { row: 2, frames: [120, 120, 120, 120, 120, 120, 120, 220] },
  waving: { row: 3, frames: [140, 140, 140, 280] },
  jumping: { row: 4, frames: [140, 140, 140, 140, 280] },
  failed: { row: 5, frames: [140, 140, 140, 140, 140, 140, 140, 240] },
  waiting: { row: 6, frames: [150, 150, 150, 150, 150, 260] },
  running: { row: 7, frames: [120, 120, 120, 120, 120, 220] },
  review: { row: 8, frames: [150, 150, 150, 150, 150, 280] },
};
const additional = {
  sleeping: { file: 'xianxian-sleeping-row.png', frames: [700, 700, 700, 700, 700, 700] },
  working: { file: 'xianxian-working-row.png', frames: [520, 560, 520, 640, 520, 560, 520, 640] },
  staged_thought: { file: 'xianxian-staged-thought-row.png', frames: [1200, 500, 700, 900, 1200, 500] },
};
const visualAlias = { fetching: 'working', studying: 'staged_thought', delivering: 'review', held: 'idle' };
const workAction = { reasoning: 'staged_thought', tool: 'working', workspace: 'fetching', screen_reading: 'studying' };
const signals = { connected: 'waving', received: 'jumping', failed: 'failed' };
const staticSkins = { 'ragdoll-v1': 'ragdoll-v1.png', 'yarn-ball': 'yarn-ball.png' };
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 256;

/** Select one truthful body from Host facts and local, user-controlled gestures. */
export class PetMotion {
  constructor(element, options = {}) {
    this.element = element;
    const setTimer = options.setTimer ?? globalThis.setTimeout;
    const clearTimer = options.clearTimer ?? globalThis.clearTimeout;
    this.setTimer = (callback, delay) => setTimer.call(globalThis, callback, delay);
    this.clearTimer = id => clearTimer.call(globalThis, id);
    this.now = options.now ?? Date.now;
    this.livingBody = options.livingBody;
    this.reducedMotion = options.reducedMotion ?? globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    this.autoPlay = options.autoPlay === true;
    this.autoPlayIdleMs = Math.max(90_000, options.autoPlayIdleMs ?? 90_000);
    this.autoPlayCooldownMs = Math.max(180_000, options.autoPlayCooldownMs ?? 180_000);
    this.lastPlayAt = Number.NEGATIVE_INFINITY;
    this.skin = 'xianxian-codex';
    this.phase = 'idle';
    this.base = 'idle';
    this.action = '';
    this.frame = 0;
    this.dragging = false;
    this.oneShot = false;
    this.pendingDecision = false;
    this.dockedEdge = null;
    this.dockZone = null;
    this.resting = false;
    this.transient = null;
    this.facts = new MotionFacts({ now: this.now, setTimer: this.setTimer, clearTimer: this.clearTimer,
      changed: () => this.refresh() });
    this.seenEvents = new Map();
  }

  setContext({ skin, phase, nativeActivity, muted }) {
    const selectedSkin = ['xianxian-codex', 'yanyan-codex', ...Object.keys(staticSkins)].includes(skin)
      ? skin : 'xianxian-codex';
    const wasSleeping = this.action === 'sleeping' || this.resting;
    this.context = { skin: selectedSkin, phase, nativeActivity, muted };
    const changedSkin = selectedSkin !== this.skin;
    this.skin = selectedSkin;
    this.phase = phase;
    if (phase !== 'idle' || nativeActivity !== 'none') {
      this.resting = false;
      this.cancelIdleTimers();
    }
    if (nativeActivity !== 'none' && this.transient?.action !== 'failed') this.transient = null;
    else if (wasSleeping && ['talking', 'connecting'].includes(phase) && !muted)
      this.transient = { action: 'waking' };
    this.refresh(changedSkin);
  }

  syncSnapshot(value) {
    const now = this.now();
    this.hasNativeWork = value !== null && value !== undefined;
    for (const [id, expiresAt] of this.seenEvents) if (expiresAt <= now) this.seenEvents.delete(id);
    this.facts.sync(value, this.dragging);
    if (this.snapshot.work) {
      this.resting = false;
      this.cancelIdleTimers();
      if (this.transient?.action !== 'failed') this.transient = null;
    } else if (this.resting && (this.snapshot.delivery || this.snapshot.travel)) {
      this.resting = false;
      this.cancelRest();
      this.transient = { action: 'waking' };
    }
    this.refresh();
  }

  setPendingDecision(value) {
    const pending = value === true;
    if (this.pendingDecision === pending) return;
    this.pendingDecision = pending;
    if (pending) {
      this.resting = false;
      this.transient = null;
      this.cancelIdleTimers();
    }
    this.refresh();
  }

  setDockedEdge(value) {
    const candidate = typeof value === 'string' ? { edge: value, zone: 'corner' } : value;
    const edge = ['left', 'right'].includes(candidate?.edge) ? candidate.edge : null;
    const zone = edge && ['corner', 'mid'].includes(candidate?.zone) ? candidate.zone : edge ? 'corner' : null;
    if (this.dockedEdge === edge && this.dockZone === zone) return;
    this.dockedEdge = edge;
    this.dockZone = zone;
    if (edge) this.cancelIdleTimers();
    this.refresh(this.action === 'peek');
  }

  signal(kind, eventId) {
    if (kind === 'answered') return;
    if (kind === 'connected' && this.living()) return;
    if (kind === 'play') {
      if (!this.canPlay()) return;
      this.lastPlayAt = this.now();
      this.resting = false;
      this.cancelIdleTimers();
      this.transient = { action: 'play' };
      this.refresh();
      return;
    }
    let requested = signals[kind];
    if (kind === 'received' && (this.action === 'sleeping' || this.resting)) requested = 'waking';
    if (!requested || this.dragging || staticSkins[this.skin]) return;
    const now = this.now();
    if (validId(eventId)) {
      if (this.seenEvents.has(eventId)) return;
      this.seenEvents.set(eventId, now + 3_600_000);
    }
    this.resting = false;
    this.cancelIdleTimers();
    this.transient = { action: requested };
    this.refresh();
  }

  move(dx, dy) {
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.hypot(dx, dy) < 6) return;
    if (this.dragging) return;
    this.dragging = true;
    this.element.classList?.add('dragging');
    this.element.dataset.interaction = 'held-candidate';
    this.facts.suppressTravel();
    this.resting = false;
    this.transient = null;
    this.cancelIdleTimers();
    this.refresh();
  }

  stopMove() {
    if (!this.dragging) return;
    this.dragging = false;
    this.element.classList?.remove('dragging');
    delete this.element.dataset.interaction;
    this.refresh();
  }

  close() {
    this.cancelFrame();
    this.cancelIdleTimers();
    this.facts.close();
    this.livingBody?.close();
  }
  living() { return this.skin === 'xianxian-codex' && Boolean(this.livingBody); }
  resolve(action) {
    if (action === 'pending_decision' && !this.living()) return 'waiting';
    if (action === 'peek' && !this.living()) return 'idle';
    if (staticSkins[this.skin]) return 'idle';
    const visual = visualAlias[action] ?? action;
    if (this.skin !== 'xianxian-codex' && visual in additional)
      return visual === 'sleeping' ? 'idle' : 'review';
    return action;
  }

  refresh(force = false) {
    const selection = this.select();
    this.base = this.baseAction();
    const action = this.resolve(selection.action);
    const changed = action !== this.action;
    if (changed || force || selection.oneShot !== this.oneShot) {
      this.oneShot = selection.oneShot;
      this.play(action, force);
    }
    if (action === 'idle') this.armRest();
    else if (action !== 'sleeping') this.cancelRest();
  }

  select() {
    if (this.dragging) return { action: 'held', oneShot: false };
    if (this.transient?.action === 'failed') return { action: 'failed', oneShot: true };
    if (this.pendingDecision) return { action: 'pending_decision', oneShot: false };
    const work = this.activeWorkAction();
    if (work) return { action: work, oneShot: false };
    if (this.transient && this.transient.action !== 'play')
      return { action: this.transient.action, oneShot: true };
    const delivery = this.facts.consumeDelivery();
    if (delivery) {
      this.transient = { action: 'delivering', resultId: delivery.resultId };
      return { action: 'delivering', oneShot: true };
    }
    if (!this.reducedMotion && this.snapshot.travel) {
      const { dx, dy } = this.snapshot.travel;
      return { action: Math.abs(dx) >= Math.abs(dy) ? dx < 0 ? 'running-left' : 'running-right' : 'running', oneShot: false };
    }
    if (['talking', 'connecting'].includes(this.phase) && !this.context?.muted)
      return { action: 'waiting', oneShot: false };
    if (this.transient?.action === 'play') return { action: 'play', oneShot: true };
    if (this.dockedEdge) return { action: 'peek', oneShot: false };
    if (this.resting) return { action: 'sleeping', oneShot: false };
    return { action: 'idle', oneShot: false };
  }

  baseAction() {
    if (this.pendingDecision) return 'pending_decision';
    const work = this.activeWorkAction();
    if (work) return work;
    if (['talking', 'connecting'].includes(this.phase) && !this.context?.muted) return 'waiting';
    if (this.dockedEdge) return 'peek';
    return 'idle';
  }

  activeWorkAction() {
    if (this.snapshot.work) return workAction[this.snapshot.work.kind];
    if (!this.hasNativeWork && this.context?.nativeActivity === 'tool_running') return 'working';
    if (!this.hasNativeWork && this.context?.nativeActivity === 'reasoning') return 'staged_thought';
    return null;
  }

  play(action, force = false) {
    if (this.action === action && !force) return;
    this.cancelFrame();
    this.action = action;
    this.frame = 0;
    this.paint();
    this.scheduleFrame();
  }

  paint() {
    const { style, dataset } = this.element;
    dataset.skin = this.skin;
    dataset.action = this.action;
    dataset.dockEdge = this.dockedEdge ?? 'none';
    dataset.dockZone = this.dockZone ?? 'none';
    if (this.living()) {
      style.backgroundImage = 'none';
      this.livingBody.show(this.action, { reducedMotion: this.reducedMotion, onEnded: () => this.completeOneShot() });
      return;
    }
    this.livingBody?.hide();
    const staticFile = staticSkins[this.skin];
    if (staticFile) {
      style.backgroundImage = `url("./skins/${staticFile}")`;
      style.backgroundSize = 'contain';
      style.backgroundPosition = 'center';
      return;
    }
    const visual = visualAlias[this.action] ?? this.action;
    const extra = this.skin === 'xianxian-codex' ? additional[visual] : undefined;
    style.backgroundImage = `url("./skins/${extra?.file ?? `${this.skin}.webp`}")`;
    style.backgroundSize = extra ? '960px 130px' : '960px 1170px';
    style.backgroundPosition = `${-120 * this.frame}px ${-130 * (atlas[visual]?.row ?? 0)}px`;
  }

  scheduleFrame() {
    if (this.reducedMotion) {
      if (this.oneShot) this.frameTimer = this.setTimer(() => { this.frameTimer = undefined; this.completeOneShot(); }, 1_000);
      return;
    }
    if (staticSkins[this.skin]) return;
    if (this.living()) {
      if (isLivingClip(this.action) || !this.oneShot) return;
      this.frameTimer = this.setTimer(() => { this.frameTimer = undefined; this.completeOneShot(); }, 700);
      return;
    }
    const visual = visualAlias[this.action] ?? this.action;
    const frames = additional[visual]?.frames ?? atlas[visual]?.frames;
    if (!frames) return;
    this.frameTimer = this.setTimer(() => {
      this.frameTimer = undefined;
      if (this.frame + 1 === frames.length && this.oneShot) {
        this.completeOneShot();
        return;
      }
      this.frame = (this.frame + 1) % frames.length;
      this.paint();
      this.scheduleFrame();
    }, frames[this.frame]);
  }

  cancelFrame() {
    if (this.frameTimer !== undefined) this.clearTimer(this.frameTimer);
    this.frameTimer = undefined;
  }

  completeOneShot() {
    if (!this.oneShot) return;
    this.oneShot = false;
    this.transient = null;
    this.action = '';
    this.refresh();
  }

  canPlay() {
    return !this.reducedMotion && !this.dragging && !this.pendingDecision && this.phase === 'idle'
      && !this.activeWorkAction() && !this.snapshot.delivery && !this.snapshot.travel && !this.dockedEdge
      && !staticSkins[this.skin];
  }

  armRest() {
    if (this.restTimer === undefined && !this.resting && !this.pendingDecision && !this.dockedEdge) {
      this.restTimer = this.setTimer(() => {
        this.restTimer = undefined;
        if (this.action === 'idle' && !this.dragging && !this.transient) {
          this.resting = true;
          this.refresh();
        }
      }, 45_000);
    }
    if (this.autoPlay && !this.reducedMotion && this.autoTimer === undefined) {
      const delay = Math.max(this.autoPlayIdleMs, this.lastPlayAt + this.autoPlayCooldownMs - this.now());
      this.autoTimer = this.setTimer(() => {
        this.autoTimer = undefined;
        if (!this.canPlay()) return;
        this.lastPlayAt = this.now();
        this.resting = false;
        this.transient = { action: 'play' };
        this.refresh();
      }, delay);
    }
  }

  cancelRest() {
    if (this.restTimer !== undefined) this.clearTimer(this.restTimer);
    this.restTimer = undefined;
  }

  cancelIdleTimers() {
    this.cancelRest();
    if (this.autoTimer !== undefined) this.clearTimer(this.autoTimer);
    this.autoTimer = undefined;
  }

  get snapshot() { return this.facts.snapshot; }
}
