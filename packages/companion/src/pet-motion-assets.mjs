// F229 pet.json frame durations, plus the three F258 rows pinned in source-lock.json.
export const atlas = {
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
export const additional = {
  sleeping: { file: 'xianxian-sleeping-row.png', frames: [700, 700, 700, 700, 700, 700] },
  working: { file: 'xianxian-working-row.png', frames: [520, 560, 520, 640, 520, 560, 520, 640] },
  staged_thought: { file: 'xianxian-staged-thought-row.png', frames: [1200, 500, 700, 900, 1200, 500] },
};
export const visualAlias = { fetching: 'working', studying: 'staged_thought', delivering: 'review', held: 'idle' };
export const workAction = { reasoning: 'staged_thought', tool: 'working', workspace: 'fetching', screen_reading: 'studying' };
export const signals = { connected: 'waving', received: 'jumping', failed: 'failed' };
export const staticSkins = { 'ragdoll-v1': 'ragdoll-v1.png', 'yarn-ball': 'yarn-ball.png' };
export const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
