import type { UIElement, Source, Role } from './ui-map-types';

const AGREEMENT_BONUS = 0.15;
const OVERLAP_MIN = 0.5;        // IoU threshold to treat two boxes as the same element
const ROLE_PRIORITY: Role[] = ['button', 'input', 'link', 'checkbox', 'tab',
  'listitem', 'list', 'image', 'text', 'unknown'];

function iou(a: UIElement['bounds'], b: UIElement['bounds']): number {
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

function betterRole(a: Role, b: Role): Role {
  return ROLE_PRIORITY.indexOf(a) <= ROLE_PRIORITY.indexOf(b) ? a : b;
}

/** Merge same-place + same-text elements across sources; raise confidence per
 *  corroborating source; keep the stronger role/capabilities. */
export function fuse(elements: UIElement[]): UIElement[] {
  const out: UIElement[] = [];
  for (const el of elements) {
    const match = out.find(o =>
      o.normalized_text === el.normalized_text &&
      o.normalized_text !== '' &&
      iou(o.bounds, el.bounds) >= OVERLAP_MIN);
    if (!match) { out.push({ ...el, sources: [...el.sources] }); continue; }
    const merged: Source[] = Array.from(new Set([...match.sources, ...el.sources]));
    match.sources = merged;
    match.role = betterRole(match.role, el.role);
    match.clickable = match.clickable || el.clickable;
    match.editable = match.editable || el.editable;
    match.actionable = match.actionable || el.actionable;
    match.confidence = Math.min(1, Math.max(match.confidence, el.confidence)
      + AGREEMENT_BONUS * (merged.length - 1));
    match.state = { ...el.state, ...match.state };
  }
  return out;
}
