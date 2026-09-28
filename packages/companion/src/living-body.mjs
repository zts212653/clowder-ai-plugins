import { isLivingClip, livingClipFor, placeLivingClip } from './living-geometry.mjs';
export { isLivingClip } from './living-geometry.mjs';
const setHidden = (node, hidden) => {
  if (!node) return;
  node.toggleAttribute?.('hidden', hidden);
  node.hidden = hidden;
};

/** One visible body: a layered sit or one muted clip, with a bounded sleep/wake hand-off. */
export class LivingBody {
  constructor({ root, sit, video, transitionVideo, setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout }) {
    this.root = root;
    this.sit = sit;
    this.video = video;
    this.standby = transitionVideo;
    this.setTimer = (callback, delay) => setTimer.call(globalThis, callback, delay);
    this.clearTimer = id => clearTimer.call(globalThis, id);
    this.action = '';
    this.revision = 0;
  }

  show(action, { reducedMotion = false, onEnded = () => {} } = {}) {
    const dockEdge = this.root.dataset.dockEdge;
    const dockZone = this.root.dataset.dockZone;
    if (this.action === action && this.reducedMotion === reducedMotion && this.dockEdge === dockEdge && this.dockZone === dockZone) return;
    const previous = this.action;
    this.action = action;
    this.reducedMotion = reducedMotion;
    this.dockEdge = dockEdge;
    this.dockZone = dockZone;
    const revision = ++this.revision;
    this.cancelFade();
    this.root.dataset.pose = this.pose(action);
    this.root.dataset.direction = action === 'running-left' || (action === 'peek' && dockEdge === 'left') ? 'left' : 'right';
    const clip = !reducedMotion ? livingClipFor(action, dockZone) : null;
    if (!clip) {
      this.hideVideos();
      setHidden(this.sit, false);
      return;
    }
    const crossfade = previous === 'sleeping' && action === 'waking' && this.standby;
    if (crossfade) this.crossfade(clip, revision, onEnded);
    else this.showClip(this.video, clip, revision, onEnded);
  }

  pose(action) {
    if (action === 'failed') return 'scared';
    if (action === 'waiting') return 'listening';
    if (['sleeping', 'pending_decision', 'held', 'working', 'fetching', 'studying'].includes(action))
      return action === 'pending_decision' ? 'pending' : action;
    return 'sit';
  }

  showClip(video, clip, revision, onEnded) {
    this.retireVideo(this.standby);
    this.configure(video, clip, revision, onEnded);
    video.style.opacity = '1';
    setHidden(this.sit, true);
    setHidden(video, false);
    this.play(video, revision, onEnded);
  }

  crossfade(clip, revision, onEnded) {
    const outgoing = this.video;
    const incoming = this.standby;
    this.configure(incoming, clip, revision, onEnded);
    incoming.style.transition = `opacity ${clip.crossfadeMs}ms linear`;
    outgoing.style.transition = `opacity ${clip.crossfadeMs}ms linear`;
    incoming.style.opacity = '0';
    outgoing.style.opacity = '1';
    setHidden(this.sit, true);
    setHidden(outgoing, false);
    setHidden(incoming, false);
    this.play(incoming, revision, onEnded);
    incoming.style.opacity = '1';
    outgoing.style.opacity = '0';
    this.video = incoming;
    this.standby = outgoing;
    this.fadeTimer = this.setTimer(() => {
      this.fadeTimer = undefined;
      if (revision !== this.revision) return;
      this.retireVideo(outgoing);
    }, clip.crossfadeMs);
  }

  configure(video, clip, revision, onEnded) {
    video.onended = null;
    video.pause();
    video.src = `./skins/xianxian-living/clips/${clip.name}.webm`;
    video.loop = clip.loop === true;
    video.playbackRate = clip.rate ?? 1;
    const placement = placeLivingClip(this.action, clip, this.root.dataset.dockEdge);
    video.style.width = `${placement.width}px`;
    video.style.height = `${placement.height}px`;
    video.style.left = `${placement.left}px`;
    video.style.top = `${placement.top}px`;
    video.style.animation = clip.endGround
      ? `living-wake-anchor ${clip.durationMs}ms linear forwards` : 'none';
    if (clip.endGround) {
      video.style.setProperty?.('--living-left-start', `${placement.left}px`);
      video.style.setProperty?.('--living-top-start', `${placement.top}px`);
      video.style.setProperty?.('--living-left-end', `${placement.endLeft}px`);
      video.style.setProperty?.('--living-top-end', `${placement.endTop}px`);
    }
    try { video.currentTime = 0; } catch { /* New source is not yet seekable. */ }
    video.onended = () => { if (revision === this.revision) onEnded(); };
  }

  play(video, revision, onEnded) {
    void video.play().catch(() => {
      if (revision !== this.revision) return;
      this.hideVideos();
      setHidden(this.sit, false);
      onEnded();
    });
  }

  hideVideos() {
    for (const video of [this.video, this.standby]) {
      this.retireVideo(video);
    }
  }

  retireVideo(video) {
    if (!video) return;
    video.onended = null;
    video.pause();
    setHidden(video, true);
  }

  cancelFade() {
    if (this.fadeTimer !== undefined) this.clearTimer(this.fadeTimer);
    this.fadeTimer = undefined;
  }

  close() {
    this.revision++;
    this.cancelFade();
    this.hideVideos();
  }

  hide() {
    this.close();
    setHidden(this.sit, true);
    this.action = '';
  }
}
