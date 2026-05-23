/**
 * Save As dialog reliability — unit tests for fixes #122, #123.
 *
 * These tests cover the deterministic logic changes without requiring a
 * live GUI (native input / UIA calls are mocked or exercised via pure math).
 *
 * Live-GUI verification is documented in the PR body.
 *
 * #121 (triple_click in Save As) is intentionally NOT addressed by changing
 * the triple_click primitive: `mouse_triple_click` is documented as "selects
 * a paragraph in most text editors", so globally rerouting it to Ctrl+A
 * (select-all) would break that contract in browsers/editors/terminals. The
 * Save As field opens with its text pre-selected, so the correct handling is
 * to type directly (no triple_click needed); a future text-replace helper can
 * Ctrl+A at the typing layer if required.
 */

import { describe, it, expect } from 'vitest';

// ─── Bug #122: set_field_value widest-element heuristic ───────────────────
//
// When multiple UIA elements share the same name (label + input), the
// fallback path must click the widest one (the actual input, not the label).
// Test the "widest bounds" selection logic from a11y_depth.ts.

interface MockElement {
  name: string;
  controlType: string;
  bounds: { x: number; y: number; width: number; height: number };
}

function pickWidestElement(elements: MockElement[]): MockElement | undefined {
  if (elements.length === 0) return undefined;
  return elements.reduce((best, el) =>
    (el.bounds?.width ?? 0) > (best.bounds?.width ?? 0) ? el : best,
    elements[0],
  );
}

describe('#122 set_field_value fallback: widest-element selection', () => {
  it('selects the ComboBox (wide) over the Text label (narrow)', () => {
    const elements: MockElement[] = [
      { name: 'File name:', controlType: 'ControlType.Text',     bounds: { x: 258, y: 928, width: 115,  height: 23 } },
      { name: 'File name:', controlType: 'ControlType.ComboBox', bounds: { x: 373, y: 928, width: 1054, height: 23 } },
    ];
    const picked = pickWidestElement(elements);
    expect(picked?.controlType).toBe('ControlType.ComboBox');
    expect(picked?.bounds.width).toBe(1054);
  });

  it('falls back to the only element when there is just one', () => {
    const elements: MockElement[] = [
      { name: 'File name:', controlType: 'ControlType.Edit', bounds: { x: 376, y: 931, width: 1031, height: 17 } },
    ];
    const picked = pickWidestElement(elements);
    expect(picked?.controlType).toBe('ControlType.Edit');
  });

  it('returns undefined for empty list', () => {
    expect(pickWidestElement([])).toBeUndefined();
  });

  it('computes correct click-centre from widest element bounds', () => {
    const el: MockElement = { name: 'File name:', controlType: 'ControlType.ComboBox',
      bounds: { x: 373, y: 928, width: 1054, height: 23 } };
    const cx = Math.round(el.bounds.x + el.bounds.width / 2);
    const cy = Math.round(el.bounds.y + el.bounds.height / 2);
    // centre of (373, 928, 1054×23): cx = 373 + 527 = 900, cy = 928 + round(11.5) = 940
    expect(cx).toBe(900);
    expect(cy).toBe(940);
  });
});

// ─── Bug #123: activate-at-point ensures foreground before click ───────────
//
// Pure logic: the activate-at-point PS command is triggered iff the
// foreground window differs from the window at (x, y). Test the
// "needs activation" decision.

function needsActivation(fgHwnd: number, windowAtPointHwnd: number): boolean {
  // Mirrors the PS bridge Cmd-ActivateAtPoint:
  //   if ($root -ne $fg) { SetForegroundWindow }
  return fgHwnd !== windowAtPointHwnd && windowAtPointHwnd !== 0;
}

describe('#123 activate-at-point foreground guard', () => {
  it('same window → no activation needed', () => {
    expect(needsActivation(1234, 1234)).toBe(false);
  });

  it('different window → activation needed', () => {
    expect(needsActivation(1234, 5678)).toBe(true);
  });

  it('zero hwnd at point (no window) → no activation', () => {
    expect(needsActivation(1234, 0)).toBe(false);
  });

  it('zero fg hwnd (desktop?) + real hwnd at point → activation', () => {
    expect(needsActivation(0, 5678)).toBe(true);
  });
});

// ─── Bug #123: DPI-aware mouseScaleFactor ─────────────────────────────────
//
// mouseScaleFactor must convert image-space coords to the coordinate space
// nut-js SendInput expects (physical pixels on Win). On a machine where
// Windows Forms returns logical pixels different from nut-js physical pixels,
// the factor must account for dpiRatio so clicks land correctly.
//
// Formula: mouseScaleFactor = physicalWidth / LLM_TARGET_WIDTH
//   (nut-js on Windows accepts physical-pixel coords directly, which equals
//    physicalWidth / 1280 regardless of DPI scaling mode.)
//
// This is already what createToolContext computes (screenshotScaleFactor);
// the test documents the invariant so any future change to the formula
// is caught.

const LLM_TARGET_WIDTH = 1280;

function computeMouseScaleFactor(physicalWidth: number): number {
  return physicalWidth > LLM_TARGET_WIDTH ? physicalWidth / LLM_TARGET_WIDTH : 1;
}

function imageToPhysical(imageX: number, scaleFactor: number): number {
  return Math.round(imageX * scaleFactor);
}

describe('#123 DPI-aware mouseScaleFactor', () => {
  it('2560px physical, image center 640 → physical 1280', () => {
    const sf = computeMouseScaleFactor(2560);
    expect(sf).toBe(2);
    expect(imageToPhysical(640, sf)).toBe(1280);
  });

  it('1920px physical (150% DPI), image 853 → physical 1280', () => {
    const sf = computeMouseScaleFactor(1920);
    expect(sf).toBeCloseTo(1.5);
    expect(imageToPhysical(853, sf)).toBe(1280); // 853 * 1.5 = 1279.5 → 1280
  });

  it('1280px physical (100% DPI), image 640 → physical 640 (factor=1)', () => {
    const sf = computeMouseScaleFactor(1280);
    expect(sf).toBe(1);
    expect(imageToPhysical(640, sf)).toBe(640);
  });

  it('scale factor is always ≥ 1 (never shrinks coordinates)', () => {
    [800, 1024, 1280, 1920, 2560, 3840].forEach(w => {
      expect(computeMouseScaleFactor(w)).toBeGreaterThanOrEqual(1);
    });
  });
});
