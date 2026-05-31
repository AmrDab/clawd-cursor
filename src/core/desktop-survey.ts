/**
 * Desktop survey — grounds task planning in what's ACTUALLY on the desktop.
 *
 * The preprocessor used to plan blind: pure language heuristics plus a few
 * per-app assumptions (e.g. "Windows ⇒ Outlook ⇒ 3 Tabs"). That breaks the
 * moment reality differs from the guess (the user runs Thunderbird, the app
 * is already open, a different browser is default).
 *
 * This module asks the OS instead of guessing:
 *   - which top-level windows are open right now (app-agnostic, via the
 *     adapter's window list), and
 *   - which app the OS resolves for a capability (the default `mailto` /
 *     `https` handler) — we never decide "Outlook is the mail app"; the OS
 *     does, and we read its answer.
 *
 * Output is an abstract, OS-agnostic `DesktopSurvey`. All platform-specific
 * resolution lives behind injected deps (`listWindows`, `resolveHandler`) so
 * this file stays pure, testable, and free of any `process.platform` branch.
 * On platforms where handler resolution isn't available the survey degrades
 * gracefully to the open-window list — never throws, never blocks.
 */

import type { WindowInfo } from '../platform/types';
import { resolveSchemeHandlerExecutable } from '../platform/uri-handler';

/** An app the OS resolved for some capability, plus its open window if any. */
export interface ResolvedApp {
  /** Mechanical label derived from the handler executable (no brand mapping). */
  name: string;
  /** Resolved executable path, when the OS exposed one. */
  exePath?: string;
  /** A currently-open window belonging to this app, if it's already running. */
  openWindow?: WindowInfo;
}

export interface DesktopSurvey {
  /** Top-level windows open right now. App-agnostic; the primary signal. */
  openWindows: WindowInfo[];
  /** Apps the OS resolves for common capabilities (empty when unavailable). */
  handlers: {
    /** Default `mailto:` handler. */
    mail?: ResolvedApp;
    /** Default `https:` handler (the default browser). */
    browser?: ResolvedApp;
  };
}

export interface SurveyDeps {
  /** Enumerate open top-level windows (adapter.listWindows). */
  listWindows: () => Promise<WindowInfo[]>;
  /**
   * Resolve the default handler executable for a URI scheme. Injected for
   * testability; defaults to the platform helper, which self-guards to null
   * on non-Windows so the survey degrades to open-windows-only.
   */
  resolveHandler?: (scheme: string) => Promise<string | null>;
}

/** Strip a path down to its executable basename, sans extension. */
function exeBasename(exePath: string): string {
  const base = exePath.replace(/\\/g, '/').split('/').pop() ?? exePath;
  return base.replace(/\.(exe|app)$/i, '');
}

/** Link a resolved handler exe to an open window of the same process, if any. */
function toResolvedApp(exePath: string, openWindows: WindowInfo[]): ResolvedApp {
  const name = exeBasename(exePath);
  const lower = name.toLowerCase();
  const openWindow = openWindows.find(
    w => exeBasename(w.processName ?? '').toLowerCase() === lower,
  );
  return { name, exePath, openWindow };
}

/**
 * Build a desktop survey. Never throws — any failing probe degrades to a
 * partial survey so planning always has *some* ground truth to work with.
 */
export async function surveyDesktop(deps: SurveyDeps): Promise<DesktopSurvey> {
  const resolve = deps.resolveHandler ?? resolveSchemeHandlerExecutable;
  const openWindows = await deps.listWindows().catch(() => [] as WindowInfo[]);
  const [mailExe, httpExe] = await Promise.all([
    resolve('mailto').catch(() => null),
    resolve('https').catch(() => null),
  ]);
  const handlers: DesktopSurvey['handlers'] = {};
  if (mailExe) handlers.mail = toResolvedApp(mailExe, openWindows);
  if (httpExe) handlers.browser = toResolvedApp(httpExe, openWindows);
  return { openWindows, handlers };
}

/**
 * Count the DISTINCT apps currently open (by process basename). A cheap
 * signal for "is this a busy desktop?" — not the per-task app count (that's
 * the decomposer's job, grounded by `renderSurveyForPrompt`).
 */
export function distinctOpenAppCount(survey: DesktopSurvey): number {
  const set = new Set<string>();
  for (const w of survey.openWindows) {
    const p = exeBasename(w.processName ?? '').toLowerCase();
    if (p) set.add(p);
  }
  return set.size;
}

/**
 * Render the survey as a compact context block for the LLM decomposer, so it
 * grounds decomposition in reality: don't emit "open X" for an already-open
 * app, route capabilities to the real default handler, target real windows.
 * Returns '' when there's nothing useful to say.
 */
export function renderSurveyForPrompt(survey: DesktopSurvey): string {
  const lines: string[] = [];

  const wins = survey.openWindows.filter(w => (w.title ?? '').trim().length > 0);
  if (wins.length) {
    lines.push('Open windows right now:');
    for (const w of wins.slice(0, 12)) {
      const proc = w.processName ? ` [${w.processName}]` : '';
      const min = w.isMinimized ? ' (minimized)' : '';
      lines.push(`  - "${w.title}"${proc}${min}`);
    }
  }

  const h = survey.handlers;
  if (h.browser) {
    lines.push(`Default browser: ${h.browser.name}${h.browser.openWindow ? ' — already open' : ''}`);
  }
  if (h.mail) {
    lines.push(`Default mail app: ${h.mail.name}${h.mail.openWindow ? ' — already open' : ''}`);
  }

  if (!lines.length) return '';
  return [
    'DESKTOP CONTEXT (ground your plan in what is ACTUALLY available — do NOT',
    'emit an "open X" subtask for an app already open; route capabilities to',
    'the real default handler; act in the windows that already exist):',
    ...lines,
  ].join('\n');
}
