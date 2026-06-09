import { describe, it, expect } from 'vitest';
import { buildUnifiedTools } from '../core/agent-loop/tools';
import type { AgentToolContext } from '../core/agent-loop/types';
import type { PlatformAdapter } from '../platform/types';

function ctx(over: Partial<AgentToolContext> = {}): AgentToolContext {
  const adapter = {
    getActiveWindow: async () => ({ processId: 1, processName: 'paint', title: 'Untitled - Paint', bounds: { x: 0, y: 0, width: 2560, height: 1440 } }),
    moveMouse: async () => {},
    mouseDown: async () => {},
    mouseUp: async () => {},
    drag: async () => {},
    mouseDrag: async () => {},
  } as unknown as PlatformAdapter;
  return {
    platform: adapter,
    task: 't',
    screen: { logicalWidth: 2560, logicalHeight: 1440, physicalWidth: 2560, physicalHeight: 1440, dpiRatio: 1 },
    screenshotsCaptured: { n: 0 },
    ...over,
  } as unknown as AgentToolContext;
}

const getDrag = () => buildUnifiedTools().find(t => t.name === 'drag')!;

describe('coordinate tools honor ctx.coordSpaceDefault', () => {
  it('drag without space defaults to IMAGE when coordSpaceDefault=image (scales ×2 on a 2560/1280 screen)', async () => {
    const r = await getDrag().execute({ startX: 640, startY: 250, endX: 680, endY: 250 }, ctx({ coordSpaceDefault: 'image' }));
    // image-space: scale = physicalWidth/1280 = 2560/1280 = 2; 640*2=1280, 250*2=500
    expect(r.text).toMatch(/image \(640,250\).*→ screen \(1280,500\)/);
    expect(r.text).toMatch(/\[×2\]/);
  });

  it('drag without space defaults to SCREEN when coordSpaceDefault is unset (back-compat)', async () => {
    const r = await getDrag().execute({ startX: 640, startY: 250, endX: 680, endY: 250 }, ctx());
    // screen-space: scale=1, coords pass through
    expect(r.text).toMatch(/screen \(640,250\)/);
    expect(r.text).toMatch(/\[×1\]/);
  });

  it('explicit space:"screen" wins even when coordSpaceDefault=image', async () => {
    const r = await getDrag().execute({ startX: 640, startY: 250, endX: 680, endY: 250, space: 'screen' }, ctx({ coordSpaceDefault: 'image' }));
    expect(r.text).toMatch(/screen \(640,250\)/);
    expect(r.text).toMatch(/\[×1\]/);
  });
});
