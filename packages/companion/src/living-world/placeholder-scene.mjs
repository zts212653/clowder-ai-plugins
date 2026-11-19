// F336 Phase C: a stand-in scene for the living cat until the card engine is ported behind the same
// mount seam. It keeps the scene's semantic shape (schemaVersion 1) so the Host save loop is real:
// positions are fractions of the floor width, and nothing holds a process clock or offline time.
export const PLACEHOLDER_CAT = Object.freeze({ width: 120, height: 130, x: 0.8 });
const POSES = new Set(['FS', 'SS', 'LOAF', 'NAP']);
const FACINGS = new Set(['left', 'right']);
const ACTIVITIES = new Set(['draft', 'groom']);
const HEAD_SHARE = 0.4;

const fraction = (value, fallback) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

export function createPlaceholderScene() {
  let pose = { name: 'SS', facing: 'left' };
  let ball = { x: 0.35, h: 0, ceil: false };
  let paper = { x: 0.15 };
  let hat = { askew: false };
  let activity = { kind: null, frame: 0 };
  let lastSolo = null;

  return {
    snapshot() {
      return {
        schemaVersion: 1,
        pose: { ...pose }, ball: { ...ball }, paper: { ...paper }, hat: { ...hat }, activity: { ...activity }, lastSolo,
      };
    },
    /** Lays a saved scene over the defaults; anything unreadable keeps its default. */
    restore(snapshot) {
      if (!plain(snapshot) || snapshot.schemaVersion !== 1) return;
      const saved = snapshot;
      if (plain(saved.pose)) pose = {
        name: POSES.has(saved.pose.name) ? saved.pose.name : pose.name,
        facing: FACINGS.has(saved.pose.facing) ? saved.pose.facing : pose.facing,
      };
      if (plain(saved.ball)) ball = {
        x: fraction(saved.ball.x, ball.x), h: fraction(saved.ball.h, ball.h), ceil: saved.ball.ceil === true,
      };
      if (plain(saved.paper)) paper = { x: fraction(saved.paper.x, paper.x) };
      if (plain(saved.hat) && typeof saved.hat.askew === 'boolean') hat = { askew: saved.hat.askew };
      if (plain(saved.activity)) activity = {
        kind: ACTIVITIES.has(saved.activity.kind) ? saved.activity.kind : null,
        frame: Number.isInteger(saved.activity.frame) && saved.activity.frame >= 0 ? saved.activity.frame : 0,
      };
      if (typeof saved.lastSolo === 'string' || saved.lastSolo === null) lastSolo = saved.lastSolo;
    },
    get pose() { return { ...pose }; },
    get hat() { return { ...hat }; },
    get ball() { return { ...ball }; },
    /** Rubbing the top of his head knocks the hat askew, or back. */
    rubHat() { hat = { askew: !hat.askew }; },
    /** The cat's visible body in body-window CSS pixels: standing on the floor (bottom edge). */
    catRect(area) {
      const width = Math.min(PLACEHOLDER_CAT.width, area.width);
      const height = Math.min(PLACEHOLDER_CAT.height, area.height);
      const x = clamp(Math.round(PLACEHOLDER_CAT.x * area.width - width / 2), 0, area.width - width);
      return { x, y: area.height - height, width, height };
    },
    /** Which part of the cat is under a window point: head, body or nothing. */
    hitTest(area, point) {
      const rect = this.catRect(area);
      if (point.x < rect.x || point.x > rect.x + rect.width || point.y < rect.y || point.y > rect.y + rect.height) return null;
      return point.y <= rect.y + rect.height * HEAD_SHARE ? 'head' : 'body';
    },
  };
}
