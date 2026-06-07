import { describe, it, expect } from 'vitest';
import { computeAnchors } from '../core/sense/ui-map-anchors';
import type { UIElement } from '../core/sense/ui-map-types';

const el = (over: Partial<UIElement> & Pick<UIElement, 'id'>): UIElement => ({
  role: 'button', text: 't', normalized_text: 't', bounds: [0, 0, 10, 10],
  confidence: 0.9, sources: ['a11y'], clickable: true, actionable: true, ...over });

describe('computeAnchors', () => {
  it('sets focused from state.focused', () => {
    const a = computeAnchors([el({ id: 'el_0', normalized_text: 'to', role: 'input',
      state: { focused: true } }), el({ id: 'el_1' })], undefined);
    expect(a.focused?.id).toBe('el_0');
  });

  it('picks primary_action_candidate by primary verb + confidence', () => {
    const a = computeAnchors([
      el({ id: 'el_0', normalized_text: 'cancel' }),
      el({ id: 'el_1', normalized_text: 'send', confidence: 0.96 }),
    ], undefined);
    expect(a.primary_action_candidate?.id).toBe('el_1');
    expect(a.primary_action_candidate?.normalized_text).toBe('send');
  });

  it('returns no primary candidate when no clickable primary-verb element exists', () => {
    const a = computeAnchors([el({ id: 'el_0', normalized_text: 'random', role: 'text',
      clickable: false, actionable: false })], undefined);
    expect(a.primary_action_candidate).toBeUndefined();
  });
});
