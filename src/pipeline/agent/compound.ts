/**
 * Compound tools for the vision agent.
 *
 * The vision LLM (mode: 'vision') sees three COMPOUND tools that
 * collapse ~22 granular mouse/keyboard/window primitives into 3
 * action-discriminated schemas — mirroring Anthropic's
 * `computer_20250124` shape where the model picks an `action` from a
 * fixed enum plus a flat arg bag.
 *
 * Why compound for vision, palettes for text:
 *   - The vision agent operates turn-to-turn on pixels and may need
 *     ANY primitive at ANY step (click, move, drag, scroll, type).
 *     Scoping by capability doesn't apply — the model has to be free
 *     to pick whatever's needed based on what it sees.
 *   - BUT shipping 22 separate tool schemas inflates the catalog
 *     token cost (~6000 tokens for mouse+kbd+window alone) and
 *     distracts the model with near-duplicates.
 *   - Compound tools collapse that to ~900 tokens and present the
 *     model with a tighter decision tree (pick a category first,
 *     then an action).
 *
 * The compound tools dispatch internally to the same underlying
 * PlatformAdapter methods the granular tools use. Safety-gating
 * happens before dispatch via `safety.evaluate()` unpacking the
 * compound name + action into a canonical tier key (see
 * `safety/layer.ts`).
 */

import type { UnifiedTool, UnifiedToolResult, AgentToolContext } from './types';

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// ─── MOUSE compound ────────────────────────────────────────────────

const MOUSE_ACTIONS = [
  'click', 'double_click', 'right_click', 'middle_click', 'triple_click',
  'move', 'move_relative', 'hover', 'down', 'up',
  'scroll', 'drag', 'drag_stepped',
] as const;

export const mouseCompound: UnifiedTool = {
  name: 'mouse',
  description:
    'All mouse operations. Set `action` + the relevant coordinate/button args. ' +
    'Use for: click (x,y), drag (startX,startY,endX,endY), scroll (x,y,direction,amount), ' +
    'move (x,y), move_relative (dx,dy), down/up (button). Coordinates are image-space pixels.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [...MOUSE_ACTIONS],
        description: 'Which mouse operation. Pick ONE.',
      },
      x: { type: 'number', description: 'X (image-space) — for click/move/hover/scroll/down/up' },
      y: { type: 'number', description: 'Y (image-space)' },
      dx: { type: 'number', description: 'Relative X — for move_relative' },
      dy: { type: 'number', description: 'Relative Y — for move_relative' },
      button: {
        type: 'string', enum: ['left', 'right', 'middle'],
        description: 'Button for down/up (default: left)',
      },
      direction: {
        type: 'string', enum: ['up', 'down', 'left', 'right'],
        description: 'Direction for scroll',
      },
      amount: { type: 'number', description: 'Wheel ticks for scroll (default 3)' },
      startX: { type: 'number', description: 'Drag start X' },
      startY: { type: 'number', description: 'Drag start Y' },
      endX: { type: 'number', description: 'Drag end X' },
      endY: { type: 'number', description: 'Drag end Y' },
      path: { type: 'string', description: 'JSON array of {x,y} points for drag_stepped' },
    },
    required: ['action'],
    additionalProperties: false,
  },
  changesScreen: true,
  async execute(args, ctx): Promise<UnifiedToolResult> {
    const action = String(args.action ?? '');
    const x = typeof args.x === 'number' ? args.x : 0;
    const y = typeof args.y === 'number' ? args.y : 0;
    const btn = (args.button as 'left' | 'right' | 'middle') ?? 'left';

    switch (action) {
      case 'click':
        await ctx.platform.mouseClick(x, y, { button: btn });
        await sleep(150);
        return { success: true, text: `Clicked ${btn} at (${x}, ${y})` };
      case 'double_click':
        await ctx.platform.mouseClick(x, y, { button: 'left', count: 2 });
        await sleep(150);
        return { success: true, text: `Double-clicked at (${x}, ${y})` };
      case 'right_click':
        await ctx.platform.mouseClick(x, y, { button: 'right' });
        await sleep(150);
        return { success: true, text: `Right-clicked at (${x}, ${y})` };
      case 'middle_click':
        await ctx.platform.mouseClick(x, y, { button: 'middle' });
        await sleep(150);
        return { success: true, text: `Middle-clicked at (${x}, ${y})` };
      case 'triple_click':
        await ctx.platform.mouseClick(x, y, { button: 'left', count: 3 });
        await sleep(150);
        return { success: true, text: `Triple-clicked at (${x}, ${y})` };
      case 'move':
      case 'hover':
        await ctx.platform.mouseMove(x, y);
        return { success: true, text: `Moved cursor to (${x}, ${y})` };
      case 'move_relative': {
        const dx = typeof args.dx === 'number' ? args.dx : 0;
        const dy = typeof args.dy === 'number' ? args.dy : 0;
        await ctx.platform.mouseMoveRelative(dx, dy);
        return { success: true, text: `Cursor moved by (${dx}, ${dy})` };
      }
      case 'down':
        await ctx.platform.mouseDown(btn);
        return { success: true, text: `Mouse ${btn} down` };
      case 'up':
        await ctx.platform.mouseUp(btn);
        return { success: true, text: `Mouse ${btn} up` };
      case 'scroll': {
        const dir = (args.direction as 'up' | 'down' | 'left' | 'right') ?? 'down';
        const amount = typeof args.amount === 'number' ? args.amount : 3;
        await ctx.platform.mouseScroll(x, y, dir, amount);
        return { success: true, text: `Scrolled ${dir} ${amount} at (${x}, ${y})` };
      }
      case 'drag': {
        const sx = typeof args.startX === 'number' ? args.startX : 0;
        const sy = typeof args.startY === 'number' ? args.startY : 0;
        const ex = typeof args.endX === 'number' ? args.endX : 0;
        const ey = typeof args.endY === 'number' ? args.endY : 0;
        await ctx.platform.mouseDrag(sx, sy, ex, ey);
        await sleep(200);
        return { success: true, text: `Dragged (${sx},${sy})→(${ex},${ey})` };
      }
      case 'drag_stepped': {
        let points: Array<{ x: number; y: number }>;
        try { points = JSON.parse(String(args.path ?? '[]')); }
        catch { return { success: false, text: 'drag_stepped: path must be JSON array of {x,y}' }; }
        if (!Array.isArray(points) || points.length < 2) {
          return { success: false, text: 'drag_stepped: need at least 2 points' };
        }
        await ctx.platform.mouseMove(points[0].x, points[0].y);
        await ctx.platform.mouseDown('left');
        try {
          for (let i = 1; i < points.length; i++) {
            await ctx.platform.mouseMove(points[i].x, points[i].y);
            await sleep(16);
          }
        } finally {
          await ctx.platform.mouseUp('left');
        }
        return { success: true, text: `Stepped-drag through ${points.length} points` };
      }
      default:
        return { success: false, text: `mouse: unknown action "${action}"` };
    }
  },
};

// ─── KEYBOARD compound ─────────────────────────────────────────────

const KEYBOARD_ACTIONS = ['press', 'down', 'up', 'type'] as const;

export const keyboardCompound: UnifiedTool = {
  name: 'keyboard',
  description:
    'All keyboard operations. `press` sends a key combo ("mod+s", "Return", "F5"). ' +
    '`type` types free text into the focused field. `down`/`up` hold/release keys for ' +
    'modifier-click chords. Use "mod" for the platform-correct modifier.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [...KEYBOARD_ACTIONS], description: 'Which keyboard operation.' },
      key: { type: 'string', description: 'Key combo for press/down/up (e.g. "mod+s", "shift", "Return")' },
      text: { type: 'string', description: 'Text to type (for action=type)' },
    },
    required: ['action'],
    additionalProperties: false,
  },
  changesScreen: true,
  async execute(args, ctx): Promise<UnifiedToolResult> {
    const action = String(args.action ?? '');
    switch (action) {
      case 'press': {
        const k = String(args.key ?? '');
        if (!k) return { success: false, text: 'keyboard.press: key is required' };
        await ctx.platform.keyPress(k);
        await sleep(120);
        return { success: true, text: `Pressed ${k}` };
      }
      case 'down': {
        const k = String(args.key ?? '');
        if (!k) return { success: false, text: 'keyboard.down: key is required' };
        await ctx.platform.keyDown(k);
        return { success: true, text: `Key down: ${k}` };
      }
      case 'up': {
        const k = String(args.key ?? '');
        if (!k) return { success: false, text: 'keyboard.up: key is required' };
        await ctx.platform.keyUp(k);
        return { success: true, text: `Key up: ${k}` };
      }
      case 'type': {
        const text = String(args.text ?? '');
        if (!text) return { success: false, text: 'keyboard.type: text is required' };
        await ctx.platform.typeText(text);
        await sleep(150);
        return { success: true, text: `Typed ${text.length} chars: "${truncate(text, 60)}"` };
      }
      default:
        return { success: false, text: `keyboard: unknown action "${action}"` };
    }
  },
};

// ─── WINDOW compound ───────────────────────────────────────────────

const WINDOW_ACTIONS = [
  'focus', 'maximize', 'minimize', 'restore', 'close', 'resize', 'list', 'list_displays',
] as const;

export const windowCompound: UnifiedTool = {
  name: 'window',
  description:
    'All window operations. `focus` brings a window to front. `maximize`/`minimize`/' +
    '`restore`/`close` change state. `resize` sets logical-pixel bounds. `list` enumerates ' +
    'top-level windows. `list_displays` enumerates monitors. Target via processName/processId/title.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [...WINDOW_ACTIONS], description: 'Which window operation.' },
      processName: { type: 'string' },
      processId: { type: 'number' },
      title: { type: 'string', description: 'Title substring match' },
      x: { type: 'number', description: 'Resize: new X (logical px)' },
      y: { type: 'number', description: 'Resize: new Y' },
      width: { type: 'number', description: 'Resize: new width' },
      height: { type: 'number', description: 'Resize: new height' },
    },
    required: ['action'],
    additionalProperties: false,
  },
  changesScreen: true,
  async execute(args, ctx): Promise<UnifiedToolResult> {
    const action = String(args.action ?? '');
    const q: { processName?: string; processId?: number; title?: string } = {};
    if (typeof args.processName === 'string') q.processName = args.processName;
    if (typeof args.processId === 'number') q.processId = args.processId;
    if (typeof args.title === 'string') q.title = args.title;
    const query = Object.keys(q).length ? q : undefined;

    switch (action) {
      case 'focus': {
        const ok = await ctx.platform.focusWindow(query ?? {});
        await sleep(250);
        return { success: ok, text: ok ? 'Focused window.' : 'No matching window.' };
      }
      case 'maximize': {
        const ok = await ctx.platform.setWindowState('maximize', query);
        return { success: ok, text: ok ? 'Maximized.' : 'Maximize failed.' };
      }
      case 'minimize': {
        const ok = await ctx.platform.setWindowState('minimize', query);
        return { success: ok, text: ok ? 'Minimized.' : 'Minimize failed.' };
      }
      case 'restore': {
        const ok = await ctx.platform.setWindowState('normal', query);
        return { success: ok, text: ok ? 'Restored.' : 'Restore failed.' };
      }
      case 'close': {
        const ok = await ctx.platform.setWindowState('close', query);
        return {
          success: ok,
          text: ok ? 'Close request posted (app may prompt).' : 'Close failed.',
          targetLabel: 'close',
        };
      }
      case 'resize': {
        const ok = await ctx.platform.setWindowBounds({
          x: typeof args.x === 'number' ? args.x : undefined,
          y: typeof args.y === 'number' ? args.y : undefined,
          width: typeof args.width === 'number' ? args.width : undefined,
          height: typeof args.height === 'number' ? args.height : undefined,
        }, query);
        return { success: ok, text: ok ? 'Resized.' : 'Resize failed.' };
      }
      case 'list': {
        const windows = await ctx.platform.listWindows();
        const lines = windows.slice(0, 20).map(w =>
          `[${w.processName}] "${w.title}" pid=${w.processId} ${w.bounds.width}×${w.bounds.height}`,
        );
        return { success: true, text: `Windows (${windows.length}):\n${lines.join('\n')}` };
      }
      case 'list_displays': {
        const displays = await ctx.platform.listDisplays();
        return { success: true, text: JSON.stringify(displays) };
      }
      default:
        return { success: false, text: `window: unknown action "${action}"` };
    }
  },
};

/**
 * Tool names that the compound forms replace. The agent catalog
 * removes these when serving vision mode, since the compound tools
 * subsume them.
 */
export const COMPOUND_REPLACES = new Set<string>([
  // mouse
  'click', 'drag', 'scroll',
  'mouse_move_relative', 'mouse_down', 'mouse_up',
  // keyboard
  'type', 'key', 'key_down', 'key_up', 'undo_last',
  // window
  'focus_window', 'maximize_window', 'minimize_window',
  'restore_window', 'close_window', 'resize_window',
  'list_windows', 'list_displays',
]);

export function getCompoundTools(): UnifiedTool[] {
  return [mouseCompound, keyboardCompound, windowCompound];
}
