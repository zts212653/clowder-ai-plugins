export const COMPACT_BALL_SIZE = 43;
export const DEFAULT_BALL_SIZE = 72;

export function compactSizeAction(ballSize) {
  return Number(ballSize) <= COMPACT_BALL_SIZE
    ? { label: '放大', value: DEFAULT_BALL_SIZE }
    : { label: '缩小', value: COMPACT_BALL_SIZE };
}
