/**
 * ClawdCursor Native Helper Integration (macOS only)
 * Communicates with the Swift helper via JSON-RPC over stdio
 * 
 * On non-macOS platforms, all methods are no-ops or return appropriate defaults.
 */

import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as readline from 'readline';

const IS_MACOS = process.platform === 'darwin';
const HOST_PORT = parseInt(process.env.CLAWDCURSOR_HOST_PORT || '3848', 10);
const HOST_BASE_URL = `http://127.0.0.1:${HOST_PORT}`;
const ALLOW_MAC_FALLBACK = process.env.CLAWDCURSOR_ALLOW_MAC_HELPER_FALLBACK === '1';

interface JsonRpcRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface PermissionStatus {
  accessibility: boolean;
  screenRecording: boolean;
  processPath?: string;
  bundleId?: string;
}

interface UIElement {
  role?: string;
  title?: string;
  value?: string;
  description?: string;
  position?: { x: number; y: number };
  size?: { width: number; height: number };
  enabled: boolean;
  focused: boolean;
  children?: UIElement[];
}

interface WindowInfo {
  windowId: number;
  ownerPid: number;
  ownerName: string;
  windowName: string;
  bounds: { X: number; Y: number; Width: number; Height: number };
}

interface CapturedScreen {
  success: boolean;
  width: number;
  height: number;
  format: 'png';
  imageBase64: string;
}

export class NativeHelper {
  private process: ChildProcess | null = null;
  private requestId = 0;
  private pendingRequests = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private readline: readline.Interface | null = null;
  private useHostIpc = IS_MACOS;

  /**
   * Check if native helper is available (macOS only)
   */
  isAvailable(): boolean {
    if (!IS_MACOS) return false;
    try {
      this.getHelperPath();
      return true;
    } catch {
      return false;
    }
  }

  private getHelperPath(binary = 'clawdcursor-helper'): string {
    if (!IS_MACOS) {
      throw new Error('Native helper is only available on macOS');
    }
    // Look for the helper in various locations
    const locations = [
      // Development: native/ClawdCursor.app
      path.join(__dirname, '..', 'native', 'ClawdCursor.app', 'Contents', 'MacOS', binary),
      // Installed via npm: node_modules/.clawdcursor/ClawdCursor.app
      path.join(__dirname, '..', 'node_modules', '.clawdcursor', 'ClawdCursor.app', 'Contents', 'MacOS', binary),
      // Global install
      path.join(os.homedir(), '.clawdcursor', 'ClawdCursor.app', 'Contents', 'MacOS', binary),
    ];

    for (const loc of locations) {
      if (fs.existsSync(loc)) {
        return loc;
      }
    }

    throw new Error(
      'ClawdCursor native helper not found. On macOS, run: cd native && ./build.sh\n' +
      'Searched locations:\n' + locations.map(l => `  - ${l}`).join('\n')
    );
  }

  async start(): Promise<void> {
    if (!IS_MACOS) {
      throw new Error('Native helper is only available on macOS');
    }
    if (this.useHostIpc) {
      await ensureHostAppRunning();
      return;
    }
    if (this.process) return;

    const helperPath = this.getHelperPath();
    
    this.process = spawn(helperPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.readline = readline.createInterface({
      input: this.process.stdout!,
      crlfDelay: Infinity,
    });

    this.readline.on('line', (line) => {
      try {
        const response = JSON.parse(line) as JsonRpcResponse;
        const pending = this.pendingRequests.get(response.id);
        if (pending) {
          this.pendingRequests.delete(response.id);
          if (response.error) {
            pending.reject(new Error(`${response.error.message} (code ${response.error.code})`));
          } else {
            pending.resolve(response.result);
          }
        }
      } catch {
        // Ignore non-JSON lines (could be debug output)
      }
    });

    this.process.stderr?.on('data', (data) => {
      const msg = data.toString();
      // Check for permission errors
      if (msg.includes('accessibility_denied') || msg.includes('screen_recording_denied')) {
        console.error(`\n⚠️  Permission Error:\n${msg}`);
      }
    });

    this.process.on('exit', (code) => {
      this.process = null;
      this.readline = null;
      // Reject all pending requests
      for (const [id, pending] of this.pendingRequests) {
        pending.reject(new Error(`Helper process exited with code ${code}`));
        this.pendingRequests.delete(id);
      }
    });
  }

  async stop(): Promise<void> {
    if (this.useHostIpc) return;
    if (this.process) {
      this.process.kill();
      this.process = null;
      this.readline = null;
    }
  }

  private async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const id = ++this.requestId;
    const request: JsonRpcRequest = { id, method, params };

    if (this.useHostIpc) {
      await ensureHostAppRunning();
      const res = await fetch(`${HOST_BASE_URL}/rpc`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-clawdcursor-token': getOrCreateHostToken(),
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) {
        throw new Error(`Host IPC call failed (${res.status})`);
      }
      const rpc = await res.json() as JsonRpcResponse;
      if (rpc.error) {
        throw new Error(`${rpc.error.message} (code ${rpc.error.code})`);
      }
      return rpc.result as T;
    }

    if (!this.process) {
      await this.start();
    }

    return new Promise((resolve, reject) => {
      // Guard against process dying between start() and write()
      if (!this.process?.stdin) {
        reject(new Error('Helper process not available'));
        return;
      }

      const timeoutMs = 30000; // 30 second timeout
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(id, { 
        resolve: (value) => {
          clearTimeout(timeout);
          (resolve as (value: unknown) => void)(value);
        }, 
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        }
      });

      this.process.stdin.write(JSON.stringify(request) + '\n');
    });
  }

  // MARK: - Public API

  async checkPermissions(): Promise<PermissionStatus> {
    return this.call<PermissionStatus>('checkPermissions');
  }

  async traverseAccessibilityTree(pid: number, options?: {
    maxDepth?: number;
    maxElements?: number;
  }): Promise<{ pid: number; elementCount: number; tree: UIElement }> {
    return this.call('traverseAccessibilityTree', { pid, ...options });
  }

  async click(x: number, y: number, options?: {
    button?: 'left' | 'right';
    clickCount?: number;
  }): Promise<{ success: boolean; x: number; y: number }> {
    return this.call('click', { x, y, ...options });
  }

  async moveMouse(x: number, y: number): Promise<{ success: boolean; x: number; y: number }> {
    return this.call('moveMouse', { x, y });
  }

  async dragMouse(startX: number, startY: number, endX: number, endY: number): Promise<{ success: boolean }> {
    return this.call('dragMouse', { startX, startY, endX, endY });
  }

  async type(text: string, options?: { delayMs?: number }): Promise<{ success: boolean; length: number }> {
    return this.call('type', { text, ...options });
  }

  async pressKey(key: string, modifiers?: string[]): Promise<{ success: boolean; key: string; modifiers: string[] }> {
    return this.call('pressKey', { key, modifiers });
  }

  async openApp(name?: string, bundleId?: string): Promise<{ success: boolean; pid: number }> {
    return this.call('openApp', { name, bundleId });
  }

  async getWindowList(): Promise<{ windows: WindowInfo[] }> {
    return this.call('getWindowList');
  }

  async captureScreen(): Promise<CapturedScreen> {
    return this.call('captureScreen');
  }
}

// Singleton instance
let instance: NativeHelper | null = null;

export function getNativeHelper(): NativeHelper {
  if (!instance) {
    instance = new NativeHelper();
    // Cleanup on process exit
    process.on('exit', () => {
      instance?.stop();
    });
    process.on('SIGTERM', () => {
      instance?.stop();
      process.exit(0);
    });
    process.on('SIGINT', () => {
      instance?.stop();
      process.exit(0);
    });
  }
  return instance;
}

// Quick permission check (doesn't need full helper running)
// On non-macOS platforms, returns permissions as granted (not applicable)
export async function checkPermissionsQuick(): Promise<PermissionStatus> {
  // On non-macOS platforms, permissions aren't needed in the same way
  if (!IS_MACOS) {
    return {
      accessibility: true,  // Not applicable on Windows/Linux
      screenRecording: true,
      processPath: process.execPath,
      bundleId: undefined,
    };
  }

  if (await isHostRunning()) {
    const res = await fetch(`${HOST_BASE_URL}/status`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      return res.json() as Promise<PermissionStatus>;
    }
  }

  if (!ALLOW_MAC_FALLBACK) {
    throw new Error('ClawdCursor host is required on macOS. Build/launch ClawdCursor.app or set CLAWDCURSOR_ALLOW_MAC_HELPER_FALLBACK=1 for temporary dev fallback.');
  }

  const permissionCheckPath = getNativeHelperPath('permission-check');

  if (!fs.existsSync(permissionCheckPath)) {
    // Fall back to full helper
    return getNativeHelper().checkPermissions();
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(permissionCheckPath, []);
    let stdout = '';
    let stderr = '';

    // 10 second timeout for permission check
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error('permission-check timed out'));
    }, 10000);

    proc.stdout.on('data', (data) => { stdout += data; });
    proc.stderr.on('data', (data) => { stderr += data; });

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`permission-check failed: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`Invalid permission-check output: ${stdout}`));
      }
    });
  });
}

function getNativeHelperPath(binary: string): string {
  const locations = [
    path.join(__dirname, '..', 'native', 'ClawdCursor.app', 'Contents', 'MacOS', binary),
    path.join(__dirname, '..', 'node_modules', '.clawdcursor', 'ClawdCursor.app', 'Contents', 'MacOS', binary),
    path.join(os.homedir(), '.clawdcursor', 'ClawdCursor.app', 'Contents', 'MacOS', binary),
  ];
  for (const loc of locations) {
    if (fs.existsSync(loc)) return loc;
  }
  throw new Error(`ClawdCursor app binary not found: ${binary}`);
}

export async function isHostRunning(): Promise<boolean> {
  if (!IS_MACOS) return false;
  try {
    const res = await fetch(`${HOST_BASE_URL}/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function ensureHostAppRunning(): Promise<void> {
  if (!IS_MACOS) return;
  if (await isHostRunning()) return;

  const appExecutable = getNativeHelperPath('ClawdCursorHost');
  const appPath = path.resolve(appExecutable, '..', '..', '..');
  await new Promise<void>((resolve, reject) => {
    const opener = spawn('open', ['-a', appPath], { stdio: 'ignore' });
    opener.on('error', reject);
    opener.on('close', () => resolve());
  });

  const started = Date.now();
  while (Date.now() - started < 10000) {
    if (await isHostRunning()) return;
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('ClawdCursor host app did not start in time');
}

export async function stopHostApp(): Promise<void> {
  if (!IS_MACOS) return;
  await new Promise<void>((resolve) => {
    const proc = spawn('osascript', ['-e', 'tell application id "com.clawdcursor.app" to quit'], { stdio: 'ignore' });
    proc.on('close', () => resolve());
    proc.on('error', () => resolve());
  });

  const started = Date.now();
  while (Date.now() - started < 3000) {
    if (!(await isHostRunning())) return;
    await new Promise(r => setTimeout(r, 200));
  }
  // stale process recovery
  await new Promise<void>((resolve) => {
    const proc = spawn('pkill', ['-f', 'ClawdCursorHost'], { stdio: 'ignore' });
    proc.on('close', () => resolve());
    proc.on('error', () => resolve());
  });
}

function getOrCreateHostToken(): string {
  const dir = path.join(os.homedir(), '.clawdcursor');
  const tokenPath = path.join(dir, 'host-token');
  if (fs.existsSync(tokenPath)) {
    return fs.readFileSync(tokenPath, 'utf-8').trim();
  }
  fs.mkdirSync(dir, { recursive: true });
  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 18)}`;
  fs.writeFileSync(tokenPath, token, { mode: 0o600 });
  return token;
}

/**
 * Check if we're running on macOS
 */
export function isMacOS(): boolean {
  return IS_MACOS;
}
