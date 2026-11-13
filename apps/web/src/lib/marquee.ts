export interface Point { x: number; y: number }
export interface Box { left: number; top: number; width: number; height: number }

export const MARQUEE_THRESHOLD = 6;
export const MARQUEE_EDGE = 48;
export const MARQUEE_SCROLL_STEP = 18;

export const boxBetween = (from: Point, to: Point): Box => ({
  left: Math.min(from.x, to.x), top: Math.min(from.y, to.y), width: Math.abs(from.x - to.x), height: Math.abs(from.y - to.y),
});

export const shiftBox = (box: Box, dx: number, dy: number): Box => ({ ...box, left: box.left + dx, top: box.top + dy });

export const movedEnough = (from: Point, to: Point) => Math.hypot(from.x - to.x, from.y - to.y) >= MARQUEE_THRESHOLD;

export const touches = (box: Box, other: Box) =>
  box.left <= other.left + other.width && other.left <= box.left + box.width && box.top <= other.top + other.height && other.top <= box.top + box.height;

export const mergeSelection = (base: readonly string[], hit: readonly string[]) => [...base, ...hit.filter((id) => !base.includes(id))];

export function edgeScroll(pointerY: number, viewportHeight: number): number {
  if (pointerY < MARQUEE_EDGE) return -MARQUEE_SCROLL_STEP;
  if (pointerY > viewportHeight - MARQUEE_EDGE) return MARQUEE_SCROLL_STEP;
  return 0;
}
