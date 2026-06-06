/**
 * Coordinate-space scaling — the fix for hybrid clicks landing on the wrong
 * window. On a 2560-wide screen the screenshot is 1280px, so image-space coords
 * must be ×2 to reach the screen; a11y/screen coords pass through unchanged.
 *
 * Verifies both the pure scale helper and the granular `click` tool's `space`
 * behavior end-to-end with a mock adapter (OS-agnostic).
 */
import { describe, it, expect, vi } from 'vitest';
import { imageScale, scaleCoord, LLM_TARGET_WIDTH } from '../core/agent-loop/coord-scale';
import { buildUnifiedTools } from '../core/agent-loop/tools';
import type { AgentToolContext } from '../core/agent-loop/types';

describe('imageScale / scaleCoord', () => {
  it('scales by physicalWidth/1280 when the screen is wider than the screenshot', () => {
    expect(imageScale({ screen: { physicalWidth: 2560 } })).toBe(2);
    expect(imageScale({ screen: { physicalWidth: 3840 } })).toBe(3);
  });
  it('is 1 when the screen is no wider than the screenshot', () => {
    expect(imageScale({ screen: { physicalWidth: 1280 } })).toBe(1);
    expect(imageScale({ screen: { physicalWidth: 1024 } })).toBe(1);
    expect(imageScale({ screen: {} })).toBe(1);
  });
  it('LLM_TARGET_WIDTH is the 1280 screenshot width', () => {
    expect(LLM_TARGET_WIDTH).toBe(1280);
  });
  it('scaleCoord rounds', () => {
    expect(scaleCoord(1107, 2)).toBe(2214);
    expect(scaleCoord(100.4, 1)).toBe(100);
  });
});

function makeCtx(clicks: Array<{ x: number; y: number }>): AgentToolContext {
  return {
    platform: {
      platform: 'win32',
      mouseClick: vi.fn((x: number, y: number) => { clicks.push({ x, y }); return Promise.resolve(); }),
      getActiveWindow: vi.fn(() => Promise.resolve({ title: 'Edge', processName: 'msedge', processId: 1, bounds: { x: 0, y: 0, width: 1, height: 1 }, isMinimized: false })),
    } as any,
    task: 't',
    mode: 'hybrid',
    screen: { logicalWidth: 2560, logicalHeight: 1440, physicalWidth: 2560, physicalHeight: 1440, dpiRatio: 1 },
    screenshotsCaptured: { n: 0 },
  };
}

describe('click tool coordinate space', () => {
  const click = buildUnifiedTools().find(t => t.name === 'click')!;

  it('space:"image" scales screenshot coords to physical (1107 → 2214)', async () => {
    const clicks: Array<{ x: number; y: number }> = [];
    const r = await click.execute({ x: 1107, y: 423, space: 'image' }, makeCtx(clicks));
    expect(r.success).toBe(true);
    expect(clicks[0]).toEqual({ x: 2214, y: 846 });
    expect(r.text).toMatch(/image \(1107,423\)/);
    expect(r.text).toMatch(/×2/);
  });

  it('default (screen) passes a11y coords through unchanged', async () => {
    const clicks: Array<{ x: number; y: number }> = [];
    await click.execute({ x: 1107, y: 423 }, makeCtx(clicks));
    expect(clicks[0]).toEqual({ x: 1107, y: 423 });
  });

  it('result text carries a focus breadcrumb when focus changes', async () => {
    const clicks: Array<{ x: number; y: number }> = [];
    // before window = Terminal, after = Edge → breadcrumb shows the change
    const ctx = makeCtx(clicks);
    let n = 0;
    (ctx.platform.getActiveWindow as any) = vi.fn(() =>
      Promise.resolve({ title: n++ === 0 ? 'Terminal' : 'Edge', processName: 'x', processId: 1, bounds: { x: 0, y: 0, width: 1, height: 1 }, isMinimized: false }));
    const r = await click.execute({ x: 100, y: 100 }, ctx);
    expect(r.text).toMatch(/focus "Terminal"→"Edge"/);
  });
});
