import { describe, expect, it } from 'vitest';
import { getCompactSurface, getTool } from '../tools/registry';
import { evaluateToolCall } from '../tools/safety-gate';
import { UIMapHolder } from '../core/sense/ui-map-holder';
import type { UIMap } from '../core/sense/ui-map-types';

describe('direct tool safety gate', () => {
  it('allows read-only tools', () => {
    const tool = getTool('read_screen');
    expect(tool).toBeTruthy();
    expect(evaluateToolCall(tool!, {})).toBeNull();
  });

  it('blocks dangerous key combos before handler execution', () => {
    const tool = getTool('key_press');
    const result = evaluateToolCall(tool!, { key: 'alt+f4' });
    expect(result?.isError).toBe(true);
    expect(result?.text).toContain('safety block');
  });

  it('fails closed for confirm-tier direct REST/MCP actions', () => {
    const tool = getTool('close_window');
    const result = evaluateToolCall(tool!, {});
    expect(result?.isError).toBe(true);
    expect(result?.text).toContain('safety confirm');
  });

  it('maps compact actions to their granular safety tier', () => {
    const tool = getCompactSurface().find(t => t.name === 'browser');
    const result = evaluateToolCall(tool!, { action: 'evaluate', javascript: 'document.cookie' });
    expect(result?.isError).toBe(true);
    expect(result?.text).toContain('requires user confirmation');
  });

  it('resolves an el_NN ref to its label so the destructive-label rule fires on the MCP route', () => {
    // audit 2026-06-10, finding E: an MCP invoke_element({element_id,
    // snapshot_id}) carried no label, so a ref click on a "Send" button
    // bypassed CONFIRM_LABEL_PATTERNS entirely.
    const holder = new UIMapHolder();
    const id = holder.nextId();
    const map: UIMap = {
      snapshot_id: id, platform: 'windows', active_app: 'olk', window_title: 'Mail',
      window_bounds: [0, 0, 800, 600], coordinate_space: 'screen', scale_factor: 1,
      compiled_at: '0', sources_used: ['window', 'a11y'], anchors: {},
      elements: [{
        id: 'el_7', role: 'button', text: 'Send', normalized_text: 'send',
        bounds: [10, 10, 50, 20], confidence: 0.9, sources: ['a11y'],
        actionable: true, clickable: true, editable: false,
      } as UIMap['elements'][number]],
    };
    holder.put(map, Date.now());
    const tool = getTool('invoke_element');
    expect(tool).toBeTruthy();
    const args = { element_id: 'el_7', snapshot_id: id };
    // WITHOUT the holder the gate sees no label → the Send rule cannot fire.
    expect(evaluateToolCall(tool!, args)).toBeNull();
    // WITH the holder the ref resolves to "Send" → confirm-tier elevation.
    const gated = evaluateToolCall(tool!, args, { uiMaps: holder });
    expect(gated?.isError).toBe(true);
    expect(gated?.text).toContain('safety confirm');
  });
});
