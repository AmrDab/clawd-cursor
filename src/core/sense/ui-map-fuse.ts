import type { UIElement, Source, Role } from './ui-map-types';
import { iou } from './ui-map-geom';

const AGREEMENT_BONUS = 0.15;
const OVERLAP_MIN = 0.5;        // IoU threshold to treat two boxes as the same element
const ROLE_PRIORITY: Role[] = ['button', 'input', 'link', 'checkbox', 'tab',
  'listitem', 'list', 'image', 'text', 'unknown'];

function betterRole(a: Role, b: Role): Role {
  return ROLE_PRIORITY.indexOf(a) <= ROLE_PRIORITY.indexOf(b) ? a : b;
}

/** Merge same-place + same-text elements across sources; raise confidence per
 *  corroborating source; keep the stronger role/capabilities. */
export function fuse(elements: UIElement[]): UIElement[] {
  const out: UIElement[] = [];
  // Running max of the ORIGINAL (un-bonused) confidence per merged cluster, so
  // the agreement bonus is applied once against the base — idempotent for 3+
  // sources (a11y+ocr+vision must give base+2·bonus, not a compounded value).
  const baseConf = new Map<UIElement, number>();
  for (const el of elements) {
    const match = out.find(o =>
      o.normalized_text === el.normalized_text &&
      o.normalized_text !== '' &&
      o.normalized_text !== undefined &&
      iou(o.bounds, el.bounds) >= OVERLAP_MIN);
    if (!match) {
      const copy = { ...el, sources: [...el.sources] };
      out.push(copy);
      baseConf.set(copy, el.confidence);
      continue;
    }
    const merged: Source[] = Array.from(new Set([...match.sources, ...el.sources]));
    match.sources = merged;
    match.role = betterRole(match.role, el.role);
    match.clickable = match.clickable || el.clickable;
    match.editable = match.editable || el.editable;
    match.actionable = match.actionable || el.actionable;
    const base = Math.max(baseConf.get(match) ?? match.confidence, el.confidence);
    baseConf.set(match, base);
    match.confidence = Math.min(1, base + AGREEMENT_BONUS * (merged.length - 1));
    match.state = { ...el.state, ...match.state };
  }
  return out;
}
