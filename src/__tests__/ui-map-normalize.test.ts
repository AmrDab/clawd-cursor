import { describe, it, expect } from 'vitest';
import { normalizeRole, inferCapabilities, normText } from '../core/sense/ui-map-normalize';

describe('normalizeRole', () => {
  it('maps UIA control types to normalized roles', () => {
    expect(normalizeRole('Button')).toBe('button');
    expect(normalizeRole('ControlType.Button')).toBe('button');
    expect(normalizeRole('Edit')).toBe('input');
    expect(normalizeRole('Hyperlink')).toBe('link');
    expect(normalizeRole('CheckBox')).toBe('checkbox');
    expect(normalizeRole('ListItem')).toBe('listitem');
    expect(normalizeRole('TabItem')).toBe('tab');
    expect(normalizeRole('Text')).toBe('text');
    expect(normalizeRole('Image')).toBe('image');
    expect(normalizeRole('SomethingWeird')).toBe('unknown');
    expect(normalizeRole(undefined)).toBe('unknown');
  });

  it('maps macOS AX control types to the same roles (post-AX-strip and raw)', () => {
    // The adapter strips "AX", but be defensive about both forms.
    expect(normalizeRole('TextField')).toBe('input');
    expect(normalizeRole('AXTextField')).toBe('input');
    expect(normalizeRole('TextArea')).toBe('input');
    expect(normalizeRole('SecureTextField')).toBe('input');
    expect(normalizeRole('SearchField')).toBe('input');
    expect(normalizeRole('Link')).toBe('link');
    expect(normalizeRole('AXLink')).toBe('link');
    expect(normalizeRole('PopUpButton')).toBe('button');
  });

  it('macOS AX text fields and links are editable/clickable (regression: were dead on mac)', () => {
    expect(inferCapabilities({ role: normalizeRole('TextField'), source: 'a11y', enabled: true }).editable).toBe(true);
    expect(inferCapabilities({ role: normalizeRole('Link'), source: 'a11y', enabled: true }).clickable).toBe(true);
  });
});

describe('normText', () => {
  it('trims, lowercases, collapses whitespace', () => {
    expect(normText('  Send  Now ')).toBe('send now');
    expect(normText(undefined)).toBe('');
  });
});

describe('inferCapabilities', () => {
  it('a11y button is clickable + actionable when enabled', () => {
    const c = inferCapabilities({ role: 'button', source: 'a11y', enabled: true });
    expect(c).toMatchObject({ clickable: true, editable: false, actionable: true });
  });
  it('a disabled button is not actionable', () => {
    const c = inferCapabilities({ role: 'button', source: 'a11y', enabled: false });
    expect(c.actionable).toBe(false);
  });
  it('an input is editable', () => {
    const c = inferCapabilities({ role: 'input', source: 'a11y', enabled: true });
    expect(c).toMatchObject({ editable: true, actionable: true });
  });
  it('an OCR-only text element is not clickable/actionable (no pattern info)', () => {
    const c = inferCapabilities({ role: 'text', source: 'ocr', enabled: true });
    expect(c).toMatchObject({ clickable: false, editable: false, actionable: false });
  });
});
