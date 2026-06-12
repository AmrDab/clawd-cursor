/**
 * Control banner — the on-screen "ClawdCursor — desktop control in progress"
 * indicator (scripts/banner.ps1: topmost, no-activate, blinking red dot).
 *
 * Transparency contract: whenever an agent is actively driving this desktop,
 * a human at the machine sees it — and can kill it (double-click → the parent
 * runs the `clawdcursor stop` flow). Two lifecycles feed it:
 *
 *   - pin()/unpin(): the autonomous task loop pins the banner for the whole
 *     task (agent.executeTask). A pinned banner ignores idle timers.
 *   - touch(): every consequential (safetyTier ≥ 1) MCP tool call pokes the
 *     banner; it shows on the first poke and auto-hides after IDLE_HIDE_MS of
 *     inactivity. This covers EXTERNAL agents (editor-hosted over stdio or
 *     HTTP /mcp) where there is no task boundary to hook.
 *
 * Windows-only today (WinForms via the warm PowerShell host); macOS/Linux are
 * silent no-ops — the API is platform-neutral so adapters can land later.
 * Disable via `--no-banner` or CLAWD_NO_BANNER=1.
 */

import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import * as readline from 'readline';
import { getPackageRoot } from '../paths';

const IDLE_HIDE_MS = 30_000;

type Spawner = () => ChildProcess;

class ControlBanner {
  private child: ChildProcess | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private pinned = false;
  private enabled = process.platform === 'win32' && process.env.CLAWD_NO_BANNER !== '1';
  private onStopRequested: (() => void) | undefined;
  private spawner: Spawner = () => {
    const script = path.join(getPackageRoot(), 'scripts', 'banner.ps1');
    return spawn('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script],
      { stdio: ['ignore', 'pipe', 'ignore'] });
  };

  /** Wire the double-click → stop callback (the `clawdcursor stop` flow). */
  configure(opts: { onStopRequested?: () => void }): void {
    this.onStopRequested = opts.onStopRequested;
  }

  /** Hard enable/disable (CLI --no-banner / config). Disabling hides immediately. */
  setEnabled(v: boolean): void {
    this.enabled = v && process.platform === 'win32' && process.env.CLAWD_NO_BANNER !== '1';
    if (!this.enabled) this.forceHide();
  }

  isVisible(): boolean {
    return this.child !== null;
  }

  /** Show and keep shown until unpin() — the autonomous-task lifecycle. */
  pin(): void {
    if (!this.enabled) return;
    this.pinned = true;
    this.clearIdleTimer();
    this.show();
  }

  /** Release the task pin; hides unless tool activity re-touches it. */
  unpin(): void {
    this.pinned = false;
    this.forceHide();
  }

  /**
   * Activity poke from a consequential tool call: show now, auto-hide after
   * IDLE_HIDE_MS without further pokes. No-op on the timer while pinned.
   */
  touch(idleMs: number = IDLE_HIDE_MS): void {
    if (!this.enabled) return;
    this.show();
    if (this.pinned) return; // task lifecycle owns visibility
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.pinned) this.forceHide();
    }, idleMs);
    this.idleTimer.unref?.();
  }

  private exitHookInstalled = false;

  private show(): void {
    if (!this.enabled || this.child) return;
    let child: ChildProcess;
    try {
      child = this.spawner();
    } catch {
      return; // cosmetic feature — never let it break control
    }
    this.child = child;
    // The banner must never outlive its owner — an orphaned "control in
    // progress" pill after the daemon stopped would be a lie on screen.
    // kill() is a sync syscall, safe inside an 'exit' handler.
    if (!this.exitHookInstalled) {
      this.exitHookInstalled = true;
      process.on('exit', () => { try { this.child?.kill(); } catch { /* gone */ } });
    }
    if (child.stdout) {
      const rl = readline.createInterface({ input: child.stdout });
      rl.on('line', line => {
        if (line.trim() === 'BANNER_STOP') {
          try { this.onStopRequested?.(); } catch { /* never throw into the rl loop */ }
        }
      });
    }
    child.on('error', () => { if (this.child === child) this.child = null; });
    child.on('exit', () => { if (this.child === child) this.child = null; });
  }

  private forceHide(): void {
    this.clearIdleTimer();
    const c = this.child;
    this.child = null;
    if (c) {
      try { c.kill(); } catch { /* already gone */ }
    }
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  // ── test hooks ──
  __setSpawnerForTests(s: Spawner): void { this.spawner = s; }
  __setPlatformEnabledForTests(v: boolean): void { this.enabled = v; }
  __resetForTests(): void {
    this.forceHide();
    this.pinned = false;
    this.onStopRequested = undefined;
  }
}

/** Singleton — one banner per process (daemon or stdio MCP server). */
export const controlBanner = new ControlBanner();
