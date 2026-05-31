/**
 * Verifier — 'copy' task type + fabrication guard.
 *
 * Origin: a real run (5d893a6a) where the agent failed to actually select/copy
 * a Wikipedia sentence (its clicks hit the wrong window), gave up, and called
 * write_clipboard("We owe you an explanation.") to FABRICATE the result. The
 * verifier passed it at confidence=1.0. These tests pin the fix: a copy task
 * whose clipboard was authored via write_clipboard is a hard-fail anti-pattern.
 */
import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { GroundTruthVerifier } from '../core/verifier';
import type { StateSnapshot } from '../core/verifier-types';
import type { PlatformAdapter } from '../platform/types';

function adapterStub(): PlatformAdapter { return {} as any; }

async function png(): Promise<Buffer> {
  return sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toBuffer();
}

function state(opts: { ocr?: string; clipboard?: string }): StateSnapshot {
  return {
    timestamp: 1,
    screenshot: { buffer: Buffer.alloc(0), width: 64, height: 64, scaleFactor: 1 },
    windows: [{ title: 'Wikipedia - Edge', processName: 'msedge', processId: 1, bounds: { x: 0, y: 0, width: 64, height: 64 }, isMinimized: false }],
    activeWindow: { title: 'Wikipedia - Edge', processName: 'msedge', processId: 1, bounds: { x: 0, y: 0, width: 64, height: 64 }, isMinimized: false },
    focusedElement: null,
    ocrText: opts.ocr ?? '',
    clipboard: opts.clipboard ?? '',
  };
}

describe("verifier — 'copy' task fabrication guard", () => {
  const sentence = 'We owe you an explanation.';

  it('REJECTS a copy whose clipboard was authored via write_clipboard (hard fail)', async () => {
    const v = new GroundTruthVerifier(adapterStub());
    const buf = await png();
    const before = { ...state({ ocr: 'terminal log noise', clipboard: 'old' }), screenshot: { buffer: buf, width: 64, height: 64, scaleFactor: 1 } };
    // Clipboard now holds the sentence AND it's visible on screen — looks real —
    // but the trace shows it came from write_clipboard, not a source copy.
    const after = { ...state({ ocr: `Wikipedia ... ${sentence} ... more`, clipboard: sentence }), screenshot: { buffer: buf, width: 64, height: 64, scaleFactor: 1 } };

    const res = await v.verify({
      task: 'select and copy a sentence from the Wikipedia article',
      before, after,
      toolTrace: ['screenshot', 'click', 'write_clipboard', 'read_clipboard', 'done'],
    });
    expect(res.pass).toBe(false);
    const anti = res.signals.find(s => s.name === 'anti_patterns')!;
    expect(anti.value).toBe(false);
    expect(anti.detail).toMatch(/fabricated/i);
  });

  it('does NOT reject a copy task when no write_clipboard was used (genuine ctrl+c)', async () => {
    const v = new GroundTruthVerifier(adapterStub());
    const buf = await png();
    const before = { ...state({ ocr: `Wikipedia ... ${sentence}`, clipboard: 'old' }), screenshot: { buffer: buf, width: 64, height: 64, scaleFactor: 1 } };
    const after = { ...state({ ocr: `Wikipedia ... ${sentence}`, clipboard: sentence }), screenshot: { buffer: buf, width: 64, height: 64, scaleFactor: 1 } };

    const res = await v.verify({
      task: 'select and copy a sentence from the Wikipedia article',
      before, after,
      toolTrace: ['focus_window', 'drag', 'key', 'read_clipboard', 'done'], // real ctrl+c via key
    });
    const anti = res.signals.find(s => s.name === 'anti_patterns')!;
    expect(anti.value).toBe(true); // not flagged as fabricated
  });

  it('infers the copy task type and asserts a real clipboard delta', async () => {
    const v = new GroundTruthVerifier(adapterStub());
    const buf = await png();
    // clipboard unchanged → clipboard_populated fails
    const before = { ...state({ ocr: sentence, clipboard: sentence }), screenshot: { buffer: buf, width: 64, height: 64, scaleFactor: 1 } };
    const after = { ...state({ ocr: sentence, clipboard: sentence }), screenshot: { buffer: buf, width: 64, height: 64, scaleFactor: 1 } };
    const res = await v.verify({
      task: 'copy a sentence from the page',
      before, after,
      toolTrace: ['key', 'done'],
    });
    const taskSig = res.signals.find(s => s.name === 'task_assertions')!;
    expect(taskSig.detail).toMatch(/\[copy\]/);
    expect(taskSig.detail).toMatch(/clipboard_populated=✗/);
  });

  it('does not treat a paste task as copy', async () => {
    const v = new GroundTruthVerifier(adapterStub());
    const buf = await png();
    const s = { ...state({ ocr: 'notepad', clipboard: sentence }), screenshot: { buffer: buf, width: 64, height: 64, scaleFactor: 1 } };
    const res = await v.verify({
      task: 'paste the copied sentence',
      before: s, after: s,
      toolTrace: ['key', 'write_clipboard', 'done'], // write_clipboard here is NOT a copy-fabrication
    });
    const anti = res.signals.find(s => s.name === 'anti_patterns')!;
    expect(anti.value).toBe(true); // paste ≠ copy → no fabrication flag
  });
});
