/**
 * Session-scoped cache of recently compiled UIMaps, enabling safe el_NN element
 * references (resolve {snapshot_id, element_id} -> live element). Strict by
 * design: only the CURRENT, non-invalidated, in-TTL map resolves. See
 * docs/superpowers/specs/2026-06-07-ui-state-compiler-part2-design.md §2.
 */
import type { UIMap } from './ui-map-types';

/** GUI state changes fast — action refs expire quickly. 5s strict default. */
export const TTL_MS = 5_000;
/** Keep the current map + one prior (diagnostics); only current resolves. */
export const MAX_HELD = 2;

type Resolution = { ok: true; map: UIMap } | { ok: false; reason: 'unknown' | 'stale' | 'expired' };

export class UIMapHolder {
  private held: Array<{ map: UIMap; compiledAt: number }> = [];
  private counter = 0;
  private invalidated = false;

  /** Mint the next session-scoped id; caller passes it to compileUIMap. */
  nextId(): string {
    this.counter += 1;
    return `obs_${this.counter}`;
  }

  /** Store a compiled map as the new current; un-invalidates; bounds to MAX_HELD. */
  put(map: UIMap, now: number): void {
    this.held.push({ map, compiledAt: now });
    if (this.held.length > MAX_HELD) this.held.shift();
    this.invalidated = false;
  }

  /** Resolve a ref. Only the current, non-invalidated, in-TTL map is usable. */
  resolve(snapshotId: string, now: number): Resolution {
    const current = this.held[this.held.length - 1];
    if (!current || current.map.snapshot_id !== snapshotId) {
      const heldOlder = this.held.some(h => h.map.snapshot_id === snapshotId);
      return { ok: false, reason: heldOlder ? 'stale' : 'unknown' };
    }
    if (this.invalidated) return { ok: false, reason: 'stale' };
    if (now - current.compiledAt > TTL_MS) return { ok: false, reason: 'expired' };
    return { ok: true, map: current.map };
  }

  /** Mark all held maps invalid — called after any screen-changing action. */
  invalidate(): void {
    this.invalidated = true;
  }

  currentId(): string | undefined {
    return this.held[this.held.length - 1]?.map.snapshot_id;
  }
}
