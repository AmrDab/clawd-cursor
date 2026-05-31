/**
 * Verifier — paste/type tasks must not be false-rejected by the structural
 * hard-gate. Origin: run 7178b52e — "paste the copied sentence" SUCCEEDED
 * (Notepad 75→123 chars) but the verifier rejected it ("No pixel change after
 * click"), wasting blind→hybrid→vision. A paste changes the field VALUE, not
 * window/focus, and only a sub-threshold number of pixels — so the value-delta
 * is the real signal, not the structural vote.
 */
import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { GroundTruthVerifier } from '../core/verifier';
import type { StateSnapshot } from '../core/verifier-types';
import type { PlatformAdapter, UiElement } from '../platform/types';

function adapterStub(): PlatformAdapter { return {} as any; }
async function png(): Promise<Buffer> {
  return sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toBuffer();
}
function edit(value: string): UiElement {
  return { name: 'Text editor', controlType: 'Edit', bounds: { x: 0, y: 0, width: 1, height: 1 }, value } as UiElement;
}
function state(buf: Buffer, opts: { ocr?: string; clipboard?: string; focused?: UiElement | null }): StateSnapshot {
  return {
    timestamp: 1,
    screenshot: { buffer: buf, width: 64, height: 64, scaleFactor: 1 },
    windows: [{ title: 'Untitled - Notepad', processName: 'Notepad', processId: 1, bounds: { x: 0, y: 0, width: 64, height: 64 }, isMinimized: false }],
    activeWindow: { title: 'Untitled - Notepad', processName: 'Notepad', processId: 1, bounds: { x: 0, y: 0, width: 64, height: 64 }, isMinimized: false },
    focusedElement: opts.focused ?? null,
    ocrText: opts.ocr ?? '',
    clipboard: opts.clipboard ?? '',
  };
}

describe('verifier — paste/type not false-rejected', () => {
  const pasted = 'A notebook (also known as a notepad, writing pad';

  it('VERIFIES a paste: focused field value grew, same window/focus, tiny pixel diff', async () => {
    const v = new GroundTruthVerifier(adapterStub());
    const buf = await png(); // identical before/after screenshot → zero pixel change
    const before = state(buf, { focused: edit('Dogs are loyal...'), clipboard: pasted });
    const after = state(buf, { ocr: '', clipboard: pasted, focused: edit(`Dogs are loyal...${pasted}`) });
    const res = await v.verify({ task: 'paste the copied sentence into Notepad', before, after });
    expect(res.pass).toBe(true);
    const taskSig = res.signals.find(s => s.name === 'task_assertions')!;
    expect(taskSig.detail).toMatch(/\[type_text\]/);
    expect(taskSig.detail).toMatch(/text_entered=✓/);
  });

  it('VERIFIES a paste detected via clipboard text appearing in OCR', async () => {
    const v = new GroundTruthVerifier(adapterStub());
    const buf = await png();
    const before = state(buf, { focused: null, clipboard: pasted });
    const after = state(buf, { ocr: `Notepad ${pasted} ...`, clipboard: pasted, focused: null });
    const res = await v.verify({ task: 'paste the copied sentence', before, after });
    expect(res.pass).toBe(true);
  });

  it('REJECTS a paste that did nothing (no value growth, clipboard not visible)', async () => {
    const v = new GroundTruthVerifier(adapterStub());
    const buf = await png();
    const before = state(buf, { focused: edit('Dogs are loyal...'), clipboard: pasted });
    const after = state(buf, { ocr: 'Dogs are loyal...', clipboard: pasted, focused: edit('Dogs are loyal...') });
    const res = await v.verify({ task: 'paste the copied sentence', before, after });
    expect(res.pass).toBe(false); // no text_entered evidence + no structural change
  });

  it('a FAILED text assertion does not override structural success (no regression)', async () => {
    // "type a sentence about X" — the literal extractor misfires (looks for the
    // instruction phrase). That failed assertion must NOT hard-fail the task;
    // it falls back to the structural vote. Here multiple structural signals
    // fire (new doc: window + focus + pixel), so it verifies as before.
    const v = new GroundTruthVerifier(adapterStub());
    const beforeBuf = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toBuffer();
    const afterBuf = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer();
    const before: StateSnapshot = {
      timestamp: 1, screenshot: { buffer: beforeBuf, width: 64, height: 64, scaleFactor: 1 },
      windows: [{ title: 'Start', processName: 'explorer', processId: 9, bounds: { x: 0, y: 0, width: 1, height: 1 }, isMinimized: false }],
      activeWindow: { title: 'Start', processName: 'explorer', processId: 9, bounds: { x: 0, y: 0, width: 1, height: 1 }, isMinimized: false },
      focusedElement: null, ocrText: '', clipboard: '',
    };
    const after = state(afterBuf, { ocr: 'Dogs are great', focused: edit('Dogs are loyal and loving') });
    const res = await v.verify({ task: 'type a sentence about dogs', before, after });
    // window changed (explorer→Notepad) + focus changed + pixel changed → passes
    expect(res.pass).toBe(true);
  });
});
