/**
 * Pre-click foreground guarantee — the root fix for wrong-window clicks.
 * When the foreground drifted to a different process, the pointer tools raise
 * the subtask's target window before clicking so the click lands on it. No-op
 * when there's no target or the target is already foreground. OS-agnostic
 * (mock adapter).
 */
import { describe, it, expect, vi } from 'vitest';
import { sameProcess, ensureTargetForeground } from '../core/agent-loop/focus-guard';
import { buildUnifiedTools } from '../core/agent-loop/tools';
import type { AgentToolContext } from '../core/agent-loop/types';

describe('sameProcess', () => {
  it('matches by basename, case-insensitively, ignoring .exe and paths', () => {
    expect(sameProcess('Notepad', 'notepad')).toBe(true);
    expect(sameProcess('C:\\Windows\\System32\\notepad.exe', 'Notepad')).toBe(true);
    expect(sameProcess('msedge', 'notepad')).toBe(false);
    expect(sameProcess(undefined, 'x')).toBe(false);
  });
});

function ctxWith(target: { title: string; processName: string } | undefined, focusWindow: any): AgentToolContext {
  return {
    platform: { focusWindow } as any,
    task: 't', mode: 'blind',
    screen: { logicalWidth: 2560, logicalHeight: 1440, physicalWidth: 2560, physicalHeight: 1440, dpiRatio: 1 },
    screenshotsCaptured: { n: 0 },
    targetWindow: target,
  };
}

describe('ensureTargetForeground', () => {
  it('raises the target when foreground is a DIFFERENT process', async () => {
    const focusWindow = vi.fn(async () => true);
    const ctx = ctxWith({ title: 'Untitled - Notepad', processName: 'Notepad' }, focusWindow);
    const note = await ensureTargetForeground(ctx, { processName: 'WindowsTerminal' });
    expect(focusWindow).toHaveBeenCalledWith({ processName: 'Notepad' });
    expect(note).toMatch(/raised Notepad/);
  });

  it('is a NO-OP when foreground is already the target process', async () => {
    const focusWindow = vi.fn(async () => true);
    const ctx = ctxWith({ title: 'Untitled - Notepad', processName: 'Notepad' }, focusWindow);
    const note = await ensureTargetForeground(ctx, { processName: 'notepad.exe' });
    expect(focusWindow).not.toHaveBeenCalled();
    expect(note).toBe('');
  });

  it('is a NO-OP when no target window is set (launch/navigate subtasks)', async () => {
    const focusWindow = vi.fn(async () => true);
    const ctx = ctxWith(undefined, focusWindow);
    const note = await ensureTargetForeground(ctx, { processName: 'WindowsTerminal' });
    expect(focusWindow).not.toHaveBeenCalled();
    expect(note).toBe('');
  });
});

describe('click tool raises the target window before clicking', () => {
  const click = buildUnifiedTools().find(t => t.name === 'click')!;

  it('focuses the target when the foreground is a different process, then clicks', async () => {
    const calls: string[] = [];
    let fg = 'WindowsTerminal';
    const platform = {
      platform: 'win32',
      getActiveWindow: vi.fn(async () => ({ title: `x - ${fg}`, processName: fg, processId: 1, bounds: { x: 0, y: 0, width: 1, height: 1 }, isMinimized: false })),
      focusWindow: vi.fn(async () => { fg = 'Notepad'; calls.push('focus'); return true; }),
      mouseClick: vi.fn(async () => { calls.push('click'); }),
    } as any;
    const ctx: AgentToolContext = {
      platform, task: 't', mode: 'hybrid',
      screen: { logicalWidth: 2560, logicalHeight: 1440, physicalWidth: 2560, physicalHeight: 1440, dpiRatio: 1 },
      screenshotsCaptured: { n: 0 },
      targetWindow: { title: 'Untitled - Notepad', processName: 'Notepad' },
    };
    const r = await click.execute({ x: 100, y: 100 }, ctx);
    expect(calls).toEqual(['focus', 'click']); // raised BEFORE clicking
    expect(r.text).toMatch(/raised Notepad/);
  });

  it('does NOT focus when no target window is set', async () => {
    const platform = {
      platform: 'win32',
      getActiveWindow: vi.fn(async () => ({ title: 'Terminal', processName: 'WindowsTerminal', processId: 1, bounds: { x: 0, y: 0, width: 1, height: 1 }, isMinimized: false })),
      focusWindow: vi.fn(async () => true),
      mouseClick: vi.fn(async () => {}),
    } as any;
    const ctx: AgentToolContext = {
      platform, task: 't', mode: 'hybrid',
      screen: { logicalWidth: 2560, logicalHeight: 1440, physicalWidth: 2560, physicalHeight: 1440, dpiRatio: 1 },
      screenshotsCaptured: { n: 0 },
      // no targetWindow
    };
    await click.execute({ x: 100, y: 100 }, ctx);
    expect(platform.focusWindow).not.toHaveBeenCalled();
  });
});
