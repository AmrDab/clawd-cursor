import type { Bounds } from './ui-map-types';

/** Intersection-over-union of two [x,y,w,h] screen-space boxes. 0 when disjoint. */
export function iou(a: Bounds, b: Bounds): number {
  const [ax, ay, aw, ah] = a;
  const [bx, by, bw, bh] = b;
  const x1 = Math.max(ax, bx);
  const y1 = Math.max(ay, by);
  const x2 = Math.min(ax + aw, bx + bw);
  const y2 = Math.min(ay + ah, by + bh);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const uni = aw * ah + bw * bh - inter;
  return uni <= 0 ? 0 : inter / uni;
}
