/**
 * Sense-layer tests: a11y bounds sanity + fingerprint stagnation.
 */

import { describe, it, expect } from 'vitest';
import {
  isValidBounds,
  centerOf,
  resolveByName,
  resolveById,
} from '../core/sense/a11y-resolver';
import { fingerprint, FingerprintHistory } from '../core/sense/fingerprint';
import type { SnapshotElement } from '../core/sense/types';

describe('a11y-resolver bounds sanity', () => {
  it('accepts normal bounds', () => {
    expect(isValidBounds({ x: 100, y: 200, width: 80, height: 24 })).toBe(true);
  });

  it('rejects the infamous y:-29503 pattern (macOS AX hidden element)', () => {
    expect(isValidBounds({ x: 0, y: -29503, width: 10, height: 10 })).toBe(false);
  });

  it('rejects zero width', () => {
    expect(isValidBounds({ x: 100, y: 100, width: 0, height: 24 })).toBe(false);
  });

  it('rejects negative height', () => {
    expect(isValidBounds({ x: 100, y: 100, width: 80, height: -5 })).toBe(false);
  });

  it('rejects absurdly large coords', () => {
    expect(isValidBounds({ x: 999_999, y: 100, width: 10, height: 10 })).toBe(false);
  });

  it('allows slight off-screen overlap within 100px tolerance', () => {
    expect(isValidBounds({ x: -50, y: 10, width: 80, height: 24 })).toBe(true);
  });

  it('centerOf returns integer center', () => {
    expect(centerOf({ x: 10, y: 20, width: 100, height: 50 })).toEqual({ x: 60, y: 45 });
  });
});

describe('a11y-resolver resolveByName', () => {
  it('returns center for valid element', async () => {
    const lookup = async () => [
      { name: 'Send', bounds: { x: 100, y: 200, width: 80, height: 24 } },
    ];
    expect(await resolveByName('Send', lookup)).toEqual({ x: 140, y: 212 });
  });

  it('returns null when no element found', async () => {
    const lookup = async () => [];
    expect(await resolveByName('Ghost', lookup)).toBeNull();
  });

  it('returns null when element has invalid bounds', async () => {
    const lookup = async () => [
      { name: 'Hidden', bounds: { x: 0, y: -29503, width: 0, height: 0 } },
    ];
    expect(await resolveByName('Hidden', lookup)).toBeNull();
  });

  it('passes controlType and processId through', async () => {
    let received: any = null;
    const lookup = async (q: any) => {
      received = q;
      return [{ name: 'X', bounds: { x: 0, y: 0, width: 10, height: 10 } }];
    };
    await resolveByName('X', lookup, { controlType: 'Button', processId: 123 });
    expect(received).toEqual({ name: 'X', controlType: 'Button', processId: 123 });
  });
});

describe('a11y-resolver resolveById', () => {
  it('returns center when element found by automationId', async () => {
    const lookup = async () => [
      { automationId: 'send-btn', bounds: { x: 50, y: 100, width: 60, height: 20 } },
    ];
    expect(await resolveById('send-btn', lookup)).toEqual({ x: 80, y: 110 });
  });
});

describe('fingerprint', () => {
  const e = (name: string, x: number, y: number, role = 'button'): SnapshotElement => ({
    name,
    role,
    x,
    y,
    width: 80,
    height: 24,
    source: 'a11y',
  });

  it('is deterministic for the same input', () => {
    const els = [e('Send', 100, 200), e('Cancel', 200, 200)];
    expect(fingerprint(els)).toBe(fingerprint(els));
  });

  it('is order-insensitive', () => {
    const a = [e('Send', 100, 200), e('Cancel', 200, 200)];
    const b = [e('Cancel', 200, 200), e('Send', 100, 200)];
    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  it('quantizes small coord jitter within a bucket', () => {
    // With quant=8 using Math.round(n/8)*8:
    //   100 → round(12.5)*8 = 13*8 = 104 (JS rounds half-up for positive)
    //   101..107 all → round(12.6..13.4)*8 = 13*8 = 104
    //   108 → round(13.5)*8 = 14*8 = 112 (different bucket)
    // So any jitter 100..107 on x and 200..207 on y produces the same fp.
    const a = [e('Send', 100, 200)];
    const b = [e('Send', 103, 202)];   // same 104/200 bucket
    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  it('notices jitter that crosses a bucket boundary', () => {
    const a = [e('Send', 100, 200)];   // bucket 104/200
    const b = [e('Send', 108, 200)];   // bucket 112/200 — DIFFERENT
    expect(fingerprint(a)).not.toBe(fingerprint(b));
  });

  it('includes active window title so same UI in different app differs', () => {
    const els = [e('Send', 100, 200)];
    expect(fingerprint(els, 'Outlook')).not.toBe(fingerprint(els, 'Mail'));
  });

  it('different elements produce different fingerprints', () => {
    expect(fingerprint([e('Send', 100, 200)])).not.toBe(fingerprint([e('Done', 100, 200)]));
  });

  it('a changed field VALUE moves the fingerprint (typing is an observable change)', () => {
    // Value-blind fingerprints made every successful type/fill look like
    // "no observable change" (audit 2026-06-10, finding D2).
    const empty = [{ ...e('To', 100, 200, 'edit'), value: '' }];
    const typed = [{ ...e('To', 100, 200, 'edit'), value: 'amr@x.com' }];
    expect(fingerprint(empty as SnapshotElement[])).not.toBe(fingerprint(typed as SnapshotElement[]));
  });

  it('secure fields (value undefined) do not leak into the fingerprint', () => {
    const a = [{ ...e('Password', 100, 200, 'edit'), value: undefined }];
    const b = [{ ...e('Password', 100, 200, 'edit'), value: undefined }];
    expect(fingerprint(a as SnapshotElement[])).toBe(fingerprint(b as SnapshotElement[]));
  });
});

describe('FingerprintHistory', () => {
  it('is not stagnant with <2 entries', () => {
    const h = new FingerprintHistory();
    expect(h.isStagnant()).toBe(false);
    h.push('a');
    expect(h.isStagnant()).toBe(false);
  });

  it('detects 2-in-a-row stagnation', () => {
    const h = new FingerprintHistory();
    h.push('a');
    h.push('a');
    expect(h.isStagnant(2)).toBe(true);
  });

  it('does not flag stagnation when values change', () => {
    const h = new FingerprintHistory();
    h.push('a');
    h.push('b');
    expect(h.isStagnant(2)).toBe(false);
  });

  it('respects custom n', () => {
    const h = new FingerprintHistory();
    h.push('a');
    h.push('a');
    h.push('a');
    expect(h.isStagnant(3)).toBe(true);
    expect(h.isStagnant(4)).toBe(false);
  });

  it('reset clears history', () => {
    const h = new FingerprintHistory();
    h.push('a');
    h.push('a');
    h.reset();
    expect(h.getHistory()).toEqual([]);
    expect(h.isStagnant()).toBe(false);
  });

  it('caps history to maxSize', () => {
    const h = new FingerprintHistory(3);
    h.push('a');
    h.push('b');
    h.push('c');
    h.push('d');
    expect(h.getHistory()).toEqual(['b', 'c', 'd']);
  });
});
