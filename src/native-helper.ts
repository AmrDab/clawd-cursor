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

export class NativeHelper {
  private process: ChildProcess | null = null;
  private requestId = 0;
  private pendingRequests = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private readline: readline.Interface | null = null;

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

  private getHelperPath(): string {
    if (!IS_MACOS) {
      throw new Error('Native helper is only available on macOS');
    }
    // Look for the helper in various locations
    const locations = [
      // Development: native/ClawdCursor.app
      path.join(__dirname, '..', 'native', 'ClawdCursor.app', 'Contents', 'MacOS', 'clawdcursor-helper'),
      // Installed via npm: node_modules/.clawdcursor/ClawdCursor.app
      path.join(__dirname, '..', 'node_modules', '.clawdcursor', 'ClawdCursor.app', 'Contents', 'MacOS', 'clawdcursor-helper'),
      // Global install
      path.join(os.homedir(), '.clawdcursor', 'ClawdCursor.app', 'Contents', 'MacOS', 'clawdcursor-helper'),
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
    if (this.process) {
      this.process.kill();
      this.process = null;
      this.readline = null;
    }
  }

  private async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (!this.process) {
      await this.start();
    }

    const id = ++this.requestId;
    const request: JsonRpcRequest = { id, method, params };

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

  const permissionCheckPath = path.join(
    __dirname, '..', 'native', 'ClawdCursor.app', 'Contents', 'MacOS', 'permission-check'
  );

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

/**
 * Check if we're running on macOS
 */
export function isMacOS(): boolean {
  return IS_MACOS;
}
