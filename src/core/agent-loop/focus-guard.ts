/**
 * Pre-click foreground guarantee — shared by the granular pointer tools
 * (tools.ts) and the compound `mouse` tool (compound.ts).
 *
 * A coordinate click is delivered by the OS to whatever window is TOPMOST at
 * that pixel (SendInput is screen-global), which is decoupled from the window
 * the agent reasoned about. When a target window is known (the subtask anchor)
 * and the current foreground is a DIFFERENT process, we raise the target first
 * so the click lands on it instead of an overlapping window (the recurring
 * "click hit the Task Console" failure). No-op when no target is set or the
 * target is already foreground — working single-window flows pay nothing.
 */
import type { AgentToolContext } from './types';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Compare two process names by basename, case-insensitively (handles ".exe"
 *  and path prefixes — "C:\\...\\Notepad.exe" == "notepad"). */
export function sameProcess(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  const norm = (s: string) => (s.replace(/\\/g, '/').split('/').pop() ?? s).replace(/\.exe$/i, '').toLowerCase();
  return norm(a) === norm(b);
}

/** AI-host processes we must never RAISE on the agent's behalf. activeApp can
 *  legitimately be the host (the turn-1 snapshot is taken while the launching
 *  editor/chat app is still frontmost); raising it would hand desktop focus to
 *  the controller right before a click — the exact hijack the Windows bridge
 *  denylists in Cmd-ActivateAtPoint, but on macOS/Linux nothing else guards.
 *  Mirrors the bridge's list; extend via CLAWD_FOREGROUND_DENYLIST. Applies to
 *  the activeApp FALLBACK only — an explicit anchor stays authoritative. */
const HOST_PROC_DENYLIST = new Set(['claude', 'cursor', 'code', 'windsurf']);
function isHostProcess(name: string): boolean {
  const norm = (name.replace(/\\/g, '/').split('/').pop() ?? name).replace(/\.exe$/i, '').toLowerCase();
  if (HOST_PROC_DENYLIST.has(norm)) return true;
  const extra = process.env.CLAWD_FOREGROUND_DENYLIST;
  if (extra && extra.split(',').some(e => e.trim().toLowerCase() === norm)) return true;
  return false;
}

/**
 * Raise the subtask's target window when the foreground drifted to a different
 * process, so the imminent click lands on the intended window. Single attempt,
 * never throws. Returns a short note for the tool-result text (empty when no-op).
 */
export async function ensureTargetForeground(
  ctx: AgentToolContext,
  foreground: { processName?: string } | null,
): Promise<string> {
  // Prefer the explicit subtask anchor; fall back to the app the agent is
  // currently working in (activeApp, refreshed from each step's snapshot).
  // Without the fallback, a fresh delegated task (no anchor — e.g. "open Outlook
  // and click New mail") got NO pre-click raise, so the click could land on an
  // overlapping window (a fullscreen Claude/editor sitting over the just-opened
  // target), which point-based activate-at-point then foregrounds. Raising the
  // working app first puts it topmost so the click lands where the agent reasoned.
  const anchored = ctx.targetWindow?.processName;
  const fallback = ctx.activeApp && !isHostProcess(ctx.activeApp) ? ctx.activeApp : undefined;
  const targetProc = anchored ?? fallback;
  if (!targetProc) return '';
  if (foreground && sameProcess(foreground.processName, targetProc)) return '';
  const ok = await ctx.platform.focusWindow({ processName: targetProc }).catch(() => false);
  await sleep(120);
  return ok ? ` ·raised ${targetProc}` : '';
}
