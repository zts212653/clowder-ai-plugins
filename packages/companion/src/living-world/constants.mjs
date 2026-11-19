// F336 Phase C: the fixed numbers of the card engine ("宪宪和纸团" v30, template-world.html), ported as they are.
// World units = canon px (a standing cat is ~348 tall); x = where his paws stand, h = height above the floor.
// The world data (world.json, built by build_world.py) holds every clip in canon coordinates, so nothing here depends on
// the atlas scale (the desktop body ships 0.6x atlases, the card 0.75x).
export const REFX = 236;
export const STAND_H = 348;
export const MAXLEAP = 170;
// ---- the wall and the ceiling. Wall/ceiling clips were made for the right wall (picture x right, y up); on the left
// wall the same clips are drawn mirrored. His anchor is WALLX from the wall line while he is on it; hanging, his paws
// are HANG_PAW above his anchor, so hanging means cat.y = HANGY (ceiling height minus that).
export const WALLX = 164;
export const HANG_PAW = 604;
export const REACH_FROM_WALL = 290;   // hanging from a wall, the nearest ball he can swat is ~290 from it
// ---- his draft paper (11-17 一个人在家): a sheet of his on the floor, its far end under his front paws (drawn behind
// him, so the paw that comes down is on it, and he walks over it). It stays where it is: he
// studies it only when he sits next to it, and his paw pulls it in on the frames where that paw is down on it
// (drag = the measured paw tip). It never comes closer than PAPER_NEAR (it stops against his front paws).
export const PW = 120;
export const PAPER_START = 100;
export const PAPER_NEAR = 64;
// petting from the pose he is in (Phase A AC-A2, 11-18): asleep, sitting sideways or facing you; let go and he is back in it
export const PETS = Object.freeze({ 'fs-idle': 'fs-pet', 'fs-look': 'fs-pet', nap: 'nap-pet', 'ss-idle': 'ss-pet' });
export const PETBACK = Object.freeze({ 'fs-pet': 'fs-idle', 'nap-pet': 'nap', 'ss-pet': 'ss-idle' });
// ---- 躲猫猫 (Landy 11-18: 「藏到某个物体后面 可可爱爱的探头探脑」): a big cardboard box stands by the left wall. Nobody is
// playing, so he sneaks over, wiggles and hops in, and sinks out of sight. Then his ears come up over the rim, then his
// eyes; he looks round at your hand and ducks again, and the next time he comes up at the other end of the box. A hand
// moving fast near the box sends him down; a press on his head = found: he ducks and springs out at you. Three looks and
// nobody came: he springs out by himself and goes for the ball. 碳碳 11-18 cold read of the first try (peeking in from
// the card's corner): a cat walking out small at the back and coming back big at the front had no object to explain it.
// Every pose is ~350 tall (tail, beret), so no box can hide him walking: he is behind the box's front wall only while he
// is IN it (cat.sink pushes him down inside; the front wall covers what is below the rim). Sizes measured on the frames:
// a pounce pose is 384 wide (the box is 430), a front sit 251 (room to come up at either end).
export const BOX = Object.freeze({ x: 300, w: 430, rim: 150, d: 34, back: 4 });   // canon px: rim above the box's bottom; the box stands just behind his line
export const RIM = BOX.rim + BOX.back;
export const SINK_HIDE = 232;
export const PK = Object.freeze({ ears: 108, eyes: 64, full: 22 });
export const LIFT = 140;
export const LIFT_ARC = Object.freeze({ 5: 0.45, 6: 0.95, 7: 1, 8: 0.7 });   // frame 6 clears the rim (pose bottom 25 + 133 > 156)
export const SAY = Object.freeze({
  'fs-to-st': '他看见纸团了', 'fs-to-st-L': '他看见纸团了', 'ss-to-fs-L': '他转过来看你', 'fs-to-ss-L': '他想找个地方趴一会儿',
  stalk: '他压低身子悄悄靠近', pounce: '扑！', 'ss-to-nap': '他困了，趴下来', 'nap-to-ss': '他醒啦，坐起来', 'nap-to-st': '他醒啦，伸个懒腰',
  'fs-to-ss': '他想找个地方趴一会儿', 'ss-to-fs': '他转过来看你', 'ssd-play': '他低头拨纸团玩', 'ssd-to-ss': '他抬起头', 'ssd-to-nap': '他困了，趴下来',
  'ss-to-ssd': '他有点累了', 'wall-up': '他一蹬扑上了墙', drop: '他松手跳下来', 'fs-draft': '他低头研究自己的草稿', 'fs-draft-L': '他低头研究自己的草稿',
  'ss-groom': '他舔舔爪子，洗洗脸', 'nap-to-loaf': '他醒了，抬起头', 'loaf-daydream': '他趴着发呆', 'loaf-to-ss': '他坐起来',
});

export const sum = (a, i0 = 0, i1) => (a || []).slice(i0, i1).reduce((p, value) => p + value, 0);
export const ease = (u, back) => {
  u = Math.min(1, Math.max(0, u));
  if (back === 'in') return u * u;
  if (!back) return 1 - (1 - u) * (1 - u);
  const c = 1.6;
  return 1 + (c + 1) * Math.pow(u - 1, 3) + c * Math.pow(u - 1, 2);
};

/** The numbers measured on the clips themselves (build_world), read once from the world data. */
export function deriveConstants(WD) {
  // pounce numbers are measured on the clip itself (build_world): landing frame, how far ahead of his anchor the paws land,
  // and which frames carry him through the air. The stalk is a real step cycle drawn walking across a fixed camera:
  // its dx is the movement measured in the picture, and GO is the step whose pose the pounce starts from.
  // The 4-pose stalk cycle covers more than MAXLEAP, so the pounce is weighed at two poses a cycle (GO, go2).
  const PC = WD.clips.pounce;
  const STK = WD.clips.stalk;
  const CHG = WD.clips['climb-hang'];
  const DRG = (WD.clips['fs-draft'] || {}).drag || [];
  const REACH = PC.reach;
  // the ring goes round by angle (not by frame number: frame 13 is up-right and frame 16 up-left were added later)
  const ring = [];
  for (let i = 0; i < WD.gaze.length; i++) if (WD.gaze[i] !== null) ring.push(i);
  ring.sort((a, b) => ((WD.gaze[a] + 360) % 360) - ((WD.gaze[b] + 360) % 360));
  return Object.freeze({
    PC, SP: WD.clips['ssd-play'], STK, GO: STK.go || 0,
    GROUND: WD.ground, REACH, LAND: PC.land, NEAR: REACH + 40, LEAPW: PC.leapw, PAWS: PC.paws || [],
    EYE: WD.eye, BR: WD.ballD / 2,
    WUP: WD.clips['wall-up'], CLB: WD.clips.climb, CHG, SHM: WD.clips.shimmy, SWT: WD.clips.swat, DRP: WD.clips.drop,
    // how far the climb-hang carries him up, counting its measured start after the climb (fromClimb replaces its first dy)
    CHG_RISE: sum(CHG.dy) - CHG.dy[0] + (CHG.fromClimb ? CHG.fromClimb[1] : CHG.dy[0]),
    DRG, DRG_MAX: Math.max(0, ...DRG.filter(value => value != null)), DRG_MIN: Math.min(1e9, ...DRG.filter(value => value != null)),
    PET: WD.clips['fs-pet'], HAT: WD.clips['fs-hat'],
    ring: Object.freeze(ring),
  });
}
