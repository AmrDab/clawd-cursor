/**
 * SafetyLayer tests — tier assignment, blocked keys, destructive labels,
 * sensitive apps.
 */

import { describe, it, expect } from 'vitest';
import { evaluate, isAllowed, evaluateInput } from '../core/safety';

describe('SafetyLayer.evaluate', () => {
  describe('read tier', () => {
    it.each(['read_screen', 'desktop_screenshot', 'get_windows', 'read_clipboard', 'cdp_read_text'])(
      '%s always allows',
      (tool) => {
        const d = evaluate({ tool, args: {} });
        expect(d.decision).toBe('allow');
        expect(d.tier).toBe('read');
      },
    );
  });

  describe('blocked keys', () => {
    it('blocks alt+F4 via key_press', () => {
      const d = evaluate({ tool: 'key_press', args: { key: 'alt+f4' } });
      expect(d.decision).toBe('block');
    });
    it('blocks cmd+Q via press (pipeline-internal alias)', () => {
      const d = evaluate({ tool: 'press', args: { combo: 'cmd+q' } });
      expect(d.decision).toBe('block');
    });
    it('blocks ctrl+alt+delete', () => {
      const d = evaluate({ tool: 'key_press', args: { key: 'Ctrl+Alt+Delete' } });
      expect(d.decision).toBe('block');
    });
    it('allows safe combos', () => {
      expect(evaluate({ tool: 'key_press', args: { key: 'mod+s' } }).decision).toBe('allow');
      expect(evaluate({ tool: 'press', args: { combo: 'Return' } }).decision).toBe('allow');
    });
  });

  describe('cdp_evaluate', () => {
    it('requires confirm even without args inspection', () => {
      expect(evaluate({ tool: 'cdp_evaluate', args: {} }).decision).toBe('confirm');
    });
  });

  describe('destructive target labels', () => {
    it.each(['Send', 'Delete', 'Confirm', 'Remove', 'Checkout', 'Pay', 'Publish', 'Log Out'])(
      'elevates click with target=%j to confirm',
      (label) => {
        const d = evaluate({ tool: 'mouse_click', args: {}, targetLabel: label });
        expect(d.decision).toBe('confirm');
        expect(d.tier).toBe('destructive');
      },
    );

    it('allows click on benign target', () => {
      expect(evaluate({ tool: 'mouse_click', args: {}, targetLabel: 'New' }).decision).toBe('allow');
    });
  });

  // #124: destructive-label patterns must NOT fire on the CONTENT typed by a
  // typing tool. The `targetLabel` for type_text/cdp_type is the text payload,
  // not a control label — typing a sentence containing "confirm"/"send" is
  // benign and must stay at input tier.
  describe('typed text is not a destructive label (#124)', () => {
    const prose = 'This is part of the v0.9.5 verification to confirm reliable desktop automation.';

    it('allows type_text whose content contains "confirm"', () => {
      const d = evaluate({ tool: 'type_text', args: { text: prose }, targetLabel: prose });
      expect(d.decision).toBe('allow');
    });

    it('allows type_text whose content contains "send"', () => {
      const d = evaluate({ tool: 'type_text', args: { text: 'please send the report' }, targetLabel: 'please send the report' });
      expect(d.decision).toBe('allow');
    });

    it('allows the compound computer.type action with "confirm" in the text', () => {
      // unpacks to canonical type_text
      const d = evaluate({ tool: 'computer', args: { action: 'type', text: prose }, targetLabel: prose });
      expect(d.decision).toBe('allow');
    });

    it('allows cdp_type (browser.type) prose containing "delete"', () => {
      const d = evaluate({ tool: 'browser', args: { action: 'type', text: 'delete this line of the draft' }, targetLabel: 'delete this line of the draft' });
      expect(d.decision).toBe('allow');
    });

    // Coverage that MUST be preserved: activating a control whose label is
    // destructive still confirms, including cdp_click by visible text.
    it('still confirms cdp_click on visible text "Send"', () => {
      const d = evaluate({ tool: 'cdp_click', args: { text: 'Send' }, targetLabel: 'Send' });
      expect(d.decision).toBe('confirm');
      expect(d.tier).toBe('destructive');
    });

    it('still confirms invoke_element name="Delete"', () => {
      const d = evaluate({ tool: 'invoke_element', args: { name: 'Delete' }, targetLabel: 'Delete' });
      expect(d.decision).toBe('confirm');
    });

    it('still confirms the compound browser.click on visible text "Pay"', () => {
      const d = evaluate({ tool: 'browser', args: { action: 'click', text: 'Pay' }, targetLabel: 'Pay' });
      expect(d.decision).toBe('confirm');
    });
  });

  describe('input tier default', () => {
    it.each(['mouse_click', 'type_text', 'smart_click', 'smart_type', 'a11y_click'])(
      '%s with no target defaults to allow',
      (tool) => {
        expect(evaluate({ tool, args: {} }).decision).toBe('allow');
      },
    );
  });

  describe('isAllowed helper', () => {
    it('is true for allow', () => {
      expect(isAllowed({ decision: 'allow', tier: 'read' })).toBe(true);
    });
    it('is false for confirm and block', () => {
      expect(isAllowed({ decision: 'confirm', tier: 'input', reason: 'x' })).toBe(false);
      expect(isAllowed({ decision: 'block', tier: 'destructive', reason: 'x' })).toBe(false);
    });
  });

  describe('unknown tools default to input tier', () => {
    it('treats a made-up tool name as input tier + allow-by-default', () => {
      const d = evaluate({ tool: 'future_tool_xyz', args: {} });
      expect(d.decision).toBe('allow');
      expect(d.tier).toBe('input');
    });
  });
});

describe('evaluateInput (canonical safety gate)', () => {
  it('returns allow:true for a read-tier tool', () => {
    const d = evaluateInput({ toolName: 'desktop_screenshot', args: {} });
    expect(d.allow).toBe(true);
    expect(d.tier).toBe(0);
  });

  it('safetyTier:3 injected via ToolDefinition overrides name-based lookup', () => {
    // 'wait' is normally tier 0 (read), but declaring it as tier 3 should elevate it
    const d = evaluateInput({ toolName: 'wait', args: {}, safetyTier: 3 });
    // tier 3 maps to 'destructive' — which means decision is 'confirm', so allow === false
    expect(d.allow).toBe(false);
    expect(d.tier).toBe(3);
  });
});
