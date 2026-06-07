import { describe, it, expect } from 'vitest';
import { fuse } from '../core/sense/ui-map-fuse';
import type { UIElement } from '../core/sense/ui-map-types';

const mk = (over: Partial<UIElement> & Pick<UIElement, 'id' | 'bounds' | 'sources'>): UIElement => ({
  role: 'button', text: 'x', normalized_text: 'x', confidence: 0.5, ...over,
});

describe('fuse', () => {
  it('merges an a11y + OCR element at the same place + text into one with both sources', () => {
    const a = mk({ id: 'a', bounds: [10, 10, 40, 12], sources: ['a11y'],
      normalized_text: 'send', confidence: 0.85, role: 'button', clickable: true, actionable: true });
    const o = mk({ id: 'o', bounds: [11, 11, 38, 11], sources: ['ocr'],
      normalized_text: 'send', role: 'text', confidence: 0.5 });
    const out = fuse([a, o]);
    expect(out).toHaveLength(1);
    expect(out[0].sources.sort()).toEqual(['a11y', 'ocr']);
    expect(out[0].role).toBe('button');            // a11y role wins over OCR 'text'
    expect(out[0].confidence).toBeGreaterThan(0.85); // agreement bonus raised it
    expect(out[0].confidence).toBeLessThanOrEqual(1);
  });

  it('keeps non-overlapping elements separate', () => {
    const a = mk({ id: 'a', bounds: [0, 0, 10, 10], sources: ['a11y'], normalized_text: 'one' });
    const b = mk({ id: 'b', bounds: [500, 500, 10, 10], sources: ['a11y'], normalized_text: 'two' });
    expect(fuse([a, b])).toHaveLength(2);
  });

  it('does NOT merge overlapping elements with different text', () => {
    const a = mk({ id: 'a', bounds: [0, 0, 100, 20], sources: ['a11y'], normalized_text: 'send' });
    const b = mk({ id: 'b', bounds: [2, 2, 96, 16], sources: ['ocr'], normalized_text: 'cancel' });
    expect(fuse([a, b])).toHaveLength(2);
  });
});
