import { describe, it, expect } from 'vitest';
import type { UIMap, UIElement, ElementRef, Source } from '../core/sense/ui-map-types';
import { ROLES, SOURCES } from '../core/sense/ui-map-types';

describe('ui-map-types', () => {
  it('exports the role and source enums used across the compiler', () => {
    expect(ROLES).toContain('button');
    expect(ROLES).toContain('input');
    expect(ROLES).toContain('unknown');
    expect(SOURCES).toEqual(['window', 'a11y', 'ocr', 'vision', 'dom', 'cursor']);
  });

  it('a UIMap literal satisfies the shape', () => {
    const ref: ElementRef = { id: 'el_1', role: 'button', normalized_text: 'send' };
    const el: UIElement = {
      id: 'el_1', role: 'button', text: 'Send', normalized_text: 'send',
      bounds: [1, 2, 3, 4], confidence: 0.9, sources: ['a11y', 'ocr'],
      actionable: true, clickable: true, editable: false,
      state: { focused: true, enabled: true },
    };
    const map: UIMap = {
      snapshot_id: 'obs_1', platform: 'windows', active_app: 'Notepad',
      window_title: 'Untitled', window_bounds: [0, 0, 800, 600],
      coordinate_space: 'screen', scale_factor: 1, compiled_at: 't',
      sources_used: ['window', 'a11y'], elements: [el],
      anchors: { focused: ref }, truncation: { total_elements: 1, returned_elements: 1 },
    };
    expect(map.elements[0].id).toBe('el_1');
    const s: Source = 'vision';
    expect(s).toBe('vision');
  });
});
