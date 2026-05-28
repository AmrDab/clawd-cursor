/**
 * Vision-palette coordinate-scaling regression (live-test bug, 2026-05-28).
 *
 * In vision mode the model only sees a screenshot downsampled to <=1280px
 * wide, so it returns IMAGE-space coordinates. The platform mouse layer
 * expects REAL screen pixels. The `mouse` compound tool used to pass the
 * image coords straight through — so on a 2× display a click meant for the
 * button at image (649,546) landed at screen (649,546), i.e. 1/2 of the way
 * to the target, hitting whatever window was there. Two live runs against the
 * exam interface burned 16–18 vision turns fighting this before the model
 * worked around it by manually doubling.
 *
 * The fix mirrors what the MCP `mouse_click` path already does via
 * getMouseScaleFactor(): image × (physicalWidth / min(physicalWidth,1280)).
 * This test pins that contract so a regression fails immediately.
 */

import { describe, it, expect, vi } from 'vitest';
import { getCompoundTools } from '../core/agent-loop/compound';
import type { AgentToolContext } from '../core/agent-loop/types';

interface Captured { fn: string; args: number[] }

function makeCtx(physicalWidth: number, captured: Captured[]): AgentToolContext {
  const rec = (fn: string) => (...args: any[]) => {
    captured.push({ fn, args: args.filter((a) => typeof a === 'number') });
    return Promise.resolve();
  };
  return {
    platform: {
      mouseClick: vi.fn(rec('click')),
      mouseMove: vi.fn(rec('move')),
      mouseMoveRelative: vi.fn(rec('move_relative')),
      mouseScroll: vi.fn(rec('scroll')),
      mouseDrag: vi.fn(rec('drag')),
      mouseDown: vi.fn(async () => {}),
      mouseUp: vi.fn(async () => {}),
    } as any,
    task: 'test',
    mode: 'vision',
    screen: {
      logicalWidth: physicalWidth, logicalHeight: 0,
      physicalWidth, physicalHeight: 0, dpiRatio: 1,
    },
    screenshotsCaptured: { n: 0 },
  };
}

function mouseTool() {
  const t = getCompoundTools().find((x) => x.name === 'mouse');
  if (!t) throw new Error('mouse compound tool not found');
  return t;
}

describe('vision palette image→screen coordinate scaling', () => {
  it('scales click coords by physicalWidth/1280 on a 2× display', async () => {
    const cap: Captured[] = [];
    const ctx = makeCtx(2560, cap); // 2560 / 1280 = 2.0×
    await mouseTool().execute({ action: 'click', x: 649, y: 546 }, ctx);
    expect(cap).toEqual([{ fn: 'click', args: [1298, 1092] }]);
  });

  it('passes coords through unchanged when the screen is <=1280 wide', async () => {
    const cap: Captured[] = [];
    const ctx = makeCtx(1280, cap); // scale 1.0
    await mouseTool().execute({ action: 'click', x: 640, y: 360 }, ctx);
    expect(cap).toEqual([{ fn: 'click', args: [640, 360] }]);
  });

  it('scales scroll and drag coordinates too', async () => {
    const cap: Captured[] = [];
    const ctx = makeCtx(2560, cap);
    await mouseTool().execute({ action: 'scroll', x: 100, y: 200, direction: 'down', amount: 3 }, ctx);
    await mouseTool().execute({ action: 'drag', startX: 10, startY: 20, endX: 30, endY: 40 }, ctx);
    expect(cap[0]).toEqual({ fn: 'scroll', args: [200, 400, 3] });
    expect(cap[1]).toEqual({ fn: 'drag', args: [20, 40, 60, 80] });
  });

  it('reports the image-space coords the model passed (not the scaled ones)', async () => {
    const cap: Captured[] = [];
    const ctx = makeCtx(2560, cap);
    const res = await mouseTool().execute({ action: 'click', x: 649, y: 546 }, ctx);
    // The model thinks in image space; echoing screen coords would confuse it.
    expect(res.text).toContain('(649, 546)');
  });
});
