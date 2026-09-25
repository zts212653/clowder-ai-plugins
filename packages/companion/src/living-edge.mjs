/** Observe the Host window's current screen; never select or move a display. */
export function detectDockedEdge(win, petRect) {
  const left = win.screen?.availLeft;
  const width = win.screen?.availWidth;
  if (![win.screenX, left, width, petRect.left, petRect.width].every(Number.isFinite) || width <= 0) return null;
  const petLeft = win.screenX + petRect.left;
  if (petLeft - left <= 40) return 'left';
  if (left + width - petLeft - petRect.width <= 40) return 'right';
  return null;
}
