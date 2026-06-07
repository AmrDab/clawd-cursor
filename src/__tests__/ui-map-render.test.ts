import { describe, it, expect } from 'vitest';
import { renderUIMap } from '../core/sense/ui-map-render';
import type { UIMap, UIElement } from '../core/sense/ui-map-types';

const el = (over: Partial<UIElement> & Pick<UIElement, 'id' | 'role' | 'normalized_text'>): UIElement => ({
  text: over.normalized_text, bounds: [1, 2, 3, 4], confidence: 0.9,
  sources: ['a11y'], clickable: true, actionable: true, ...over });

const baseMap = (elements: UIElement[]): UIMap => ({
  snapshot_id: 'obs_1', platform: 'windows', active_app: 'Notepad',
  window_title: 'Untitled', window_bounds: [0, 0, 800, 600], coordinate_space: 'screen',
  scale_factor: 1, compiled_at: '0', sources_used: ['window', 'a11y'], elements, anchors: {} });

describe('renderUIMap', () => {
  it('renders one compact line per element with id, role, text, confidence, sources', () => {
    const out = renderUIMap(baseMap([el({ id: 'el_0', role: 'button', normalized_text: 'send',
      text: 'Send', sources: ['a11y', 'ocr'], confidence: 0.96 })]));
    expect(out).toContain('el_0');
    expect(out).toContain('[button]');
    expect(out).toContain('"Send"');
    expect(out).toContain('0.96');
    expect(out).toContain('a11y,ocr');
  });

  it('ranks actionable/high-confidence elements before plain text, and truncates with a count', () => {
    const many: UIElement[] = [];
    for (let i = 0; i < 60; i++) many.push(el({ id: `el_${i}`, role: 'text',
      normalized_text: `t${i}`, clickable: false, actionable: false, confidence: 0.5 }));
    many.push(el({ id: 'el_btn', role: 'button', normalized_text: 'send', text: 'Send', confidence: 0.99 }));
    const out = renderUIMap(baseMap(many), { max: 40 });
    expect(out.split('\n')[0]).toContain('el_btn');  // the button ranks first
    expect(out).toMatch(/40 of 61 shown/);
  });
});
