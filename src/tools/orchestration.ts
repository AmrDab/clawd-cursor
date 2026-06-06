/**
 * Orchestration tools — delegate tasks, launch apps, navigate browser.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import type { ToolDefinition } from './types';
import { DEFAULT_CDP_PORT } from '../llm/browser-config';
import { resolveAlias } from '../core/router/aliases';

const execFileAsync = promisify(execFile);

async function commandExists(cmd: string): Promise<boolean> {
  try {
    await execFileAsync('which', [cmd], { timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

export function getOrchestrationTools(): ToolDefinition[] {
  return [
    {
      name: 'delegate_to_agent',
      description:
        "Hand a whole task to clawdcursor's built-in thin agent loop, which drives the toolbox with the model configured via `clawdcursor doctor` (perceive → act → iterate until done). " +
        "For an expensive frontier model this is the delegation lever: hand grunt work to a cheaper configured model that takes the wheel. " +
        "Requires `clawdcursor agent` running WITH a model configured; in tools-only / --no-llm mode there is no model to drive it.",
      parameters: {
        task: { type: 'string', description: 'Natural language task description', required: true },
        timeout: { type: 'number', description: 'Advisory; the agent enforces its own wall-clock timeout', required: false },
      },
      category: 'orchestration',
      compactGroup: 'task',
      safetyTier: 1,
      handler: async ({ task }, ctx) => {
        // Run the task IN-PROCESS on the daemon's configured-model agent.
        // (This previously self-called the daemon's own /mcp via mcpCall, which
        // the streamable-HTTP transport rejects with "Already connected to a
        // transport" — a re-entrant MCP call. Calling ctx.agent directly avoids
        // the self-call and returns a clean error when no model is configured.)
        if (!ctx?.agent) {
          return { text: 'delegate_to_agent: no model-backed agent attached. This needs `clawdcursor agent` running WITH a model configured (run `clawdcursor doctor`). In tools-only / --no-llm mode there is no model to drive the task — drive the toolbox tools directly instead.', isError: true };
        }
        try {
          const result = await ctx.agent.executeTask(String(task ?? ''));
          return {
            text: JSON.stringify({
              success: result.success,
              steps: result.steps?.length ?? 0,
              duration: `${((result.duration ?? 0) / 1000).toFixed(1)}s`,
              lastAction: result.steps?.slice(-1)?.[0]?.description ?? '(unknown)',
            }, null, 2),
            isError: !result.success,
          };
        } catch (err: any) {
          return { text: `delegate_to_agent: ${err?.message ?? String(err)}`, isError: true };
        }
      },
    },

    {
      name: 'open_app',
      description: 'Open an application by name. Uses the cross-OS app alias table + the PlatformAdapter\'s launchApp (UWP-aware on Windows, `open -a` on macOS, gtk-launch / xdg-open on Linux).',
      parameters: {
        name: { type: 'string', description: 'Application name (e.g. "notepad", "calc", "mspaint", "Outlook", "Chrome")', required: true },
      },
      category: 'orchestration',
      compactGroup: 'window',
      safetyTier: 1,
      handler: async ({ name }, ctx) => {
        await ctx.ensureInitialized();
        const rawName = String(name ?? '');
        if (!rawName) {
          return { text: 'open_app: `name` is required', isError: true };
        }

        // Resolve through the canonical alias table so "Notepad" / "notepad" /
        // "Calculator" / "calc" all map to the right launch hints. The MCP
        // open_app used to call `Start-Process <name>` directly, which fails
        // for UWP apps (Calculator, Win11 Notepad) and is case-sensitive on
        // PowerShell's Start-Process arg. The alias table + platform adapter
        // is the same path the autonomous agent-loop uses.
        const alias = resolveAlias(rawName);

        // If we have a PlatformAdapter (we always do post-v0.9 init), use it.
        // Falls back to the old execFile path only when the adapter isn't
        // available (shouldn't happen in normal operation).
        if (ctx.platform && typeof ctx.platform.launchApp === 'function') {
          let launchName = rawName;
          if (alias) {
            if (process.platform === 'darwin') {
              launchName = alias.macOSAppName ?? rawName;
            } else if (process.platform === 'win32') {
              launchName = alias.executable ?? rawName;
            } else {
              launchName = alias.executable?.replace(/\.exe$/i, '') ?? rawName;
            }
          }
          try {
            const res = await ctx.platform.launchApp(launchName, {
              alwaysNewInstance: alias?.alwaysNewInstance,
              uwpAppId: alias?.uwpAppId,
              searchTerm: alias?.searchTerm
                ?? (process.platform === 'darwin' ? alias?.macOSAppName : undefined),
            });
            ctx.a11y.invalidateCache();
            return {
              text: res?.title
                ? `Opened "${rawName}" (pid=${res.pid}, window="${res.title}")`
                : `Launched "${rawName}" (no window surfaced yet)`,
            };
          } catch (err: any) {
            return { text: `Failed to launch "${rawName}": ${err?.message ?? err}`, isError: true };
          }
        }

        // Fallback: pre-adapter path (kept for safety, should be unreachable).
        try {
          if (process.platform === 'win32') {
            const exe = alias?.executable ?? rawName;
            const uwpId = alias?.uwpAppId;
            if (uwpId) {
              await execFileAsync('explorer.exe', [`shell:AppsFolder\\${uwpId}`], { timeout: 10000 });
            } else {
              await execFileAsync('powershell.exe', ['-NoProfile', '-Command', `Start-Process "${exe}"`], { timeout: 10000 });
            }
          } else if (process.platform === 'darwin') {
            await execFileAsync('open', ['-a', alias?.macOSAppName ?? rawName], { timeout: 10000 });
          } else {
            const linuxName = alias?.executable?.replace(/\.exe$/i, '') ?? rawName;
            if (await commandExists('gtk-launch')) {
              await execFileAsync('gtk-launch', [linuxName], { timeout: 10000 });
            } else if (await commandExists('xdg-open')) {
              await execFileAsync('xdg-open', [linuxName], { timeout: 10000 });
            } else {
              await execFileAsync(linuxName, [], { timeout: 10000 });
            }
          }
          await new Promise(r => setTimeout(r, 2000));
          ctx.a11y.invalidateCache();
          return { text: `Launched: ${rawName}` };
        } catch (err: any) {
          return { text: `Failed to launch "${rawName}": ${err.message}`, isError: true };
        }
      },
    },

    {
      name: 'navigate_browser',
      description: `Open a URL in the browser. Launches with CDP enabled (port ${DEFAULT_CDP_PORT}) for DOM interaction. Call cdp_connect after. Tier 2 (mutation): triggers network egress to an arbitrary destination + spawns/attaches to a browser process.`,
      parameters: {
        url: { type: 'string', description: 'URL to navigate to', required: true },
      },
      category: 'orchestration',
      compactGroup: 'window',
      safetyTier: 2,
      handler: async ({ url }, ctx) => {
        await ctx.ensureInitialized();
        if (await ctx.cdp.isConnected()) {
          try {
            const page = ctx.cdp.getPage();
            if (page) {
              await page.goto(url, { timeout: 30000, waitUntil: 'domcontentloaded' });
              const title = await page.title().catch(() => '(loading)');
              return { text: `Navigated to: "${title}" at ${url}` };
            }
          } catch { /* fall through */ }
        }
        try {
          const userDataDir = path.join(process.env.TEMP || process.env.TMPDIR || '/tmp', 'clawdcursor-edge');
          if (process.platform === 'win32') {
            // Direct exec instead of `powershell -Command "Start-Process …"`:
            // the previous form interpolated `url` into a PowerShell string,
            // letting a crafted URL (`")` / `$()` / backtick) escape the
            // quoting and run arbitrary code. execFile with argv is safe.
            // Edge installs in well-known locations; fall back to the one
            // that exists. `where.exe msedge` would also work but adds an
            // extra spawn for the common case.
            const edgeCandidates = [
              path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
              path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
            ];
            const edgeExe = edgeCandidates.find(p => { try { return fs.existsSync(p); } catch { return false; } });
            if (!edgeExe) {
              throw new Error('msedge.exe not found in standard install locations');
            }
            await execFileAsync(edgeExe, [
              `--remote-debugging-port=${DEFAULT_CDP_PORT}`,
              `--user-data-dir=${userDataDir}`,
              '--no-first-run',
              '--disable-default-apps',
              url,
            ], { timeout: 10000 });
          } else if (process.platform === 'darwin') {
            await execFileAsync('open', ['-a', 'Google Chrome', '--args',
              `--remote-debugging-port=${DEFAULT_CDP_PORT}`, `--user-data-dir=${userDataDir}`, '--no-first-run', url
            ], { timeout: 10000 });
          } else {
            // Linux: try common browser binaries in order.
            const browserCandidates = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'];
            let launched = false;
            for (const browserCmd of browserCandidates) {
              if (!(await commandExists(browserCmd))) continue;
              await execFileAsync(browserCmd, [
                `--remote-debugging-port=${DEFAULT_CDP_PORT}`, `--user-data-dir=${userDataDir}`, '--no-first-run', url,
              ], { timeout: 10000 });
              launched = true;
              break;
            }
            if (!launched) {
              throw new Error('No supported browser binary found (tried: google-chrome, chromium, microsoft-edge)');
            }
          }
          await new Promise(r => setTimeout(r, 3000));
          ctx.a11y.invalidateCache();
          return { text: `Opened: ${url} (CDP port ${DEFAULT_CDP_PORT} enabled)` };
        } catch (err: any) {
          return { text: `Navigation failed: ${err.message}`, isError: true };
        }
      },
    },

    {
      name: 'wait',
      description: 'Wait for a specified duration. Useful after animations or page loads.',
      parameters: {
        seconds: { type: 'number', description: 'Duration to wait (0.1 to 30)', required: true, minimum: 0.1, maximum: 30 },
      },
      category: 'orchestration',
      compactGroup: 'computer',
      safetyTier: 0,
      handler: async ({ seconds }) => {
        await new Promise(r => setTimeout(r, seconds * 1000));
        return { text: `Waited ${seconds}s` };
      },
    },
  ];
}
