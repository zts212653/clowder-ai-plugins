// F317 living Xianxian package v1. All clips share the layered sit's ground line.
// Values are the package-v1 CSS anchors scaled from its 290px stage to the Host pet.
const scale = 120 / 290;
const groundY = 10 + 262.5 * scale;
const clips = {
  'running-left': { name: 'trot', size: [265, 236], ground: 234.8, centre: 132.5, loop: true },
  'running-right': { name: 'trot', size: [265, 236], ground: 234.8, centre: 132.5, loop: true },
  running: { name: 'trot', size: [265, 236], ground: 234.8, centre: 132.5, loop: true },
  play: { name: 'pounce', size: [304.8, 312.6], ground: 303.9, centre: 201.9, rate: 1.5 },
  sleeping: { name: 'sleep', size: [468.5, 262.1], ground: 256.4, centre: 238.9, loop: true },
  waking: { name: 'wake', size: [468.5, 262.1], ground: 256.4, centre: 238.9 },
  peek: { name: 'peek', size: [153.5, 234.3], ground: 234.3, centre: 76.75, loop: true },
  review: { name: 'carry', size: [344.3, 290.9], ground: 263, centre: 198.3 },
  pending_decision: { name: 'wait', size: [197.9, 252.8], ground: 249.6, centre: 98.4, loop: true },
  working: { name: 'think', size: [266.4, 256.9], ground: 253.7, centre: 132.1, loop: true },
  staged_thought: { name: 'think', size: [266.4, 256.9], ground: 253.7, centre: 132.1, loop: true },
};
export const isLivingClip = action => Object.hasOwn(clips, action);
const setHidden = (node, hidden) => {
  // SVGElement.hidden is not consistently reflected to the HTML hidden
  // attribute; the renderer's [hidden] rule reads the attribute itself.
  node.toggleAttribute?.('hidden', hidden);
  node.hidden = hidden;
};

/** One visible body: a layered sit or one muted clip, never both. */
export class LivingBody {
  constructor({ root, sit, video }) {
    this.root = root;
    this.sit = sit;
    this.video = video;
    this.action = '';
    this.revision = 0;
  }
  show(action, { reducedMotion = false, onEnded = () => {} } = {}) {
    const dockEdge = this.root.dataset.dockEdge;
    if (this.action === action && this.reducedMotion === reducedMotion && this.dockEdge === dockEdge) return;
    this.action = action;
    this.reducedMotion = reducedMotion;
    this.dockEdge = dockEdge;
    const revision = ++this.revision;
    const clip = !reducedMotion && clips[action];
    this.root.dataset.pose = action === 'failed' ? 'scared' : action === 'waiting' ? 'listening' :
      action === 'sleeping' ? 'sleeping' : action === 'pending_decision' ? 'pending' : 'sit';
    this.root.dataset.direction = action === 'running-left' || (action === 'peek' && this.root.dataset.dockEdge === 'left') ? 'left' : 'right';
    this.video.onended = null;
    this.video.pause();
    if (!clip) {
      setHidden(this.video, true);
      setHidden(this.sit, false);
      return;
    }
    this.video.src = `./skins/xianxian-living/clips/${clip.name}.webm`;
    this.video.loop = clip.loop === true;
    this.video.playbackRate = clip.rate ?? 1;
    this.video.style.width = `${clip.size[0] * scale}px`;
    this.video.style.height = `${clip.size[1] * scale}px`;
    this.video.style.left = action === 'peek'
      ? `${this.root.dataset.dockEdge === 'left' ? -32 : 128 - clip.size[0] * scale}px`
      : `${60 - clip.centre * scale}px`;
    this.video.style.top = `${action === 'peek' ? 138 - clip.size[1] * scale : groundY - clip.ground * scale}px`;
    try { this.video.currentTime = 0; } catch { /* New source is not yet seekable. */ }
    this.video.onended = () => { if (revision === this.revision) onEnded(); };
    setHidden(this.sit, true);
    setHidden(this.video, false);
    void this.video.play().catch(() => {
      if (revision !== this.revision) return;
      setHidden(this.video, true);
      setHidden(this.sit, false);
      onEnded();
    });
  }
  close() {
    this.revision++;
    this.video.onended = null;
    this.video.pause();
  }
  hide() {
    this.close();
    setHidden(this.video, true);
    setHidden(this.sit, true);
    this.action = '';
  }
}
