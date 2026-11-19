// The living body's engine for unit tests: the real world data and engine, on a fake clock and seeded randomness, with
// every atlas present (nothing is drawn).
import { readFileSync } from 'node:fs';
import { createEngine } from '../src/living-world/engine.mjs';

export const WORLD = JSON.parse(readFileSync(new URL('../assets/skins/xianxian-living-world/world.json', import.meta.url), 'utf8'));
export const AREA = [1440, 860];

export function world({ at = 1000 } = {}) {
  let t = at;
  let seed = 11;
  const engine = createEngine({ data: WORLD, now: () => t, random: () => (seed = (seed * 16807) % 2147483647) / 2147483647 });
  engine.atlases = [true, true, true];
  engine.layout(...AREA);
  const run = (ms, each = () => {}) => { for (const end = t + ms; t < end;) { t += 16; engine.tick(t); each(); } };
  const ballAt = () => [engine.ball.x * engine.view.k, engine.view.floorY - engine.ball.h * engine.view.k];
  return { engine, run, ballAt, now: () => t, advance: ms => { t += ms; } };
}

/** A saved scene as the Host would hand it back. */
export function saved(overrides = {}) {
  return {
    schemaVersion: 1, pose: { hub: 'FS', facing: 'right', x: 0.5 }, ball: { x: 0.7, h: 0, ceil: false }, paper: { x: 0.3 },
    hat: { askew: false }, activity: { kind: null, frame: 0 }, lastSolo: null, ...overrides,
  };
}

/** Runs him for up to ms and returns the clips he went through, each with the frame it started at. */
export function clipsOver(w, ms) {
  const clips = [{ clip: w.engine.cat.clip, frame: w.engine.cat.i, askew: w.engine.hatAskew() }];
  w.run(ms, () => {
    if (clips.at(-1).clip !== w.engine.cat.clip) clips.push({ clip: w.engine.cat.clip, frame: w.engine.cat.i, askew: w.engine.hatAskew() });
  });
  return clips;
}

/** A throw as the hand leaves it: fast, up and away from him. */
export function throwBall(w, vx = -700) {
  Object.assign(w.engine.ball, { held: false, vx, vh: 500, fresh: true, relAt: w.now() });
}
