import { describe, it, expect } from 'vitest';
import { UIMapHolder, TTL_MS, MAX_HELD } from '../core/sense/ui-map-holder';
import type { UIMap } from '../core/sense/ui-map-types';

const mapWith = (id: string): UIMap => ({
  snapshot_id: id, platform: 'windows', active_app: 'Notepad', window_title: 'Untitled',
  window_bounds: [0, 0, 800, 600], coordinate_space: 'screen', scale_factor: 1,
  compiled_at: '0', sources_used: ['window', 'a11y'], elements: [], anchors: {},
});

describe('UIMapHolder', () => {
  it('nextId mints monotonic obs_N ids', () => {
    const h = new UIMapHolder();
    expect(h.nextId()).toBe('obs_1');
    expect(h.nextId()).toBe('obs_2');
  });

  it('resolves the current map within TTL', () => {
    const h = new UIMapHolder();
    const id = h.nextId();
    h.put(mapWith(id), 1000);
    const r = h.resolve(id, 1000 + TTL_MS - 1);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.map.snapshot_id).toBe(id);
  });

  it('rejects an expired map (past TTL) even if it is the latest', () => {
    const h = new UIMapHolder();
    const id = h.nextId();
    h.put(mapWith(id), 1000);
    const r = h.resolve(id, 1000 + TTL_MS + 1);
    expect(r).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects an unknown / evicted id', () => {
    const h = new UIMapHolder();
    expect(h.resolve('obs_999', 0)).toEqual({ ok: false, reason: 'unknown' });
  });

  it('rejects a held-but-not-current id as stale', () => {
    const h = new UIMapHolder();
    const a = h.nextId(); h.put(mapWith(a), 0);
    const b = h.nextId(); h.put(mapWith(b), 0);
    expect(h.resolve(a, 0)).toEqual({ ok: false, reason: 'stale' });
    expect(h.resolve(b, 0).ok).toBe(true);
  });

  it('keeps at most MAX_HELD maps (oldest evicted -> unknown)', () => {
    const h = new UIMapHolder();
    const ids = Array.from({ length: MAX_HELD + 1 }, () => { const i = h.nextId(); h.put(mapWith(i), 0); return i; });
    expect(h.resolve(ids[0], 0)).toEqual({ ok: false, reason: 'unknown' }); // evicted
    expect(h.resolve(ids[ids.length - 1], 0).ok).toBe(true);
  });

  it('invalidate() makes the current map resolve as stale', () => {
    const h = new UIMapHolder();
    const id = h.nextId(); h.put(mapWith(id), 0);
    h.invalidate();
    expect(h.resolve(id, 0)).toEqual({ ok: false, reason: 'stale' });
  });
});
