import { describe, it, expect } from 'vitest';
import { findActionButton, MATCH_THRESHOLD, AMBIGUITY_MARGIN, MAX_CANDIDATES } from '../core/sense/ui-map-find';
import type { UIElement } from '../core/sense/ui-map-types';

const btn = (over: Partial<UIElement> & Pick<UIElement, 'id' | 'normalized_text'>): UIElement => ({
  role: 'button', text: over.normalized_text, bounds: [0, 0, 40, 12], confidence: 0.9,
  sources: ['a11y'], clickable: true, actionable: true, ...over });

describe('findActionButton', () => {
  it('matches an intent to a synonym-labeled button (submit -> "Send")', () => {
    const r = findActionButton([btn({ id: 'el_0', normalized_text: 'send' }), btn({ id: 'el_1', normalized_text: 'cancel' })], 'obs_1', 'submit');
    expect(r.status).toBe('ok');
    if (r.status === 'ok') { expect(r.best.element_id).toBe('el_0'); expect(r.snapshot_id).toBe('obs_1'); }
  });

  it('ignores non-clickable elements', () => {
    const r = findActionButton([btn({ id: 'el_0', normalized_text: 'send', clickable: false, actionable: false })], 'obs_1', 'submit');
    expect(r.status).toBe('none');
  });

  it('exact literal match outranks a synonym on comparable confidence', () => {
    // exact 'post' = 1.0*0.8 = 0.80 ; synonym 'publish' = 0.9*0.85 = 0.765 -> exact wins
    const r = findActionButton([btn({ id: 'el_0', normalized_text: 'post', confidence: 0.8 }), btn({ id: 'el_1', normalized_text: 'publish', confidence: 0.85 })], 'obs_1', 'post');
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.best.element_id).toBe('el_0');
  });

  it('returns ambiguous when top two are within the margin', () => {
    const r = findActionButton([btn({ id: 'el_0', normalized_text: 'ok', confidence: 0.9 }), btn({ id: 'el_1', normalized_text: 'confirm', confidence: 0.9 })], 'obs_1', 'submit');
    expect(r.status).toBe('ambiguous');
    if (r.status === 'ambiguous') { expect(r.candidates.length).toBe(2); expect(r.reason).toMatch(/margin/i); }
  });

  it('returns none with candidates when nothing clears the threshold', () => {
    const r = findActionButton([btn({ id: 'el_0', normalized_text: 'weather widget' })], 'obs_1', 'submit');
    expect(r.status).toBe('none');
    if (r.status === 'none') expect(Array.isArray(r.candidates)).toBe(true);
  });

  it('caps candidates at MAX_CANDIDATES', () => {
    const els = Array.from({ length: MAX_CANDIDATES + 3 }, (_, i) => btn({ id: `el_${i}`, normalized_text: 'send' }));
    const r = findActionButton(els, 'obs_1', 'send');
    expect(r.candidates.length).toBe(MAX_CANDIDATES);
  });
});
