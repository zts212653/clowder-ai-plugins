// F317 living Xianxian package v3. Values are CSS anchors from its reviewed manifest.
const scale = 120 / 290;
const groundY = 10 + 262.5 * scale;
const clips = {
  'running-left': { name: 'trot', size: [265, 236], ground: 234.8, centre: 132.5, loop: true },
  'running-right': { name: 'trot', size: [265, 236], ground: 234.8, centre: 132.5, loop: true },
  running: { name: 'trot', size: [265, 236], ground: 234.8, centre: 132.5, loop: true },
  play: { name: 'pounce', size: [304.8, 312.6], ground: 303.9, centre: 201.9, rate: 1.5 },
  sleeping: { name: 'sleep', size: [271.2, 168], ground: 161, centre: 133.2, loop: true },
  waking: { name: 'wake', size: [400.2, 282.7], ground: 244.2, centre: 200.5,
    endGround: 277.4, endCentre: 197.7, durationMs: 7_250, crossfadeMs: 250 },
  peek: { name: 'peek', size: [153.5, 234.3], ground: 234.3, centre: 76.75, loop: true },
  delivering: { name: 'carry', size: [344.3, 290.9], ground: 263, centre: 198.3 },
  review: { name: 'carry', size: [344.3, 290.9], ground: 263, centre: 198.3 },
  pending_decision: { name: 'wait', size: [197.9, 252.8], ground: 249.6, centre: 98.4, loop: true },
  working: { name: 'think', size: [266.4, 256.9], ground: 253.7, centre: 132.1, loop: true },
  fetching: { name: 'think', size: [266.4, 256.9], ground: 253.7, centre: 132.1, loop: true },
  studying: { name: 'think', size: [266.4, 256.9], ground: 253.7, centre: 132.1, loop: true },
  staged_thought: { name: 'think', size: [266.4, 256.9], ground: 253.7, centre: 132.1, loop: true },
};
export const isLivingClip = action => Object.hasOwn(clips, action);
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
    const base = clips[action];
    const clip = !reducedMotion && base
      ? { ...base, name: action === 'peek' && dockZone !== 'corner' ? 'peek_fade' : base.name }
      : null;
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
    video.style.width = `${clip.size[0] * scale}px`;
    video.style.height = `${clip.size[1] * scale}px`;
    const left = this.action === 'peek'
      ? (this.root.dataset.dockEdge === 'left' ? -32 : 128 - clip.size[0] * scale)
      : 60 - clip.centre * scale;
    const top = this.action === 'peek' ? 138 - clip.size[1] * scale : groundY - clip.ground * scale;
    video.style.left = `${left}px`;
    video.style.top = `${top}px`;
    video.style.animation = clip.endGround
      ? `living-wake-anchor ${clip.durationMs}ms linear forwards` : 'none';
    if (clip.endGround) {
      video.style.setProperty?.('--living-left-start', `${left}px`);
      video.style.setProperty?.('--living-top-start', `${top}px`);
      video.style.setProperty?.('--living-left-end', `${60 - clip.endCentre * scale}px`);
      video.style.setProperty?.('--living-top-end', `${groundY - clip.endGround * scale}px`);
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
