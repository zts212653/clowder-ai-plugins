import { isLivingClip } from './living-body.mjs';

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
const signals = { connected: 'waving', received: 'jumping', answered: 'review', failed: 'failed', play: 'play' };
const staticSkins = { 'ragdoll-v1': 'ragdoll-v1.png', 'yarn-ball': 'yarn-ball.png' };

/** All animation choices come from Host state or a completed local gesture. */
export class PetMotion {
  constructor(element, options = {}) {
    this.element = element;
    const setTimer = options.setTimer ?? globalThis.setTimeout;
    const clearTimer = options.clearTimer ?? globalThis.clearTimeout;
    this.setTimer = (callback, delay) => setTimer.call(globalThis, callback, delay);
    this.clearTimer = id => clearTimer.call(globalThis, id);
    this.livingBody = options.livingBody;
    this.reducedMotion = options.reducedMotion ?? globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    this.skin = 'xianxian-codex';
    this.phase = 'idle';
    this.base = 'idle';
    this.action = '';
    this.frame = 0;
    this.moving = false;
    this.oneShot = false;
    this.pendingDecision = false;
    this.dockedEdge = null;
  }
  setContext({ skin, phase, nativeActivity, muted }) {
    this.context = { skin, phase, nativeActivity, muted };
    const selectedSkin = ['xianxian-codex', 'yanyan-codex', ...Object.keys(staticSkins)].includes(skin) ? skin : 'xianxian-codex';
    const changedSkin = selectedSkin !== this.skin;
    const changedPhase = phase !== this.phase;
    this.skin = selectedSkin;
    this.phase = phase;
    const requested = this.pendingDecision ? 'pending_decision' : nativeActivity === 'tool_running' ? 'working' : nativeActivity === 'reasoning' ? 'staged_thought'
      : ['talking', 'connecting'].includes(phase) && !muted ? 'waiting' : this.dockedEdge ? 'peek' : 'idle';
    const nextBase = this.resolve(requested);
    const changedBase = nextBase !== this.base;
    this.base = nextBase;
    if (phase !== 'idle') this.cancelRest();
    if (phase === 'idle' && changedPhase) { this.moving = false; this.oneShot = false; }
    const waking = this.living() && !this.reducedMotion && this.action === 'sleeping' && this.base === 'waiting';
    if (waking) { this.oneShot = true; this.play('waking'); }
    else if (this.oneShot && this.action === 'waking' && ['working', 'staged_thought', 'pending_decision'].includes(this.base)) {
      this.oneShot = false;
      this.play(this.base);
    } else if (!this.moving && !this.oneShot && (changedSkin || changedBase || changedPhase || !this.action)) this.play(this.base, changedSkin);
    if (phase === 'idle' && this.action === 'idle') this.armRest();
  }
  setPendingDecision(value) {
    if (this.pendingDecision === value) return;
    this.pendingDecision = value;
    if (this.context) this.setContext(this.context);
    if (value === true && this.oneShot) {
      this.oneShot = false;
      this.play(this.base);
    }
  }
  setDockedEdge(value) {
    const edge = ['left', 'right'].includes(value) ? value : null;
    if (this.dockedEdge === edge) return;
    const previous = this.dockedEdge;
    this.dockedEdge = edge;
    if (this.context) this.setContext(this.context);
    if (previous && edge && this.action === 'peek') this.play('peek', true);
  }
  signal(kind) {
    const requested = kind === 'received' && this.living() && this.action === 'sleeping' ? 'waking' : signals[kind];
    if (kind === 'play' && (this.pendingDecision || this.phase !== 'idle' || this.context?.nativeActivity !== 'none')) return;
    if (!requested || this.moving || this.reducedMotion || staticSkins[this.skin]) return;
    this.cancelRest();
    this.oneShot = true;
    this.play(this.resolve(requested));
  }
  move(dx, dy) {
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.hypot(dx, dy) < 6) return;
    this.moving = true;
    this.oneShot = false;
    this.cancelRest();
    this.play(this.resolve(Math.abs(dx) >= Math.abs(dy) ? dx < 0 ? 'running-left' : 'running-right' : 'running'));
  }
  stopMove() {
    if (!this.moving) return;
    this.moving = false;
    this.play(this.base);
    if (this.phase === 'idle') this.armRest();
  }
  close() { this.cancelFrame(); this.cancelRest(); this.livingBody?.close(); }
  living() { return this.skin === 'xianxian-codex' && Boolean(this.livingBody); }
  resolve(action) {
    if (action === 'pending_decision' && !this.living()) return 'waiting';
    if (action === 'peek' && !this.living()) return 'idle';
    if (staticSkins[this.skin]) return 'idle';
    if (this.skin !== 'xianxian-codex' && action in additional)
      return action === 'sleeping' ? 'idle' : 'review';
    return action;
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
    const extra = this.skin === 'xianxian-codex' ? additional[this.action] : undefined;
    style.backgroundImage = `url("./skins/${extra?.file ?? `${this.skin}.webp`}")`;
    style.backgroundSize = extra ? '960px 130px' : '960px 1170px';
    style.backgroundPosition = `${-120 * this.frame}px ${-130 * (atlas[this.action]?.row ?? 0)}px`;
  }
  scheduleFrame() {
    if (this.reducedMotion || staticSkins[this.skin]) return;
    if (this.living()) {
      if (isLivingClip(this.action) || !this.oneShot) return;
      this.frameTimer = this.setTimer(() => { this.frameTimer = undefined; this.completeOneShot(); }, 700);
      return;
    }
    const frames = additional[this.action]?.frames ?? atlas[this.action]?.frames;
    if (!frames) return;
    this.frameTimer = this.setTimer(() => {
      this.frameTimer = undefined;
      if (this.frame + 1 === frames.length && this.oneShot) {
        this.oneShot = false;
        this.action = '';
        this.play(this.base);
        if (this.phase === 'idle') this.armRest();
        return;
      }
      this.frame = (this.frame + 1) % frames.length;
      this.paint();
      this.scheduleFrame();
    }, frames[this.frame]);
  }
  cancelFrame() { if (this.frameTimer !== undefined) this.clearTimer(this.frameTimer); this.frameTimer = undefined; }
  completeOneShot() {
    if (!this.oneShot) return;
    this.oneShot = false;
    this.action = '';
    this.play(this.base);
    if (this.phase === 'idle') this.armRest();
  }
  armRest() {
    if (this.restTimer !== undefined || this.action === 'sleeping' || this.pendingDecision || this.dockedEdge) return;
    this.restTimer = this.setTimer(() => {
      this.restTimer = undefined;
      if (this.phase === 'idle' && !this.moving && !this.oneShot) this.play(this.resolve('sleeping'));
    }, 45_000);
  }
  cancelRest() { if (this.restTimer !== undefined) this.clearTimer(this.restTimer); this.restTimer = undefined; }
}
