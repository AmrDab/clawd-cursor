/**
 * read_text + smart_click in the agent-loop catalog — the cheap haiku-perception
 * path for webviews/canvases (OCR, no vision model). The OcrEngine is mocked so
 * these run OS-agnostically.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the OcrEngine the tools import.
const ocrState: { available: boolean; elements: any[] } = { available: true, elements: [] };
vi.mock('../platform/ocr-engine', () => ({
  OcrEngine: class {
    isAvailable() { return ocrState.available; }
    invalidateCache() {}
    async recognizeScreen() { return { elements: ocrState.elements, fullText: '', durationMs: 12 }; }
  },
}));

import { buildUnifiedTools } from '../core/agent-loop/tools';
import type { AgentToolContext } from '../core/agent-loop/types';

const el = (text: string, x: number, y: number, line: number, w = 60, h = 20) =>
  ({ text, x, y, width: w, height: h, confidence: 1, line });

function ctx(clicks: any[]): AgentToolContext {
  return {
    platform: {
      platform: 'win32',
      getActiveWindow: vi.fn(async () => ({ title: 'Edge', processName: 'msedge', processId: 1, bounds: { x: 0, y: 0, width: 1, height: 1 }, isMinimized: false })),
      focusWindow: vi.fn(async () => true),
      mouseClick: vi.fn(async (x: number, y: number) => { clicks.push({ x, y }); }),
    } as any,
    task: 't', mode: 'blind',
    screen: { logicalWidth: 2560, logicalHeight: 1440, physicalWidth: 2560, physicalHeight: 1440, dpiRatio: 1 },
    screenshotsCaptured: { n: 0 },
  };
}
const tool = (name: string) => buildUnifiedTools().find(t => t.name === name)!;

beforeEach(() => { ocrState.available = true; ocrState.elements = []; });

describe('read_text (OCR perception, no screenshot)', () => {
  it('returns visible text grouped by line, does not increment screenshot budget', async () => {
    ocrState.elements = [el('Search', 100, 50, 0), el('YouTube', 170, 50, 0), el('Uptown', 100, 120, 1), el('Funk', 170, 120, 1)];
    const c = ctx([]);
    const r = await tool('read_text').execute({}, c);
    expect(r.success).toBe(true);
    expect(r.text).toMatch(/Search YouTube/);
    expect(r.text).toMatch(/Uptown Funk/);
    expect(c.screenshotsCaptured.n).toBe(0);     // OCR is NOT a screenshot
    expect(tool('read_text').changesScreen).toBe(false);
  });
  it('filter keeps only matching lines', async () => {
    ocrState.elements = [el('Search', 100, 50, 0), el('Uptown Funk', 100, 120, 1)];
    const r = await tool('read_text').execute({ filter: 'uptown' }, ctx([]));
    expect(r.text).toMatch(/Uptown/);
    expect(r.text).not.toMatch(/Search/);
  });
  it('reports gracefully when OCR is unavailable', async () => {
    ocrState.available = false;
    const r = await tool('read_text').execute({}, ctx([]));
    expect(r.success).toBe(false);
    expect(r.text).toMatch(/not available/i);
  });
});

describe('smart_click (OCR-locate + click by visible text)', () => {
  it('clicks the center of the matched text span (screen coords, no scaling)', async () => {
    // "Uptown Funk" spans x=100..230 (100+60 and 170+60), y=120..140 → center (165,130)
    ocrState.elements = [el('Uptown', 100, 120, 0), el('Funk', 170, 120, 0)];
    const clicks: any[] = [];
    const r = await tool('smart_click').execute({ target: 'Uptown Funk' }, ctx(clicks));
    expect(r.success).toBe(true);
    expect(clicks[0]).toEqual({ x: 165, y: 130 });
    expect(r.text).toMatch(/Uptown Funk/);
  });
  it('does not click when no text matches (tells the model to read_text)', async () => {
    ocrState.elements = [el('Something Else', 100, 50, 0)];
    const clicks: any[] = [];
    const r = await tool('smart_click').execute({ target: 'Sign in' }, ctx(clicks));
    expect(r.success).toBe(false);
    expect(clicks).toHaveLength(0);
    expect(r.text).toMatch(/read_text|no match/i);
  });
  it('prefers the full "Begin Exam" button over the bare word "begin" in body text', async () => {
    ocrState.elements = [
      el('Please', 50, 30, 0), el('begin', 120, 30, 0), el('when', 180, 30, 0), el('ready', 240, 30, 0),
      el('Begin', 400, 300, 5), el('Exam', 470, 300, 5),
    ];
    const clicks: any[] = [];
    await tool('smart_click').execute({ target: 'Begin Exam' }, ctx(clicks));
    // Should hit the button row (y≈310), not the body "begin" (y≈40)
    expect(clicks[0].y).toBeGreaterThan(200);
  });
});
