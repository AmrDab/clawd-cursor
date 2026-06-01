/**
 * HTTP utility surface — the small set of plain-HTTP routes that survived
 * the v0.9 PR7 cutover when REST endpoints were collapsed into MCP tools.
 *
 * Surviving routes (they're operational endpoints, not tools):
 *   GET  /health   — readiness probe (no auth, returns JSON status)
 *   POST /stop     — graceful shutdown (Bearer auth, localhost only)
 *   GET  /         — single-page dashboard (mountDashboard wires this)
 *
 * Everything else moved to MCP tools and is exposed via the streamable
 * HTTP transport at /mcp. See src/mcp-server.ts.
 *
 * Auth — the daemon generates a 32-byte Bearer token on startup, persists
 * it to ~/.clawdcursor/token, and the same requireAuth() middleware here
 * gates /stop and /mcp. /health and / (dashboard) are public; the
 * dashboard's inline JS reads the token from a server-injected placeholder
 * and uses it for /mcp calls.
 */

import express from 'express';
import { readFileSync, existsSync, mkdirSync, writeFileSync, statSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { mountDashboard } from './dashboard';
import { VERSION } from './version';
import { DATA_DIR } from '../paths';
import { e } from './format';

const TOKEN_PATH = join(DATA_DIR, 'token');

// ── Bearer token state ──────────────────────────────────────────────────
//
// The token is generated lazily — only when the daemon binds its port
// (see initServerToken). This prevents CLI commands like `stop`, `task`,
// or `consent` from overwriting the running server's token file when they
// import this module.
//
// v0.8.2 silent-401 fix: requireAuth accepts EITHER the in-memory
// SERVER_TOKEN or whatever's currently on disk. A second clawdcursor
// process that rotates the file won't silently 401 clients that read the
// new token from disk.

export let SERVER_TOKEN = '';

function generateToken(): string {
  const token = randomBytes(32).toString('hex');
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(TOKEN_PATH, token, { encoding: 'utf-8', mode: 0o600 });
  } catch (tokenErr) {
    console.warn(`${e('⚠', '[WARN]')} Could not write auth token file:`, (tokenErr as Error).message);
  }
  return token;
}

/** Initialize the auth token. Called once from the daemon's listen callback. */
export function initServerToken(): string {
  SERVER_TOKEN = generateToken();
  diskTokenCache = { token: SERVER_TOKEN, mtimeMs: Date.now(), nextCheckMs: 0 };
  return SERVER_TOKEN;
}

let diskTokenCache: { token: string; mtimeMs: number; nextCheckMs: number } | null = null;
const DISK_TOKEN_TTL_MS = 500;

function currentDiskToken(): string {
  const now = Date.now();
  try {
    if (diskTokenCache && now < diskTokenCache.nextCheckMs) {
      return diskTokenCache.token;
    }
    const stat = statSync(TOKEN_PATH);
    const mtimeMs = stat.mtimeMs;
    if (diskTokenCache && diskTokenCache.mtimeMs === mtimeMs) {
      diskTokenCache.nextCheckMs = now + DISK_TOKEN_TTL_MS;
      return diskTokenCache.token;
    }
    const token = readFileSync(TOKEN_PATH, 'utf-8').trim();
    diskTokenCache = { token, mtimeMs, nextCheckMs: now + DISK_TOKEN_TTL_MS };
    return token;
  } catch {
    return '';
  }
}

/** Constant-time token compare — no byte-level timing leak on localhost. */
function timingSafeTokenEqual(received: string, expected: string): boolean {
  if (!received || !expected) return false;
  const a = Buffer.from(received, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {

    require('crypto').timingSafeEqual(a, a);
    return false;
  }

  return require('crypto').timingSafeEqual(a, b);
}

let loggedTokenDrift = false;
function readCookieToken(req: express.Request): string {
  const raw = req.headers.cookie;
  if (!raw) return '';
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === 'clawdcursor_token') return decodeURIComponent(rest.join('='));
  }
  return '';
}
export function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const authHeader = req.headers['authorization'] || '';
  const headerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const cookieToken = readCookieToken(req);
  const received = headerToken || cookieToken;

  const memoryOk = timingSafeTokenEqual(received, SERVER_TOKEN);
  let diskOk = false;
  if (!memoryOk && process.env.CLAWD_ALLOW_DISK_TOKEN_DRIFT === '1') {
    const diskToken = currentDiskToken();
    if (diskToken && diskToken !== SERVER_TOKEN) {
      if (!loggedTokenDrift) {
        loggedTokenDrift = true;
        console.warn(
          `${e('⚠', '[WARN]')} Auth token file was rewritten by another process. ` +
          `Accepting either the original or the new token to avoid silent 401s. ` +
          `Run \`clawdcursor stop\` once and restart if you want a single canonical token.`,
        );
      }
      diskOk = timingSafeTokenEqual(received, diskToken);
    }
  }

  if (!memoryOk && !diskOk) {
    res.status(401).json({ error: 'Unauthorized — include Authorization: Bearer <token> header. Token is at ~/.clawdcursor/token' });
    return;
  }
  next();
}

// ── Log buffer (server-side console capture for the dashboard) ─────────

interface LogEntry {
  timestamp: number;
  level: 'info' | 'success' | 'warn' | 'error';
  message: string;
}

const MAX_LOGS = 200;
const logBuffer: LogEntry[] = [];
const MAX_LOG_MSG_LEN = 500;

function addLog(level: LogEntry['level'], message: string): void {
  const truncated = message.length > MAX_LOG_MSG_LEN
    ? message.slice(0, MAX_LOG_MSG_LEN) + '…'
    : message;
  logBuffer.push({ timestamp: Date.now(), level, message: truncated });
  if (logBuffer.length > MAX_LOGS) {
    logBuffer.splice(0, logBuffer.length - MAX_LOGS);
  }
}

let consoleHooked = false;
function hookConsole(): void {
  if (consoleHooked) return;
  consoleHooked = true;

  const origLog = console.log;
  const origError = console.error;
  const origWarn = console.warn;

  console.log = (...args: unknown[]) => {
    origLog.apply(console, args);
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    const lower = msg.toLowerCase();
    if (lower.includes('error') || lower.includes('failed') || lower.includes('❌')) {
      addLog('error', msg);
    } else if (lower.includes('✅') || lower.includes('success') || lower.includes('completed')) {
      addLog('success', msg);
    } else if (lower.includes('⚠') || lower.includes('warn')) {
      addLog('warn', msg);
    } else {
      addLog('info', msg);
    }
  };

  console.error = (...args: unknown[]) => {
    origError.apply(console, args);
    const msg = args.map(a => typeof a === 'string' ? a : (a instanceof Error ? a.message : JSON.stringify(a))).join(' ');
    addLog('error', msg);
  };

  console.warn = (...args: unknown[]) => {
    origWarn.apply(console, args);
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    addLog('warn', msg);
  };
}

/** Read-only snapshot accessor for the captured log buffer. */
export function getServerLogBuffer(): LogEntry[] {
  return logBuffer.slice();
}

// ── Express app factory ─────────────────────────────────────────────────

export interface UtilityServerOptions {
  /** Called when /stop is invoked (graceful shutdown). */
  onStop: () => void | Promise<void>;
  /** Optional host — used only for the dashboard CORS warning. */
  host?: string;
}

/**
 * Build the surviving plain-HTTP surface: /, /health, /stop. The MCP
 * transport at /mcp must be mounted by the caller (it shares the auth
 * gate exported above).
 */
export function createUtilityServer(options: UtilityServerOptions): express.Express {
  hookConsole();

  const app = express();
  app.use(express.json());

  // ── CORS ──
  // Block browser-origin requests to prevent SSRF / localhost-bypass
  // attacks. The dashboard at GET / is exempt (browser tab); all other
  // routes require either no Origin (curl/CLI) or an allowed localhost
  // origin.
  app.use((req, res, next) => {
    const origin = req.headers['origin'];
    const allowedOrigins = [
      'http://localhost:3847',
      'http://127.0.0.1:3847',
    ];
    if (origin) {
      if (allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id');
        res.setHeader('Vary', 'Origin');
      } else {
        if (req.method === 'OPTIONS') { res.status(204).end(); return; }
        res.status(403).json({ error: 'Cross-origin requests not allowed' });
        return;
      }
    }
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }
    next();
  });

  // Handle malformed JSON gracefully.
  app.use((err: any, _req: any, res: any, next: any) => {
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Invalid JSON in request body' });
    }
    next(err);
  });

  // Mount the dashboard at GET /. SECURITY: token is injected into page JS;
  // only safe when bound to localhost.
  if (options.host && options.host !== '127.0.0.1' && options.host !== 'localhost') {
    console.warn(`${e('⚠️', '[WARN]')} Dashboard token exposed in page JS — only safe on localhost (current host: ${options.host})`);
  }
  mountDashboard(app, () => SERVER_TOKEN);

  // GET /health — public readiness probe.
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', version: VERSION });
  });

  // POST /stop — Bearer-gated, localhost-only graceful shutdown.
  app.post('/stop', requireAuth, (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || '';
    const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    if (!isLocal) {
      return res.status(403).json({ error: 'Stop is only allowed from localhost' });
    }

    const body = JSON.stringify({ stopped: true, message: 'Clawd Cursor stopped' });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body, () => {
      console.log(`\n${e('👋', '--')} Shutting down (stop command received)...`);
      try { Promise.resolve(options.onStop()).catch(() => {}); } catch { /* ok */ }
      setTimeout(() => process.exit(0), 500);
    });
    setTimeout(() => process.exit(1), 3000);
  });

  return app;
}
