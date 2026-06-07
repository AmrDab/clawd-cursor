import type { UIElement, UIMap, ElementRef } from './ui-map-types';

const PRIMARY_VERBS = ['send', 'save', 'submit', 'ok', 'continue', 'next',
  'confirm', 'post', 'publish', 'done', 'apply'];

const toRef = (e: UIElement): ElementRef => ({
  id: e.id, role: e.role, normalized_text: e.normalized_text });

/**
 * Two cross-turn anchors. `prevAnchors` is accepted for re-identification
 * continuity (matched by role + normalized_text); with only two anchors this
 * stays cheap and needs no element database.
 */
export function computeAnchors(
  elements: UIElement[],
  _prevAnchors: UIMap['anchors'] | undefined,
): UIMap['anchors'] {
  const focusedEl = elements.find(e => e.state?.focused);
  const candidates = elements
    .filter(e => e.clickable && PRIMARY_VERBS.includes(e.normalized_text ?? ''))
    .sort((a, b) => b.confidence - a.confidence);
  return {
    focused: focusedEl ? toRef(focusedEl) : undefined,
    primary_action_candidate: candidates[0] ? toRef(candidates[0]) : undefined,
  };
}
