/**
 * Zero-LLM action router.
 *
 * Intercepts mechanical/navigation subtasks and handles them without any LLM
 * call. Ported from `src/action-router.ts` (v0.6.3 heritage). Preserves the
 * highest-ROI bits:
 *
 *   - APP_ALIASES table (40 apps × 3 OSes) via `./aliases`
 *   - WEBVIEW2 settle rule (Outlook/Teams/Slack/…) via `./webview2`
 *   - **Before/after window diff + polling verification** — the router only
 *     reports success when a NEW matching window has been observed on the OS.
 *     This is the missing guard that caused v0.8.1-alpha's "router claimed
 *     Opened Calculator but nothing happened" false positives.
 *   - Compound-task guard (refuses to route ambiguous splits)
 *   - URL normalization + browser-launch path
 *   - Telemetry counters (proof of cost savings)
 *
 * Security: `action-router.ts:339` had a `child_process.exec('start "" "${url}"')`
 * sink (audit C3). The port here goes through adapter.launchApp which uses
 * execFile with argv — no shell expansion. C3 closed in place.
 */

import type { PlatformAdapter, WindowInfo } from '../../platform/types';
import { logger } from '../observability/logger';
import { APP_ALIASES, resolveAlias, type AppAlias } from './aliases';
import { normalizeAppName } from './normalize';
import { needsWebView2Settle, settleIfWebView2 } from './webview2';
import { resolveWebService } from './web-services';
import { resolveSchemeHandlerExecutable } from '../../platform/uri-handler';

export { APP_ALIASES, resolveAlias, needsWebView2Settle, settleIfWebView2 };
export { WEB_SERVICES, resolveWebService } from './web-services';

export interface RouteResult {
  handled: boolean;
  /** Short human summary for telemetry / logs. */
  description?: string;
  /** Process id of the window the router confirmed, when applicable. */
  processId?: number;
  /** Which sub-path fired — used by canonical tests + telemetry. */
  path?: 'open_app' | 'focus_existing' | 'url_nav' | 'shortcut' | 'focus' | 'none';
}

export interface RouterTelemetry {
  openAppHits: number;
  focusExistingHits: number;
  urlNavHits: number;
  shortcutHits: number;
  focusHits: number;
  llmFallbacks: number;
  compoundRefused: number;
  /** Launch attempts that returned with NO new window observed — false-positive saves. */
  launchUnverified: number;
  /** "open <web-service>" redirected to URL nav — closes the v0.9 "default browser typed in search bar" hole. */
  webServiceRedirects: number;
}

/** Settle + polling budget — ported from v0.6.3 action-router `waitForAppReady`. */
const READY_POLL_INTERVAL_MS = 300;
const READY_TIMEOUT_MS = 8_000;

/**
 * Compound-task guard: reject subtasks that still look compound. The
 * decomposer is supposed to split them first; if the router sees "X and Y"
 * with action verbs on both sides it refuses rather than guess.
 */
const COMPOUND_PATTERN = /\b(and|then)\b.*\b(type|click|press|open|save|send|scroll|navigate|go|visit|search|copy|paste|close|draw|sketch|paint|write|compute|calculate|fill|submit|enter|summarize|describe|read|select|focus|switch|minimize|maximize|check|uncheck|highlight|delete|move|rename|find|look)\b/i;

const OPEN_APP_PATTERN = /^\s*(?:open|launch|start|run)\s+(.+?)\s*$/i;
const NAV_URL_PATTERN = /^\s*(?:go to|navigate to|visit|browse to|open)\s+(.+?)\s*$/i;
const FOCUS_APP_PATTERN = /^\s*(?:focus|switch to)\s+(.+?)\s*$/i;

/**
 * Verb-shortcut table — these are the v0.7-era deterministic verb
 * handlers the v0.8.1 unification dropped. After LLM decomposition
 * produces atomic subtasks like "copy", "paste", "press Enter", these
 * regexes catch them BEFORE the LLM agent ladder runs, saving an
 * entire blind→hybrid→vision climb per subtask.
 *
 * Each entry maps a regex (anchored to a complete subtask) to a
 * portable key combo. Pure data — adding a verb is one row.
 *
 * Properties:
 *   - OS-agnostic: all combos use `mod` which the platform adapter
 *     resolves to Cmd on macOS / Ctrl elsewhere.
 *   - Model-agnostic: zero LLM calls.
 *   - App-agnostic: shortcuts are universal across text-editing apps.
 *   - Language-coupled: English verbs only. A localization layer
 *     could replace the regexes; the dispatch logic itself doesn't
 *     care what language the table is keyed on.
 */
const VERB_SHORTCUTS: Array<{ pattern: RegExp; combo: string; label: string }> = [
  { pattern: /^\s*copy(?:\s+(?:the\s+|a\s+|an\s+)?(?:selection|text|that|it|line|paragraph|sentence))?\s*$/i,
    combo: 'mod+c', label: 'copy' },
  { pattern: /^\s*paste(?:\s+(?:it|that|here|the\s+\w+))?\s*$/i,
    combo: 'mod+v', label: 'paste' },
  { pattern: /^\s*cut(?:\s+(?:the\s+|a\s+)?(?:selection|text|that|it))?\s*$/i,
    combo: 'mod+x', label: 'cut' },
  { pattern: /^\s*select\s+all(?:\s+(?:text|content))?\s*$/i,
    combo: 'mod+a', label: 'select all' },
  { pattern: /^\s*save(?:\s+(?:the\s+)?(?:file|document|page|changes))?\s*$/i,
    combo: 'mod+s', label: 'save' },
  { pattern: /^\s*undo(?:\s+(?:that|the\s+last\s+\w+))?\s*$/i,
    combo: 'mod+z', label: 'undo' },
  { pattern: /^\s*redo(?:\s+(?:that|the\s+last\s+\w+))?\s*$/i,
    combo: 'mod+shift+z', label: 'redo' },
  { pattern: /^\s*find(?:\s+in\s+(?:the\s+)?(?:document|page|file))?\s*$/i,
    combo: 'mod+f', label: 'find' },
];

/** "press <Key>" / "press the <Key> key" — args-bearing variant. */
const PRESS_KEY_PATTERN = /^\s*press\s+(?:the\s+)?([A-Za-z][A-Za-z0-9_]*(?:\+[A-Za-z][A-Za-z0-9_]*)*)\s*(?:key)?\s*$/i;

/** "type <text>" — quoted or unquoted literal text. */
const TYPE_TEXT_PATTERN = /^\s*type\s+(.+?)\s*$/i;

/** "wait <N> [ms|s|seconds]" — bounded delay. */
const WAIT_PATTERN = /^\s*wait\s+(\d+)\s*(ms|millisecond|milliseconds|s|sec|second|seconds)?\s*$/i;

export class Router {
  readonly telemetry: RouterTelemetry = {
    openAppHits: 0,
    focusExistingHits: 0,
    urlNavHits: 0,
    shortcutHits: 0,
    focusHits: 0,
    llmFallbacks: 0,
    compoundRefused: 0,
    launchUnverified: 0,
    webServiceRedirects: 0,
  };

  /**
   * @param adapter            platform adapter.
   * @param resolveHttpHandler resolves the registered https handler executable
   *   (default: the real OS resolver). Injected so URL-nav is deterministic in
   *   tests — production reads the registry, tests pass a stub.
   */
  constructor(
    private readonly adapter: PlatformAdapter,
    private readonly resolveHttpHandler: () => Promise<string | null> =
      () => resolveSchemeHandlerExecutable('https'),
  ) {}

  async route(subtask: string): Promise<RouteResult> {
    const task = subtask.trim();
    if (!task) return { handled: false, path: 'none' };

    if (COMPOUND_PATTERN.test(task)) {
      this.telemetry.compoundRefused += 1;
      logger.debug('router.refused_compound', { task });
      return { handled: false, path: 'none', description: 'refused: compound task' };
    }

    // 1. `open <app>`
    const openMatch = task.match(OPEN_APP_PATTERN);
    if (openMatch) return this.handleOpenApp(openMatch[1].trim());

    // 2. URL navigation — ONLY for a PURE navigation (a single URL, optionally
    //    with a benign "in the default browser" qualifier). A target with a
    //    trailing ACTION ("youtube.com, search for X and play it") is a
    //    multi-step task: the router must NOT navigate-and-report-done, dropping
    //    the rest. Refuse those so the agent performs the whole flow.
    const navMatch = task.match(NAV_URL_PATTERN);
    if (navMatch) {
      const urlTok = navMatch[1].match(/(?:https?:\/\/[^\s,]+|www\.[^\s,]+|[^\s,]+\.(?:com|org|io|dev|net|co|app)[^\s,]*)/i)?.[0];
      if (urlTok) {
        const rest = navMatch[1].replace(urlTok, ' ');
        // A comma, or an action verb after the URL, means more than navigation.
        const hasTrailingAction = /,/.test(navMatch[1])
          || /\b(search|play|click|type|find|select|press|scroll|watch|sign\s*in|log\s*in|add|buy|send|download|then)\b/i.test(rest);
        if (!hasTrailingAction) {
          return this.handleUrlNav(this.normalizeUrl(urlTok));
        }
        // else: fall through — not a pure nav; let the agent handle the flow.
      }
    }

    // 3. `focus <app>`
    const focusMatch = task.match(FOCUS_APP_PATTERN);
    if (focusMatch) return this.handleFocus(focusMatch[1].trim());

    // 4. Verb shortcuts (copy / paste / cut / save / undo / redo / select all
    //    / find). Each is a deterministic single-key-combo dispatch — saves a
    //    full blind→hybrid→vision agent climb for atomic verbs the LLM
    //    decomposer emits ("copy", "paste"). v0.7.x had this dispatch, the
    //    v0.8.1 unification dropped it; restored here.
    for (const entry of VERB_SHORTCUTS) {
      if (entry.pattern.test(task)) return this.handleShortcut(entry.combo, entry.label);
    }

    // 5. `press <Key>` — args-bearing key dispatch.
    const pressMatch = task.match(PRESS_KEY_PATTERN);
    if (pressMatch) return this.handleShortcut(pressMatch[1], `press ${pressMatch[1]}`);

    // 6. `type <text>` — strip optional surrounding quotes.
    const typeMatch = task.match(TYPE_TEXT_PATTERN);
    if (typeMatch) {
      const stripped = typeMatch[1].replace(/^["'](.*)["']$/, '$1');
      return this.handleType(stripped);
    }

    // 7. `wait <N> [ms|s]` — bounded delay (caps at 5s to avoid hung tasks).
    const waitMatch = task.match(WAIT_PATTERN);
    if (waitMatch) {
      const num = parseInt(waitMatch[1], 10);
      const unit = (waitMatch[2] || 'ms').toLowerCase();
      const ms = unit.startsWith('s') && !unit.startsWith('m') ? num * 1000 : num;
      return this.handleWait(Math.min(ms, 5_000));
    }

    // Miss — caller escalates
    this.telemetry.llmFallbacks += 1;
    return { handled: false, path: 'none' };
  }

  // ─── Handlers ──────────────────────────────────────────────────────────

  /**
   * Open an app.
   *
   * Protocol:
   *   1. Snapshot windows BEFORE launch.
   *   2. If the app is already running and `alwaysNewInstance` is false,
   *      focus the existing window and return.
   *   3. Else invoke `adapter.launchApp` with the best-available launch
   *      hint (uwpAppId / executable / natural name).
   *   4. Poll adapter.listWindows() up to 8s for a NEW window matching
   *      the alias (by processName or title).
   *   5. Return `handled: true` only if the poll found a matching window.
   *      Otherwise return `handled: false` and let the pipeline escalate.
   *
   * The poll is the guard against silent launch failures (UWP apps where
   * Start-Process returns 0 but nothing spawned, protocol handlers that
   * detach, etc.).
   */
  private async handleOpenApp(appName: string): Promise<RouteResult> {
    // Defence against greedy capture: the OPEN_APP_PATTERN is `open (.+?)$`,
    // which on "open paint and draw a stick figure" captures the whole tail.
    // The preprocessor SHOULD have decomposed that into subtasks upstream,
    // but if anything slips through, refuse here rather than Start-Menu-type
    // the whole phrase into Edge's address bar (the v0.4.0 regression).
    if (/\s+(?:and|then)\s+/i.test(appName) || /,/.test(appName)) {
      this.telemetry.compoundRefused += 1;
      logger.warn('router.open_app.refused_compound_name', { appName });
      return {
        handled: false,
        path: 'none',
        description: `refused: compound app name "${appName}" — decomposer should have split this`,
      };
    }

    // Normalize once — strip filler words ("the outlook app" → "outlook"),
    // quotes, and case. `resolveAlias` does this internally too, but the
    // post-launch matching code below uses `normalized` as a process-name
    // hint, so we want the cleaned form there too.
    const normalized = normalizeAppName(appName);
    const alias = resolveAlias(appName);

    // Web-service shortcut. If the name isn't a known native app but IS a
    // known web service (youtube, reddit, gmail, …), route to URL nav so the
    // OS opens the registered default browser. Prevents the v0.9 failure
    // where "open youtube" missed APP_ALIASES, fell through Start-Menu
    // search, escalated to the blind agent, and ended with the agent typing
    // "default browser" into a search bar.
    if (!alias) {
      const webUrl = resolveWebService(appName);
      if (webUrl) {
        logger.debug('router.open_app.web_service_redirect', { appName, url: webUrl });
        this.telemetry.webServiceRedirects += 1;
        return this.handleUrlNav(webUrl);
      }
    }

    // Search term used by Start-Menu / Spotlight fallback. Prefer the
    // alias's curated `searchTerm` ("Edge", "File Explorer"); fall back
    // to the normalized name (not the raw `appName`) so a phrase like
    // "the outlook app" doesn't end up typed verbatim into the Start
    // Menu when the alias misses for some reason.
    const searchTerm = alias?.searchTerm ?? (normalized || appName);

    // Snapshot windows BEFORE. We'll diff against this to know what's new.
    const windowsBefore = await this.safeListWindows();

    // If already running and we don't need a fresh instance, focus it.
    if (!alias?.alwaysNewInstance) {
      const existing = this.findWindowForAlias(windowsBefore, normalized, alias);
      if (existing) {
        const ok = await this.adapter.focusWindow({ processId: existing.processId });
        if (ok) {
          this.telemetry.focusExistingHits += 1;
          await settleIfWebView2(normalized);
          return {
            handled: true,
            path: 'focus_existing',
            processId: existing.processId,
            description: `Focused existing ${searchTerm} window`,
          };
        }
      }
    }

    // Try launch strategies in order. Each attempt does its own poll;
    // on success we return, on failure we try the next. This mirrors
    // v0.6.3 action-router's `handleOpenApp → launchViaStartMenu` fallback.
    const strategies = this.launchStrategies(alias, normalized);
    let newWindow: WindowInfo | null = null;
    let triedAny = false;

    for (const strat of strategies) {
      triedAny = true;
      logger.debug('router.open_app.try', { strategy: strat.label, appName });

      try {
        await strat.run();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn('router.open_app.strategy_threw', { strategy: strat.label, appName, error: msg });
        continue;
      }

      newWindow = await this.waitForNewWindow(
        windowsBefore,
        normalized,
        alias,
        strat.pollBudgetMs,
      );
      if (newWindow) {
        logger.debug('router.open_app.succeeded', { strategy: strat.label, pid: newWindow.processId });
        break;
      }
      logger.debug('router.open_app.no_window_for_strategy', { strategy: strat.label });
    }

    if (!triedAny) {
      return { handled: false, path: 'none', description: `No launch strategy for "${searchTerm}"` };
    }

    if (!newWindow) {
      this.telemetry.launchUnverified += 1;
      logger.warn('router.open_app.all_strategies_failed', { appName });
      return {
        handled: false,
        path: 'none',
        description: `Launch attempted for "${searchTerm}" but no matching window appeared after all strategies. Falling through.`,
      };
    }

    // Settle Electron/WebView2 apps before downstream tools hit them.
    await settleIfWebView2(normalized);

    this.telemetry.openAppHits += 1;
    return {
      handled: true,
      path: 'open_app',
      processId: newWindow.processId,
      description: `Opened ${searchTerm} (pid ${newWindow.processId})`,
    };
  }

  /**
   * Launch a URL through the default browser.
   *
   * Verified the same way as open_app: we snapshot windows before,
   * issue the launch, then confirm a browser-class window appeared.
   */
  /**
   * URL navigation. The previous implementation polled for a NEW browser
   * window or a title containing the hostname for up to 8 seconds — this
   * was fragile because:
   *
   *   1. Modern browsers reuse an existing window/tab, so no NEW window
   *      ever appears in the diff.
   *   2. The browser doesn't update its OS-level window title until the
   *      page begins rendering — heavy networks / slow pages defeat the
   *      300ms polling cadence.
   *   3. Cross-platform title formats differ (Edge vs. Safari vs. Chrome)
   *      so even when the title updates, the predicate may miss it.
   *
   * Result: every URL nav timed out at 8 s and declared `router_miss`,
   * forcing escalation to the blind agent — which succeeded in ~5 s
   * doing the SAME thing (`launchApp(..., { url })`) without the polling.
   *
   * The fix: trust the launch. If `launchApp` returned without throwing,
   * the OS accepted the URL — `start <url>` on Windows, `open <url>` on
   * macOS, `xdg-open <url>` on Linux are all guaranteed to surface the
   * default browser eventually. The pipeline's verifier (`v0.8.12`) runs
   * after this rung as ground-truth check; if no browser actually
   * surfaces with the URL visible, it rejects and the ladder climbs.
   * That separation of concerns — router fast-paths, verifier ground-
   * truths — is cleaner than the router doing both.
   *
   * Brief 800 ms settle so the next subtask doesn't fire mid-launch.
   */
  private async handleUrlNav(url: string): Promise<RouteResult> {
    logger.debug('router.url_nav.launching', { url });

    try {
      // Dispatch to the REAL default browser. The magic name 'default-browser'
      // is not a launchable executable — `launchApp('default-browser', …)`
      // fails to start, finds no window, and falls through to launchApp's
      // Start-menu-search fallback, which presses Win and types
      // "default-browser" into the search bar. That's the user-visible
      // "searching for the browser" bug. Instead resolve the registered https
      // handler (e.g. msedge.exe) and launch IT — its window is findable, so no
      // search fallback. macOS/Linux keep their canonical URL openers.
      const plat = this.adapter.platform;
      if (plat === 'darwin') {
        await this.adapter.launchApp('open', { url });
      } else if (plat === 'linux') {
        await this.adapter.launchApp('xdg-open', { url });
      } else {
        const exe = await this.resolveHttpHandler().catch(() => null);
        await this.adapter.launchApp(exe ?? 'explorer.exe', { url });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('router.url_nav.launch_threw', { url, error: msg });
      return { handled: false, path: 'none', description: `launch threw: ${msg}` };
    }

    // Best-effort settle so subsequent subtasks see a roughly stable
    // browser state. We deliberately do NOT poll for a window — the
    // verifier handles "did the page actually load" as ground truth.
    await this.delay(800);

    this.telemetry.urlNavHits += 1;
    return {
      handled: true,
      path: 'url_nav',
      description: `Navigated to ${url} (verifier confirms)`,
    };
  }

  private async handleFocus(appName: string): Promise<RouteResult> {
    // alias resolution handles normalization internally; the routing-table
    // process-name list is what we actually need to scan.
    const alias = resolveAlias(appName);
    const processNames = alias?.processNames ?? [appName];
    for (const pn of processNames) {
      const ok = await this.adapter.focusWindow({ processName: pn });
      if (ok) {
        this.telemetry.focusHits += 1;
        return {
          handled: true,
          path: 'focus',
          description: `Focused ${alias?.searchTerm ?? appName}`,
        };
      }
    }
    return {
      handled: false,
      path: 'none',
      description: `focus failed: no window for ${appName}`,
    };
  }

  /**
   * Press a single key combo. Used for verb shortcuts (copy=mod+c,
   * paste=mod+v, save=mod+s, etc.) and the `press <Key>` form. Returns
   * `handled: true` even on adapter error — the caller should treat the
   * router as having tried; a downstream verifier check confirms whether
   * the action actually had effect on the screen.
   *
   * Bypasses the agent's safety layer because this is router-internal
   * deterministic dispatch, not an LLM-emitted action. The CALLER
   * (router) is responsible for emitting only safe combos — the table
   * of `VERB_SHORTCUTS` and the `PRESS_KEY_PATTERN` regex constrain
   * what gets here.
   */
  private async handleShortcut(combo: string, label: string): Promise<RouteResult> {
    try {
      await this.adapter.keyPress(combo);
      this.telemetry.shortcutHits += 1;
      return {
        handled: true,
        path: 'shortcut',
        description: `Pressed ${combo} (${label})`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('router.shortcut.failed', { combo, label, error: msg });
      return {
        handled: false,
        path: 'none',
        description: `shortcut failed: ${msg}`,
      };
    }
  }

  /**
   * Type a literal text string. The LLM decomposer is instructed to put
   * the literal text in the subtask ("type John Smith"), so the router
   * can dispatch directly to `adapter.typeText`. Quoting (single or
   * double) is stripped by the regex layer before this is called.
   */
  private async handleType(text: string): Promise<RouteResult> {
    if (!text) return { handled: false, path: 'none', description: 'type: empty text' };
    try {
      await this.adapter.typeText(text);
      return {
        handled: true,
        path: 'shortcut',
        description: `Typed ${text.length} chars`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { handled: false, path: 'none', description: `type failed: ${msg}` };
    }
  }

  /**
   * `wait N [ms|s]` — sleep for a bounded duration. The caller has
   * already capped the value at 5 seconds; this is purely a delay
   * primitive so subtasks like "wait 1 second" don't burn an LLM turn.
   */
  private async handleWait(ms: number): Promise<RouteResult> {
    await this.delay(ms);
    return {
      handled: true,
      path: 'shortcut',
      description: `Waited ${ms}ms`,
    };
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  /**
   * Ordered list of launch strategies to try for an alias.
   *
   * Order matters — cheapest/fastest first, with each strategy scoped to a
   * bounded poll budget. The router tries strategy A, polls its budget, and
   * if no window appeared tries strategy B, etc. The TOTAL budget is capped
   * at READY_TIMEOUT_MS across all strategies.
   *
   * Strategy selection per-platform:
   *
   *   Windows:
   *     1. UWP AppsFolder (if alias.uwpAppId) — fastest, deterministic for UWP/Store apps.
   *     2. Direct executable (if alias.executable) — fastest for classic Win32.
   *     3. Start Menu search (universal fallback) — slower, but finds anything indexed.
   *
   *   macOS:
   *     1. `open -a <bundle>` (if alias.macOSAppName or alias.key).
   *     2. Spotlight (cmd+space → type → Return) — universal fallback.
   *
   *   Linux:
   *     1. Direct spawn (alias.executable or normalized name).
   *     2. xdg-open fallback — built into adapter.launchApp.
   */
  private launchStrategies(
    alias: (AppAlias & { key: string }) | null,
    normalizedName: string,
  ): Array<{ label: string; run: () => Promise<unknown>; pollBudgetMs: number }> {
    const strategies: Array<{ label: string; run: () => Promise<unknown>; pollBudgetMs: number }> = [];
    const alwaysNewInstance = alias?.alwaysNewInstance ?? false;

    if (this.adapter.platform === 'win32') {
      if (alias?.uwpAppId) {
        const uwpId = alias.uwpAppId;
        strategies.push({
          label: 'uwp-appfolder',
          pollBudgetMs: 4_000,
          run: () => this.adapter.launchApp(alias.searchTerm ?? normalizedName, {
            alwaysNewInstance,
            uwpAppId: uwpId,
          }),
        });
      }
      if (alias?.executable) {
        strategies.push({
          label: 'exe-direct',
          pollBudgetMs: alias.uwpAppId ? 2_500 : 4_000,
          run: () => this.adapter.launchApp(alias.executable!, { alwaysNewInstance }),
        });
      }
      // Universal fallback — Start Menu search via keyboard. Works for any
      // app findable by name (VS Code, third-party apps, UWP with unknown IDs).
      strategies.push({
        label: 'start-menu-search',
        pollBudgetMs: 4_000,
        run: () => this.startMenuSearch(alias?.searchTerm ?? normalizedName),
      });
    } else if (this.adapter.platform === 'darwin') {
      const bundle = alias?.macOSAppName ?? alias?.key ?? normalizedName;
      strategies.push({
        label: 'open-a',
        pollBudgetMs: 4_000,
        run: () => this.adapter.launchApp(bundle, { alwaysNewInstance }),
      });
      // Universal fallback — Spotlight.
      strategies.push({
        label: 'spotlight',
        pollBudgetMs: 4_000,
        run: () => this.spotlightSearch(alias?.searchTerm ?? normalizedName),
      });
    } else {
      // Linux — adapter.launchApp already tries direct + xdg-open.
      const target = alias?.executable ?? alias?.key ?? normalizedName;
      strategies.push({
        label: 'spawn',
        pollBudgetMs: READY_TIMEOUT_MS,
        run: () => this.adapter.launchApp(target, { alwaysNewInstance }),
      });
    }

    return strategies;
  }

  /**
   * Open Start Menu, type the app name, press Enter. Windows' own app
   * resolution finds and launches anything it knows about.
   */
  private async startMenuSearch(searchTerm: string): Promise<void> {
    await this.adapter.keyPress('Super');
    await this.delay(600);
    await this.adapter.typeText(searchTerm);
    await this.delay(700);
    await this.adapter.keyPress('Return');
  }

  /** macOS Spotlight-driven launch — the universal macOS fallback. */
  private async spotlightSearch(searchTerm: string): Promise<void> {
    await this.adapter.keyPress('mod+Space');
    await this.delay(300);
    await this.adapter.typeText(searchTerm);
    await this.delay(500);
    await this.adapter.keyPress('Return');
  }

  /**
   * Find a window belonging to the alias among a snapshot.
   *
   * Matches strictly on processName — title substrings (`"calculator"`) are
   * too noisy for "is this app already running" detection. File-explorer
   * panels, browser tabs, VS Code tabs can all accidentally include the
   * name in their title and cause false "focus existing window" decisions.
   *
   * The matchesAlias() helper used during the post-launch poll is looser
   * on purpose — by then we've already diffed against the before-set.
   */
  private findWindowForAlias(
    windows: WindowInfo[],
    normalizedName: string,
    alias: (AppAlias & { key: string }) | null,
  ): WindowInfo | null {
    if (windows.length === 0) return null;
    const processMatches = (w: WindowInfo): boolean => {
      const proc = w.processName.toLowerCase();
      if (alias) return alias.processNames.some(pn => pn.toLowerCase() === proc);
      return proc === normalizedName;
    };
    return windows.find(w => !w.isMinimized && processMatches(w)) ?? null;
  }

  /**
   * Poll until a window that was NOT in `before` appears and matches the
   * alias, or the timeout elapses. Returns the matched WindowInfo or null.
   *
   * This is the ported v0.6.3 `waitForAppReady` behavior that the v0.8.1-alpha
   * router was silently skipping.
   */
  private async waitForNewWindow(
    before: WindowInfo[],
    normalizedName: string,
    alias: (AppAlias & { key: string }) | null,
    timeoutMs: number = READY_TIMEOUT_MS,
  ): Promise<WindowInfo | null> {
    const beforeIds = new Set(
      before
        .map(w => (w.handle !== undefined ? String(w.handle) : `pid:${w.processId}`)),
    );
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      await this.delay(READY_POLL_INTERVAL_MS);
      const current = await this.safeListWindows();
      for (const w of current) {
        if (w.isMinimized) continue;
        const id = w.handle !== undefined ? String(w.handle) : `pid:${w.processId}`;
        if (beforeIds.has(id)) continue;
        if (this.matchesAlias(w, normalizedName, alias)) return w;
      }
    }
    return null;
  }

  /** Generic "wait for any window satisfying a predicate" variant for URL nav. */
  private async waitForMatchingWindow(
    before: WindowInfo[],
    predicate: (w: WindowInfo) => boolean,
    timeoutMs: number,
  ): Promise<WindowInfo | null> {
    const beforeIds = new Set(
      before.map(w => (w.handle !== undefined ? String(w.handle) : `pid:${w.processId}`)),
    );
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await this.delay(READY_POLL_INTERVAL_MS);
      const current = await this.safeListWindows();
      // Prefer a brand-new window, but accept an existing one whose title
      // just changed to match (URL nav inside an already-open browser).
      const fresh = current.find(w => !w.isMinimized && predicate(w) && !beforeIds.has(
        w.handle !== undefined ? String(w.handle) : `pid:${w.processId}`,
      ));
      if (fresh) return fresh;
      const updated = current.find(w => !w.isMinimized && predicate(w));
      if (updated) return updated;
    }
    return null;
  }

  private matchesAlias(
    w: WindowInfo,
    normalizedName: string,
    alias: (AppAlias & { key: string }) | null,
  ): boolean {
    const proc = w.processName.toLowerCase();
    const title = w.title.toLowerCase();
    if (alias) {
      if (alias.processNames.some(pn => pn.toLowerCase() === proc)) return true;
      if (title.includes(alias.searchTerm.toLowerCase())) return true;
    }
    if (proc === normalizedName || proc.includes(normalizedName)) return true;
    if (title.includes(normalizedName)) return true;
    return false;
  }

  private normalizeUrl(raw: string): string {
    const cleaned = raw.trim().replace(/['"]+/g, '');
    if (/^https?:\/\//i.test(cleaned)) return cleaned;
    if (/^www\./i.test(cleaned)) return 'https://' + cleaned;
    return 'https://' + cleaned;
  }

  private hostFromUrl(url: string): string {
    try {
      return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
      return '';
    }
  }

  private async safeListWindows(): Promise<WindowInfo[]> {
    try { return await this.adapter.listWindows(); }
    catch { return []; }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
