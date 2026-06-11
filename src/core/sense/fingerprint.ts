/**
 * Snapshot fingerprint — stagnation detection.
 *
 * Ported from src/snapshot-builder.ts. The idea: after every agent action,
 * compute a stable hash of "what's on screen" (structured elements only —
 * not pixels). If the fingerprint doesn't change across N consecutive
 * actions, the agent is stuck doing the same thing.
 *
 * The orchestrator uses this to short-circuit infinite loops. A 2-iteration
 * duplicate fingerprint + a verifier that says "not done" = abort, try a
 * different layer (text-agent → vision-agent → retry).
 */

import * as crypto from 'crypto';
import type { SnapshotElement } from './types';

/**
 * Produce a deterministic short hash of the screen state.
 *
 * Order-insensitive (elements sorted before hash), position-quantized (to 8px
 * buckets) so that sub-pixel jitter from OCR doesn't break the equality.
 *
 * Intentionally NOT based on pixel screenshots — that's what the verifier's
 * pixel-diff signal handles. This is the a11y/OCR-level "same set of named
 * buttons at roughly the same places" fingerprint.
 */
export function fingerprint(elements: SnapshotElement[], activeTitle?: string): string {
  // Quantize coords to a grid to absorb OCR jitter.
  const QUANT = 8;
  const quant = (n: number) => Math.round(n / QUANT) * QUANT;

  const tokens = elements.map(e => {
    const cx = quant(e.x);
    const cy = quant(e.y);
    const role = e.role ?? e.source;
    // Normalize name: trim + collapse whitespace + lowercase
    const name = (e.name ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
    // Include the field VALUE (hashed short, never the raw text — it may be
    // sensitive): typing changes value but not name/role/bounds, so a
    // value-blind fingerprint made every successful type/fill look like "no
    // observable change" and fed false stagnation nudges (audit 2026-06-10,
    // finding D2). Secure fields carry value=undefined and stay excluded.
    const val = e.value ? crypto.createHash('sha1').update(e.value).digest('hex').slice(0, 8) : '';
    return `${role}|${name}|${cx}|${cy}|${val}`;
  });

  tokens.sort(); // order-insensitive

  const payload = (activeTitle ?? '') + '\n' + tokens.join('\n');
  return crypto.createHash('sha1').update(payload).digest('hex').slice(0, 16);
}

/**
 * A sliding history of recent fingerprints. Reports stagnation when the
 * last `n` fingerprints are identical.
 */
export class FingerprintHistory {
  private history: string[] = [];
  constructor(private readonly maxSize: number = 8) {}

  /** Append a new fingerprint. */
  push(fp: string): void {
    this.history.push(fp);
    if (this.history.length > this.maxSize) this.history.shift();
  }

  /** Stagnant if the last N entries are all equal and ≥ 2. */
  isStagnant(n: number = 2): boolean {
    if (this.history.length < n) return false;
    const tail = this.history.slice(-n);
    return tail.every(fp => fp === tail[0]);
  }

  /** Reset after a successful action so the agent gets a fresh window. */
  reset(): void {
    this.history = [];
  }

  /** Internal — for tests and telemetry. */
  getHistory(): string[] {
    return [...this.history];
  }
}
