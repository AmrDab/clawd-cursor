/**
 * Accessibility & window management tools.
 *
 * Text-first strategy: always try read_screen before desktop_screenshot.
 * Provides structured perception of the desktop without vision models.
 */

import type { ToolDefinition, ToolContext } from './types';
import { a11yToMouse } from './types';
import type { UiElement, WindowInfo } from '../v2/platform/types';

function formatWindow(w: WindowInfo): string {
  return `${w.isMinimized ? '[MIN]' : '[OK]'} [${w.processName}] "${w.title}" pid:${w.processId}` +
    (!w.isMinimized ? ` at (${w.bounds.x},${w.bounds.y}) ${w.bounds.width}x${w.bounds.height}` : ' (minimized)');
}

function formatElement(el: UiElement): string {
  return `[${el.controlType}] "${el.name}"` +
    (el.automationId ? ` id:${el.automationId}` : '') +
    ` @${el.bounds.x},${el.bounds.y} ${el.bounds.width}x${el.bounds.height}` +
    (el.disabled || el.enabled === false ? ' DISABLED' : '') +
    (el.focused ? ' FOCUSED' : '');
}

async function getActivePid(ctx: ToolContext, processId?: number): Promise<number | undefined> {
  if (typeof processId === 'number') return processId;
  if (ctx.platform) return (await ctx.platform.getActiveWindow())?.processId;
  return (await ctx.a11y.getActiveWindow())?.processId;
}

export function getA11yTools(): ToolDefinition[] {
  return [
    {
      name: 'read_screen',
      description: 'Read the accessibility tree of the screen. Returns structured text showing: WINDOWS (all open windows), FOCUSED WINDOW UI TREE (buttons, inputs, text elements with coordinates), and FOCUSED ELEMENT (keyboard focus). This is fast, small, and structured — prefer this over screenshots.',
      parameters: {
        processId: { type: 'number', description: 'Focus on a specific process ID (optional — reads foreground window by default)', required: false },
      },
      category: 'perception',
      handler: async ({ processId }, ctx) => {
        await ctx.ensureInitialized();
        if (ctx.platform) {
          const [windows, activeWindow, focused] = await Promise.all([
            ctx.platform.listWindows().catch(() => []),
            ctx.platform.getActiveWindow().catch(() => null),
            ctx.platform.getFocusedElement().catch(() => null),
          ]);
          const active = processId ?? activeWindow?.processId;
          const tree = await ctx.platform.getUiTree(active);
          const sections = [
            'WINDOWS',
            windows.length ? windows.map(formatWindow).join('\n') : '(no windows found)',
            '',
            'FOCUSED WINDOW UI TREE',
            tree.length ? tree.slice(0, 200).map(formatElement).join('\n') : '(no elements found)',
            '',
            'FOCUSED ELEMENT',
            focused ? formatElement(focused) : '(no focused element)',
          ];
          return { text: sections.join('\n') };
        }
        const active = await getActivePid(ctx, processId);
        const context = await ctx.a11y.getScreenContext(active);
        return { text: context };
      },
    },

    {
      name: 'get_windows',
      description: 'List all visible windows with their title, process name, PID, and bounds.',
      parameters: {},
      category: 'window',
      handler: async (_params, ctx) => {
        await ctx.ensureInitialized();
        if (ctx.platform) {
          const windows = await ctx.platform.listWindows();
          if (!windows?.length) return { text: '(no windows found)' };
          return { text: windows.map(formatWindow).join('\n') };
        }
        const windows = await ctx.a11y.getWindows(true);
        if (!windows?.length) return { text: '(no windows found)' };
        const lines = windows.map((w: any) => formatWindow(w));
        return { text: lines.join('\n') };
      },
    },

    {
      name: 'get_active_window',
      description: 'Get the currently focused/foreground window.',
      parameters: {},
      category: 'window',
      handler: async (_params, ctx) => {
        await ctx.ensureInitialized();
        if (ctx.platform) {
          const win = await ctx.platform.getActiveWindow();
          if (!win) return { text: '(no active window)' };
          return { text: JSON.stringify(win) };
        }
        const win = await ctx.a11y.getActiveWindow();
        if (!win) return { text: '(no active window)' };
        return {
          text: JSON.stringify({
            title: win.title, processName: win.processName,
            processId: win.processId, bounds: win.bounds,
          }),
        };
      },
    },

    {
      name: 'get_focused_element',
      description: 'Get the currently focused UI element (keyboard focus). Returns name, control type, value, bounds, and process ID.',
      parameters: {},
      category: 'window',
      handler: async (_params, ctx) => {
        await ctx.ensureInitialized();
        if (ctx.platform) {
          const el = await ctx.platform.getFocusedElement();
          if (!el) return { text: '(no focused element)' };
          return { text: JSON.stringify(el) };
        }
        const el = await ctx.a11y.getFocusedElement();
        if (!el) return { text: '(no focused element)' };
        return { text: JSON.stringify(el) };
      },
    },

    {
      name: 'focus_window',
      description: 'Bring a window to the foreground. Matches by process name, PID, or title substring. Verifies focus after attempt.',
      parameters: {
        processName: { type: 'string', description: 'Process name to focus (e.g. "notepad", "msedge")', required: false },
        processId: { type: 'number', description: 'Process ID to focus', required: false },
        title: { type: 'string', description: 'Window title substring to match', required: false },
      },
      category: 'window',
      handler: async ({ processName, processId, title }, ctx) => {
        await ctx.ensureInitialized();

        // Fix: minimize phantom off-screen full-screen windows that steal focus.
        // Win11 maximized UWP apps report bounds (-14,-14) and block SetForegroundWindow.
        try {
          const allWins = await ctx.a11y.getWindows(true);
          const phantoms = (allWins ?? []).filter((w: any) =>
            w.bounds.x < 0 && w.bounds.y < 0 &&
            w.bounds.width > 3000 && w.bounds.height > 2000 &&
            !w.isMinimized &&
            w.processId !== processId &&
            !(processName && w.processName.toLowerCase() === processName.toLowerCase())
          );
          for (const p of phantoms) {
            await ctx.a11y.focusWindow(undefined, p.processId).catch(() => {});
            await ctx.desktop.keyPress('super+down');
            await new Promise(r => setTimeout(r, 200));
          }
        } catch { /* non-fatal */ }

        let targetBounds: any = null;
        let targetPid = processId;

        // Bug 3 fix: use getWindows(true) for visible-only, filter properly, prefer on-screen windows
        if (processName && !targetPid) {
          const windows = await ctx.a11y.getWindows(true);
          let matches = (windows ?? []).filter((w: any) =>
            w.processName.toLowerCase() === processName.toLowerCase() ||
            w.processName.toLowerCase().includes(processName.toLowerCase())
          );
          // AND-match with title if provided
          if (title) {
            matches = matches.filter((w: any) => w.title.toLowerCase().includes((title as string).toLowerCase()));
          }
          // Sort: prefer on-screen windows (x >= 0, y >= 0), then non-minimized
          matches.sort((a: any, b: any) => {
            const aOnScreen = (a.bounds.x >= 0 && a.bounds.y >= 0 && !a.isMinimized) ? 1 : 0;
            const bOnScreen = (b.bounds.x >= 0 && b.bounds.y >= 0 && !b.isMinimized) ? 1 : 0;
            return bOnScreen - aOnScreen;
          });
          const win = matches[0];
          if (win) { targetPid = win.processId; targetBounds = win.bounds; }
          else return { text: `No window found for process "${processName}"`, isError: true };
        }
        if (!targetBounds && targetPid) {
          const windows = await ctx.a11y.getWindows(true);
          const win = windows?.find((w: any) => w.processId === targetPid);
          if (win?.bounds) targetBounds = win.bounds;
        }

        const result = await ctx.a11y.focusWindow(title, targetPid);
        ctx.a11y.invalidateCache();
        if (!result.success) return { text: `Failed to focus: ${result.error}`, isError: true };

        // Bug 4 fix: re-read bounds after focus (restore may have updated them)
        if (targetPid) {
          const freshWindows = await ctx.a11y.getWindows(true);
          const freshWin = freshWindows?.find((w: any) => w.processId === targetPid);
          if (freshWin?.bounds) targetBounds = freshWin.bounds;
        }

        // If window is still off-screen, snap-maximize (platform-aware)
        if (targetBounds && (targetBounds.x < 0 || targetBounds.y < 0)) {
          const snapKey = process.platform === 'darwin' ? 'ctrl+cmd+f' : 'super+up';
          await ctx.desktop.keyPress(snapKey);
          await new Promise(r => setTimeout(r, 300));
          ctx.a11y.invalidateCache();
          // Re-read bounds after snap
          if (targetPid) {
            const snapWindows = await ctx.a11y.getWindows(true);
            const snapWin = snapWindows?.find((w: any) => w.processId === targetPid);
            if (snapWin?.bounds) targetBounds = snapWin.bounds;
          }
        }

        // Click window center to physically assert focus (only when window is on-screen)
        if (targetBounds && targetBounds.x >= 0 && targetBounds.y >= 0 && targetBounds.width > 0) {
          const centerX = a11yToMouse(targetBounds.x + Math.round(targetBounds.width / 2), ctx);
          const centerY = a11yToMouse(targetBounds.y + Math.round(targetBounds.height / 4), ctx);
          await ctx.desktop.mouseClick(centerX, centerY);
          await new Promise(r => setTimeout(r, 200));
        }

        await new Promise(r => setTimeout(r, 200));
        ctx.a11y.invalidateCache();
        const active = await ctx.a11y.getActiveWindow();
        const verified = active?.processId === targetPid ||
          (processName && active?.processName.toLowerCase().includes(processName.toLowerCase())) ||
          (title && active?.title.toLowerCase().includes(title.toLowerCase()));

        if (!verified && targetBounds && targetBounds.x >= 0 && targetBounds.y >= 0 && targetBounds.width > 0) {
          const centerX = a11yToMouse(targetBounds.x + Math.round(targetBounds.width / 2), ctx);
          const centerY = a11yToMouse(targetBounds.y + Math.round(targetBounds.height / 2), ctx);
          await ctx.desktop.mouseClick(centerX, centerY);
          await new Promise(r => setTimeout(r, 300));
          ctx.a11y.invalidateCache();
          const a2 = await ctx.a11y.getActiveWindow();
          const v2 = a2?.processId === targetPid ||
            (processName && a2?.processName.toLowerCase().includes(processName.toLowerCase())) ||
            (title && a2?.title.toLowerCase().includes(title.toLowerCase()));
          return {
            text: v2 ? `Focused (retry): "${a2?.title}" [${a2?.processName}] pid:${a2?.processId}`
                     : `Focus FAILED. Foreground: "${a2?.title}" [${a2?.processName}]`,
            isError: !v2,
          };
        }
        return { text: `Focused: "${active?.title}" [${active?.processName}] pid:${active?.processId}` };
      },
    },

    {
      name: 'find_element',
      description: 'Search for UI elements by name, control type, or automation ID within a process. Returns matching elements with bounds.',
      parameters: {
        name: { type: 'string', description: 'Element name to search for', required: false },
        controlType: { type: 'string', description: 'UI Automation control type (e.g. "ControlType.Button")', required: false },
        automationId: { type: 'string', description: 'Automation ID', required: false },
        processId: { type: 'number', description: 'Process ID to search within', required: false },
      },
      category: 'window',
      handler: async ({ name, controlType, automationId, processId }, ctx) => {
        await ctx.ensureInitialized();
        if (ctx.platform) {
          const elements = await ctx.platform.findElements({ name, controlType, processId });
          const filtered = automationId
            ? elements.filter((el: UiElement) => el.automationId === automationId)
            : elements;
          if (!filtered?.length) return { text: '(no elements found)' };
          const lines = filtered.slice(0, 20).map(formatElement);
          if (filtered.length > 20) lines.push(`... and ${filtered.length - 20} more`);
          return { text: lines.join('\n') };
        }
        const elements = await ctx.a11y.findElement({ name, controlType, automationId, processId });
        if (!elements?.length) return { text: '(no elements found)' };
        const lines = elements.slice(0, 20).map((el: any) => formatElement({
          ...el,
          enabled: el.enabled ?? el.isEnabled,
        }));
        if (elements.length > 20) lines.push(`... and ${elements.length - 20} more`);
        return { text: lines.join('\n') };
      },
    },

    {
      name: 'read_clipboard',
      description: 'Read the current text content of the OS clipboard.',
      parameters: {},
      category: 'clipboard',
      handler: async (_params, ctx) => {
        await ctx.ensureInitialized();
        if (ctx.platform) {
          const text = await ctx.platform.readClipboard();
          return { text: text || '(clipboard empty or non-text)' };
        }
        const text = await ctx.a11y.readClipboard();
        return { text: text || '(clipboard empty or non-text)' };
      },
    },

    {
      name: 'write_clipboard',
      description: 'Write text to the OS clipboard.',
      parameters: {
        text: { type: 'string', description: 'Text to write to clipboard', required: true },
      },
      category: 'clipboard',
      handler: async ({ text }, ctx) => {
        await ctx.ensureInitialized();
        if (ctx.platform) {
          await ctx.platform.writeClipboard(text);
          return { text: `Clipboard set (${text.length} chars)` };
        }
        await ctx.a11y.writeClipboard(text);
        return { text: `Clipboard set (${text.length} chars)` };
      },
    },

    {
      name: 'minimize_window',
      description: 'Minimize a window. Matches by process name, PID, or title. Cross-platform: Windows (ShowWindow), macOS (miniaturize), Linux (wmctrl/xdotool).',
      parameters: {
        processName: { type: 'string', description: 'Process name to minimize (e.g. "Calculator", "Discord")', required: false },
        processId: { type: 'number', description: 'Process ID to minimize', required: false },
        title: { type: 'string', description: 'Window title substring to match', required: false },
      },
      category: 'window',
      handler: async ({ processName, processId, title }, ctx) => {
        await ctx.ensureInitialized();

        // Find the target window
        const windows = await ctx.a11y.getWindows(true);
        let target = (windows ?? []).find((w: any) => {
          if (processId && w.processId === processId) return true;
          if (processName && w.processName.toLowerCase().includes(processName.toLowerCase())) return true;
          if (title && w.title.toLowerCase().includes(title.toLowerCase())) return true;
          return false;
        });

        if (!target) return { text: `No window found matching: ${processName || processId || title}` };

        // Focus first (required for minimize shortcut), then minimize
        await ctx.a11y.focusWindow(undefined, target.processId).catch(() => {});
        await new Promise(r => setTimeout(r, 200));
        // Cross-platform: Super+Down (Windows/Linux), Cmd+M (macOS)
        const minimizeKey = process.platform === 'darwin' ? 'cmd+m' : 'super+down';
        await ctx.desktop.keyPress(minimizeKey);

        return { text: `Minimized: "${target.title}" [${target.processName}] pid:${target.processId}` };
      },
    },
  ];
}
