/** Observe the Host window's current screen; never select or move a display. */
export function detectDockedEdge(win, petRect) {
  const left = win.screen?.availLeft;
  const width = win.screen?.availWidth;
  if (![win.screenX, left, width, petRect.left, petRect.width].every(Number.isFinite) || width <= 0) return null;
  const petLeft = win.screenX + petRect.left;
  const edge = petLeft - left <= 40 ? 'left'
    : left + width - petLeft - petRect.width <= 40 ? 'right' : null;
  if (!edge) return null;
  const top = win.screen?.availTop;
  const height = win.screen?.availHeight;
  const vertical = [win.screenY, top, height, petRect.top, petRect.height];
  const atBottom = vertical.every(Number.isFinite) && height > 0
    && top + height - (win.screenY + petRect.top + petRect.height) <= 40;
  return { edge, zone: atBottom ? 'corner' : 'mid' };
}
