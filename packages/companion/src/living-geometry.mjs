// F317 living Xianxian package v3. All values are reviewed package CSS anchors;
// every clip uses one stage scale. content bounds are the union of decoded
// alpha pixels and exist to size the native transparent surface, not to apply
// per-action "looks right" scaling.
export const LIVING_GEOMETRY = Object.freeze({
  pet: Object.freeze({ width: 120, height: 130 }),
  stage: Object.freeze({ size: 290, centre: 145, ground: 262.5 }),
  surface: Object.freeze({ left: -32, top: -18, right: 143, bottom: 138 }),
  sitContent: Object.freeze({ left: 8.8, top: 3.4, right: 94.2, bottom: 109.2 }),
});

export const LIVING_SCALE = LIVING_GEOMETRY.pet.width / LIVING_GEOMETRY.stage.size;
export const LIVING_REFERENCE = Object.freeze({
  centre: LIVING_GEOMETRY.stage.centre * LIVING_SCALE,
  ground: LIVING_GEOMETRY.stage.ground * LIVING_SCALE,
});

const clip = (name, size, ground, centre, content, options = {}) => Object.freeze({
  name, size: Object.freeze(size), ground, centre, content: Object.freeze(content), ...options,
});

const library = Object.freeze({
  trot: clip('trot', [265, 236], 234.8, 132.5,
    { left: 1.5, top: 2, right: 263.5, bottom: 235.5 }, { loop: true }),
  pounce: clip('pounce', [304.8, 312.6], 303.9, 201.9,
    { left: 3, top: 0, right: 302, bottom: 312 }, { rate: 1.5 }),
  sleep: clip('sleep', [271.2, 168], 161, 133.2,
    { left: 2.5, top: 2.5, right: 268.5, bottom: 166.5 }, { loop: true }),
  wake: clip('wake', [400.2, 282.7], 244.2, 200.5,
    { left: 3, top: 3, right: 397, bottom: 280.5 },
    { endGround: 277.4, endCentre: 197.7, durationMs: 7_250, crossfadeMs: 250 }),
  peek: clip('peek', [153.5, 234.3], 234.3, 76.75,
    { left: 2.5, top: 2.5, right: 153, bottom: 234 }, { loop: true }),
  peek_fade: clip('peek_fade', [153.5, 234.3], 234.3, 76.75,
    { left: 2.5, top: 2.5, right: 153, bottom: 231.5 }, { loop: true }),
  carry: clip('carry', [344.3, 290.9], 263, 198.3,
    { left: 4, top: 4, right: 340, bottom: 288.5 }),
  wait: clip('wait', [197.9, 252.8], 249.6, 98.4,
    { left: 4, top: 4, right: 194, bottom: 251 }, { loop: true }),
  think: clip('think', [266.4, 256.9], 253.7, 132.1,
    { left: 3.5, top: 3.5, right: 262, bottom: 255 }, { loop: true }),
});

const actionClip = Object.freeze({
  'running-left': 'trot',
  'running-right': 'trot',
  running: 'trot',
  play: 'pounce',
  sleeping: 'sleep',
  waking: 'wake',
  peek: 'peek',
  delivering: 'carry',
  review: 'carry',
  pending_decision: 'wait',
  working: 'think',
  fetching: 'think',
  studying: 'think',
  staged_thought: 'think',
});

export const isLivingClip = action => Object.hasOwn(actionClip, action);

export function livingClipFor(action, dockZone) {
  const name = action === 'peek' && dockZone !== 'corner' ? 'peek_fade' : actionClip[action];
  return name ? library[name] : null;
}

export function placeLivingClip(action, selected, dockEdge) {
  const width = selected.size[0] * LIVING_SCALE;
  const height = selected.size[1] * LIVING_SCALE;
  const left = action === 'peek'
    ? (dockEdge === 'left' ? LIVING_GEOMETRY.surface.left : LIVING_GEOMETRY.surface.right - width)
    : LIVING_REFERENCE.centre - selected.centre * LIVING_SCALE;
  const top = action === 'peek'
    ? LIVING_GEOMETRY.surface.bottom - height
    : LIVING_REFERENCE.ground - selected.ground * LIVING_SCALE;
  return Object.freeze({
    left, top, width, height,
    endLeft: selected.endCentre === undefined
      ? undefined : LIVING_REFERENCE.centre - selected.endCentre * LIVING_SCALE,
    endTop: selected.endGround === undefined
      ? undefined : LIVING_REFERENCE.ground - selected.endGround * LIVING_SCALE,
  });
}

export function livingContentRect(selected, placement, endpoint = 'start') {
  const left = endpoint === 'end' ? placement.endLeft : placement.left;
  const top = endpoint === 'end' ? placement.endTop : placement.top;
  if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
  return Object.freeze({
    left: left + selected.content.left * LIVING_SCALE,
    top: top + selected.content.top * LIVING_SCALE,
    right: left + selected.content.right * LIVING_SCALE,
    bottom: top + selected.content.bottom * LIVING_SCALE,
  });
}
