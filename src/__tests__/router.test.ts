/**
 * Router tests — aliases, webview2 settle, core route logic,
 * before/after window-diff verification (the v0.8.1 false-positive fix).
 */

import { describe, it, expect, vi } from 'vitest';
import { APP_ALIASES, resolveAlias } from '../core/router/aliases';
import { needsWebView2Settle, WEBVIEW2_SETTLE_MS } from '../core/router/webview2';
import { Router } from '../core/router/router';
import type { PlatformAdapter, WindowInfo } from '../platform/types';

/**
 * Stateful mock adapter. launchApp toggles `afterLaunchWindows` on, so
 * subsequent listWindows() calls see the "new" window. This mirrors the
 * real OS behavior the router's poll relies on.
 */
function makeStatefulAdapter(opts: {
  platform?: 'win32' | 'darwin' | 'linux';
  preLaunchWindows?: WindowInfo[];
  postLaunchWindows?: WindowInfo[];
  focusWindowReturns?: boolean;
} = {}): PlatformAdapter & { _setLaunched: () => void; launchApp: ReturnType<typeof vi.fn> } {
  let launched = false;
  const pre = opts.preLaunchWindows ?? [];
  const post = opts.postLaunchWindows ?? [];
  const focusReturns = opts.focusWindowReturns ?? true;

  const launchApp = vi.fn(async (_name: string, _o?: any) => {
    launched = true;
    return { pid: post[0]?.processId, title: post[0]?.title };
  });

  const adapter = {
    platform: opts.platform ?? 'win32',
    init: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
    checkPermissions: () => Promise.resolve({ input: true, accessibility: true, screenRecording: true }),
    requestPermissions: () => Promise.resolve({ input: true, accessibility: true, screenRecording: true }),
    getScreenSize: () => Promise.resolve({ physicalWidth: 1920, physicalHeight: 1080, logicalWidth: 1920, logicalHeight: 1080, dpiRatio: 1 }),
    screenshot: () => Promise.resolve({ buffer: Buffer.alloc(0), width: 0, height: 0, scaleFactor: 1 }),
    screenshotRegion: () => Promise.resolve({ buffer: Buffer.alloc(0), width: 0, height: 0, scaleFactor: 1 }),
    listWindows: () => Promise.resolve(launched ? [...pre, ...post] : [...pre]),
    getActiveWindow: () => Promise.resolve(null),
    focusWindow: vi.fn(() => Promise.resolve(focusReturns)),
    maximizeWindow: () => Promise.resolve(),
    getUiTree: () => Promise.resolve([]),
    findElements: () => Promise.resolve([]),
    getFocusedElement: () => Promise.resolve(null),
    invokeElement: () => Promise.resolve({ success: true }),
    mouseClick: () => Promise.resolve(),
    mouseMove: () => Promise.resolve(),
    mouseDrag: () => Promise.resolve(),
    mouseScroll: () => Promise.resolve(),
    typeText: () => Promise.resolve(),
    keyPress: () => Promise.resolve(),
    readClipboard: () => Promise.resolve(''),
    writeClipboard: () => Promise.resolve(),
    openApp: () => Promise.resolve({}),
    launchApp,
  } as unknown as PlatformAdapter & { _setLaunched: () => void; launchApp: ReturnType<typeof vi.fn> };

  (adapter as any)._setLaunched = () => { launched = true; };
  return adapter;
}

function mkWindow(over: Partial<WindowInfo>): WindowInfo {
  return {
    title: over.title ?? 'w',
    processName: over.processName ?? 'p',
    processId: over.processId ?? 1,
    bounds: over.bounds ?? { x: 0, y: 0, width: 800, height: 600 },
    isMinimized: over.isMinimized ?? false,
    handle: over.handle ?? Math.floor(Math.random() * 1e9),
  };
}

describe('APP_ALIASES', () => {
  it('has 35+ entries', () => {
    expect(Object.keys(APP_ALIASES).length).toBeGreaterThanOrEqual(35);
  });

  it.each([
    ['notepad',    { hasExecutable: true, searchTerm: 'Notepad' }],
    ['chrome',     { hasExecutable: false, searchTerm: 'Chrome' }],
    ['Outlook',    { hasExecutable: false, searchTerm: 'Outlook' }],
    ['file explorer', { hasExecutable: false, searchTerm: 'File Explorer' }],
  ])('resolveAlias(%j) returns expected row', (name, expected) => {
    const r = resolveAlias(name);
    expect(r).not.toBeNull();
    expect(r!.searchTerm).toBe(expected.searchTerm);
    if (expected.hasExecutable) expect(r!.executable).toBeTruthy();
  });

  it('Calculator now carries a UWP AppsFolder id', () => {
    const r = resolveAlias('calculator');
    expect(r!.uwpAppId).toMatch(/Microsoft\.WindowsCalculator_.+!App/);
  });

  it('returns null for unknown names', () => {
    expect(resolveAlias('some-random-app-xyz')).toBeNull();
    expect(resolveAlias('')).toBeNull();
  });

  it('Notepad maps to TextEdit on macOS', () => {
    expect(resolveAlias('notepad')!.macOSAppName).toBe('TextEdit');
  });

  it('Explorer maps to Finder on macOS', () => {
    expect(resolveAlias('explorer')!.macOSAppName).toBe('Finder');
  });

  it('mspaint has alwaysNewInstance', () => {
    expect(resolveAlias('paint')!.alwaysNewInstance).toBe(true);
  });
});

describe('WebView2 settle rule', () => {
  it('matches known Electron apps', () => {
    ['outlook', 'OUTLOOK', 'olk', 'Teams', 'slack', 'discord', 'spotify', 'vscode', 'code']
      .forEach(n => expect(needsWebView2Settle(n)).toBe(true));
  });

  it('does not match non-Electron apps', () => {
    ['notepad', 'chrome', 'calculator', ''].forEach(n => expect(needsWebView2Settle(n)).toBe(false));
  });

  it('settle duration is 4s', () => {
    expect(WEBVIEW2_SETTLE_MS).toBe(4_000);
  });
});

describe('Router.route — verified open_app', () => {
  it('opens Chrome: snapshot → launch → poll finds new Chrome window → success', async () => {
    const chromeWindow = mkWindow({ processName: 'chrome', title: 'New Tab - Chrome', processId: 42, handle: 999 });
    const adapter = makeStatefulAdapter({ postLaunchWindows: [chromeWindow] });
    const r = new Router(adapter);
    const res = await r.route('open Chrome');
    expect(res.handled).toBe(true);
    expect(res.path).toBe('open_app');
    expect(res.processId).toBe(42);
    expect(adapter.launchApp).toHaveBeenCalled();
    expect(r.telemetry.openAppHits).toBe(1);
    expect(r.telemetry.launchUnverified).toBe(0);
  });

  it('focuses existing Chrome window instead of re-launching', async () => {
    const existing = mkWindow({ processName: 'chrome', title: 'GitHub - Chrome', processId: 55, handle: 111 });
    const adapter = makeStatefulAdapter({ preLaunchWindows: [existing] });
    const r = new Router(adapter);
    const res = await r.route('open Chrome');
    expect(res.handled).toBe(true);
    expect(res.path).toBe('focus_existing');
    expect(res.processId).toBe(55);
    expect(adapter.launchApp).not.toHaveBeenCalled();
    expect(r.telemetry.focusExistingHits).toBe(1);
  });

  it('refuses to claim success when launch produces no window', async () => {
    // The regression fix: adapter.listWindows() keeps returning nothing after launch.
    const adapter = makeStatefulAdapter({ postLaunchWindows: [] });
    const r = new Router(adapter);
    const res = await r.route('open Chrome');
    expect(res.handled).toBe(false);
    expect(res.description).toMatch(/no matching window appeared/i);
    expect(r.telemetry.launchUnverified).toBe(1);
    expect(r.telemetry.openAppHits).toBe(0);
  }, 20_000);

  it('uses UWP AppsFolder route for Calculator on Windows', async () => {
    const calc = mkWindow({ processName: 'CalculatorApp', title: 'Calculator', processId: 77, handle: 222 });
    const adapter = makeStatefulAdapter({ postLaunchWindows: [calc] });
    const r = new Router(adapter);
    await r.route('open calculator');
    // The adapter's launchApp should have received uwpAppId in opts.
    const callArgs = adapter.launchApp.mock.calls[0][1];
    expect(callArgs.uwpAppId).toMatch(/Microsoft\.WindowsCalculator/);
  });

  it('uses macOS app bundle name on darwin', async () => {
    const chrome = mkWindow({ processName: 'Google Chrome', title: 'Chrome', processId: 3, handle: 3 });
    const adapter = makeStatefulAdapter({ platform: 'darwin', postLaunchWindows: [chrome] });
    const r = new Router(adapter);
    await r.route('open Chrome');
    expect(adapter.launchApp.mock.calls[0][0]).toBe('Google Chrome');
  });
});

describe('Router.route — URL nav with verification', () => {
  it('launches and confirms a browser window appeared', async () => {
    const newTab = mkWindow({ processName: 'chrome', title: 'github.com - Chrome', processId: 88, handle: 333 });
    const adapter = makeStatefulAdapter({ postLaunchWindows: [newTab] });
    // Inject a stub https-handler resolver so URL-nav is deterministic and
    // launches the REAL browser exe — never the magic 'default-browser' string
    // (which would fall through to a Start-menu search that types it).
    const r = new Router(adapter, async () => 'C:\\fake\\msedge.exe');
    const res = await r.route('navigate to github.com');
    expect(res.handled).toBe(true);
    expect(res.path).toBe('url_nav');
    expect(adapter.launchApp).toHaveBeenCalledWith('C:\\fake\\msedge.exe', expect.objectContaining({ url: 'https://github.com' }));
    expect(adapter.launchApp).not.toHaveBeenCalledWith('default-browser', expect.anything());
  });

  it('normalizes bare URLs to https://', async () => {
    const win = mkWindow({ processName: 'chrome', title: 'example.com', processId: 3 });
    const adapter = makeStatefulAdapter({ postLaunchWindows: [win] });
    await new Router(adapter).route('go to example.com');
    expect(adapter.launchApp.mock.calls[0][1].url).toBe('https://example.com');
  });

  it('preserves https:// URLs as-is', async () => {
    const win = mkWindow({ processName: 'chrome', title: 'clawdcursor.com', processId: 3 });
    const adapter = makeStatefulAdapter({ postLaunchWindows: [win] });
    await new Router(adapter).route('visit https://clawdcursor.com');
    expect(adapter.launchApp.mock.calls[0][1].url).toBe('https://clawdcursor.com');
  });

  it('trusts launchApp success even when no browser window surfaces (verifier-as-ground-truth)', async () => {
    // v0.8.17 changed URL-nav from "poll-for-new-window-or-fail" to
    // "trust the OS launch, let the pipeline's verifier check ground
    // truth." The previous logic timed out at 8s every time the user's
    // browser reused an existing tab (no new window appeared) and
    // forced the pipeline to escalate unnecessarily.
    const adapter = makeStatefulAdapter({ postLaunchWindows: [] });
    const r = new Router(adapter);
    const res = await r.route('visit https://clawdcursor.com');
    expect(res.handled).toBe(true);
    expect(res.path).toBe('url_nav');
    // launchApp was invoked exactly once with the right URL — that's
    // the contract; whether a window surfaces is the verifier's call.
    expect(adapter.launchApp.mock.calls[0][1].url).toBe('https://clawdcursor.com');
  });

  it('REFUSES a multi-step "navigate to URL, search X and play it" — agent does the flow', async () => {
    // Run e388f690: the router navigated to youtube.com and reported DONE,
    // silently dropping "search for a song by Adele, and play it". A trailing
    // action after the URL means it's not a pure navigation — refuse so the
    // agent performs the whole flow.
    const adapter = makeStatefulAdapter({ postLaunchWindows: [] });
    const r = new Router(adapter, async () => 'C:\\fake\\msedge.exe');
    const res = await r.route('navigate to https://www.youtube.com, search for a song by Adele, and play it');
    expect(res.handled).toBe(false);
    expect(adapter.launchApp).not.toHaveBeenCalled();
  });

  it('still handles a pure nav with a benign "in the default browser" qualifier', async () => {
    const adapter = makeStatefulAdapter({ postLaunchWindows: [], platform: 'win32' });
    const r = new Router(adapter, async () => 'C:\\fake\\msedge.exe');
    const res = await r.route('navigate to https://en.wikipedia.org/wiki/Special:Random in the default browser');
    expect(res.handled).toBe(true);
    expect(res.path).toBe('url_nav');
    expect(adapter.launchApp.mock.calls[0][1].url).toBe('https://en.wikipedia.org/wiki/Special:Random');
  });

  it('refuses "navigate to X and <action>" (no comma) too', async () => {
    const adapter = makeStatefulAdapter({ postLaunchWindows: [] });
    const r = new Router(adapter, async () => 'C:\\fake\\msedge.exe');
    const res = await r.route('go to youtube.com and play a song');
    expect(res.handled).toBe(false);
    expect(adapter.launchApp).not.toHaveBeenCalled();
  });

  it('refuses a trailing action with a verb in NO list (structural, not verb-deny-list)', async () => {
    // "mute" / "zoom into" aren't in any action-verb list — the check is
    // structural (anything substantive after the URL = a 2nd step), so this
    // still refuses. Fail-SAFE: when unsure, the agent does the whole flow.
    const adapter = makeStatefulAdapter({ postLaunchWindows: [] });
    const r = new Router(adapter, async () => 'C:\\fake\\msedge.exe');
    expect((await r.route('go to example.com and mute the audio')).handled).toBe(false);
    expect((await r.route('navigate to example.com then zoom into the chart')).handled).toBe(false);
    expect(adapter.launchApp).not.toHaveBeenCalled();
  });

  it('still handles pure nav with benign qualifiers (in a new tab / incognito)', async () => {
    const adapter = makeStatefulAdapter({ postLaunchWindows: [], platform: 'win32' });
    const r = new Router(adapter, async () => 'C:\\fake\\msedge.exe');
    expect((await r.route('go to github.com in a new tab')).handled).toBe(true);
    expect(adapter.launchApp.mock.calls[0][1].url).toBe('https://github.com');
  });

  it('REGRESSION: handles "navigate to X in Microsoft Edge" (browser-name qualifier)', async () => {
    // Run 0a0dbd8d: this was wrongly refused because "Microsoft Edge" survived the
    // benign strip. "in <app/browser>" is a location qualifier, not a 2nd step.
    const adapter = makeStatefulAdapter({ postLaunchWindows: [], platform: 'win32' });
    const r = new Router(adapter, async () => 'C:\\fake\\msedge.exe');
    expect((await r.route('navigate to https://www.youtube.com in Microsoft Edge')).handled).toBe(true);
    expect(adapter.launchApp.mock.calls[0][1].url).toBe('https://www.youtube.com');
  });

  it('still REFUSES "navigate to X in incognito and search" (real 2nd step after qualifier)', async () => {
    const adapter = makeStatefulAdapter({ postLaunchWindows: [] });
    const r = new Router(adapter, async () => 'C:\\fake\\msedge.exe');
    expect((await r.route('navigate to youtube.com in incognito and search for adele')).handled).toBe(false);
    expect(adapter.launchApp).not.toHaveBeenCalled();
  });
});

describe('Router.route — web-service redirect (v0.9.0 fix)', () => {
  // Closes the "agent typed 'default browser' into a search bar" bug.
  // "open <web-service>" misses APP_ALIASES → would fall through Start-Menu
  // search → blind-agent escalation. The web-service table catches it first
  // and routes to handleUrlNav so the OS opens the registered http handler.

  it('"open youtube" redirects to https://www.youtube.com via url_nav', async () => {
    const adapter = makeStatefulAdapter({ postLaunchWindows: [] });
    const r = new Router(adapter, async () => 'C:\\fake\\msedge.exe');
    const res = await r.route('open youtube');
    expect(res.handled).toBe(true);
    expect(res.path).toBe('url_nav');
    expect(adapter.launchApp).toHaveBeenCalledWith(
      'C:\\fake\\msedge.exe',
      expect.objectContaining({ url: 'https://www.youtube.com' }),
    );
    expect(adapter.launchApp).not.toHaveBeenCalledWith('default-browser', expect.anything());
    expect(r.telemetry.webServiceRedirects).toBe(1);
  });

  it('"open reddit" routes to reddit.com', async () => {
    const adapter = makeStatefulAdapter({ postLaunchWindows: [] });
    const r = new Router(adapter);
    await r.route('open reddit');
    expect(adapter.launchApp.mock.calls[0][1].url).toBe('https://www.reddit.com');
  });

  it('"open gmail" routes to mail.google.com (no desktop Gmail client)', async () => {
    const adapter = makeStatefulAdapter({ postLaunchWindows: [] });
    const r = new Router(adapter);
    await r.route('open gmail');
    expect(adapter.launchApp.mock.calls[0][1].url).toBe('https://mail.google.com');
  });

  it('"open chrome" still goes through the desktop alias (NOT the web table)', async () => {
    // chrome has an APP_ALIASES entry, so the desktop client wins. Verifies
    // we didn't accidentally shadow native apps.
    const chrome = mkWindow({ processName: 'chrome', title: 'Chrome', processId: 99 });
    const adapter = makeStatefulAdapter({ postLaunchWindows: [chrome] });
    const r = new Router(adapter);
    await r.route('open chrome');
    expect(r.telemetry.webServiceRedirects).toBe(0);
    // launchApp called with the alias's launch args, not 'default-browser'
    expect(adapter.launchApp.mock.calls[0][0]).not.toBe('default-browser');
  });

  it('"open the youtube app" — filler-suffix stripped, still redirects', async () => {
    // normalizeAppName turns "the youtube app" into "youtube". Verifies the
    // web-service resolver runs through the same normalization as alias
    // resolution so phrasings line up.
    const adapter = makeStatefulAdapter({ postLaunchWindows: [] });
    const r = new Router(adapter);
    const res = await r.route('open the youtube app');
    expect(res.path).toBe('url_nav');
    expect(adapter.launchApp.mock.calls[0][1].url).toBe('https://www.youtube.com');
  });
});

describe('Router.route — misc paths', () => {
  it('handles "focus Chrome"', async () => {
    const adapter = makeStatefulAdapter();
    const r = new Router(adapter);
    const res = await r.route('focus Chrome');
    expect(res.handled).toBe(true);
    expect(res.path).toBe('focus');
    expect(r.telemetry.focusHits).toBe(1);
  });

  it('refuses compound tasks', async () => {
    const adapter = makeStatefulAdapter();
    const r = new Router(adapter);
    const res = await r.route('open Chrome and type hello');
    expect(res.handled).toBe(false);
    expect(r.telemetry.compoundRefused).toBe(1);
  });

  it('returns { handled: false } for reasoning tasks', async () => {
    const adapter = makeStatefulAdapter();
    const r = new Router(adapter);
    const res = await r.route('summarize this article');
    expect(res.handled).toBe(false);
    expect(r.telemetry.llmFallbacks).toBe(1);
  });
});
