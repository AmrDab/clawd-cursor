/**
 * Local guide cache for the remote registry.
 *
 * Layout on disk (inside CLAWD_HOME, default ~/):
 *   .clawdcursor/guide-cache/
 *     {app}.json                         — the cached guide payload
 *     {app}.meta.json                    — fetchedAt, etag, usageCount
 *     _index.json                        — LRU access order
 *
 * Behaviour:
 *   - Read: `getCached(app)` returns the guide if present AND fresh (<= TTL).
 *     Stale or missing returns null; caller fetches remotely.
 *   - Write: `setCached(app, guide, etag?)` writes payload + meta + touches
 *     LRU index. If the cache exceeds LRU_CAPACITY entries, the oldest
 *     access wins eviction.
 *   - Touch: `touchUsage(app)` bumps usageCount + reorders LRU on a cache HIT
 *     (used by the remote loader before returning). The "store guides based
 *     on usage" rule the marketplace design promised: frequently-used guides
 *     keep their slot, rarely-used ones drop out.
 *
 * Cache is best-effort — read failures return null, write failures are
 * logged but never propagate. The loader treats cache as a perf layer, not
 * a source of truth.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { AppGuide } from './types';

const TTL_MS         = 7 * 24 * 60 * 60 * 1000; // 7 days
const LRU_CAPACITY   = 50;                       // entries
const MAX_PAYLOAD_KB = 256;                      // sanity cap per file

interface GuideMeta {
  /** Wall-clock when the payload was fetched. */
  fetchedAt: number;
  /** HTTP ETag from the registry response, for conditional requests. */
  etag?: string;
  /** Monotonically increasing per cache-hit, used to surface "popular" guides. */
  usageCount: number;
  /** Origin: where this came from. Cleared if the local cache is invalidated. */
  source: 'remote' | 'bundled-promoted';
}

interface LruIndex {
  /** LRU eviction order — oldest first, newest last. */
  order: string[];
}

function cacheDir(): string {
  const home = process.env.CLAWD_HOME || os.homedir();
  return path.join(home, '.clawdcursor', 'guide-cache');
}

function ensureCacheDir(): void {
  const dir = cacheDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function guidePath(app: string): string { return path.join(cacheDir(), `${app}.json`); }
function metaPath(app: string): string  { return path.join(cacheDir(), `${app}.meta.json`); }
function indexPath(): string            { return path.join(cacheDir(), '_index.json'); }

function readJsonSafe<T>(file: string): T | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch { return null; }
}

function writeJsonSafe(file: string, value: unknown): boolean {
  try {
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
    return true;
  } catch { return false; }
}

function readIndex(): LruIndex {
  return readJsonSafe<LruIndex>(indexPath()) ?? { order: [] };
}

function writeIndex(idx: LruIndex): void { writeJsonSafe(indexPath(), idx); }

function evictIfFull(idx: LruIndex): void {
  while (idx.order.length > LRU_CAPACITY) {
    const oldest = idx.order.shift();
    if (!oldest) break;
    try { fs.unlinkSync(guidePath(oldest)); } catch { /* ok */ }
    try { fs.unlinkSync(metaPath(oldest));  } catch { /* ok */ }
  }
}

function touchInIndex(idx: LruIndex, app: string): void {
  const at = idx.order.indexOf(app);
  if (at >= 0) idx.order.splice(at, 1);
  idx.order.push(app);
}

// ── Public API ─────────────────────────────────────────────────────────────

export interface CachedEntry {
  guide: AppGuide;
  meta: GuideMeta;
  /** True when the meta is older than TTL_MS — caller should refresh. */
  stale: boolean;
}

/**
 * Read a cached guide if present. Returns null when missing or unreadable.
 * Staleness is reported in the result so the caller can decide whether to
 * use the stale copy (offline) or trigger a refresh (online + ok latency).
 */
export function getCached(app: string): CachedEntry | null {
  const guide = readJsonSafe<AppGuide>(guidePath(app));
  const meta  = readJsonSafe<GuideMeta>(metaPath(app));
  if (!guide || !meta) return null;
  const stale = Date.now() - meta.fetchedAt > TTL_MS;
  return { guide, meta, stale };
}

/** Write a guide to the cache and update the LRU index. */
export function setCached(
  app: string,
  guide: AppGuide,
  opts: { etag?: string; source?: GuideMeta['source'] } = {},
): void {
  ensureCacheDir();
  const payload = JSON.stringify(guide);
  if (payload.length > MAX_PAYLOAD_KB * 1024) {
    // Refuse to write oversize guides — the linter should have caught this,
    // but defense-in-depth.
    return;
  }
  const meta: GuideMeta = {
    fetchedAt: Date.now(),
    etag: opts.etag,
    usageCount: (readJsonSafe<GuideMeta>(metaPath(app))?.usageCount ?? 0),
    source: opts.source ?? 'remote',
  };
  fs.writeFileSync(guidePath(app), payload);
  writeJsonSafe(metaPath(app), meta);

  const idx = readIndex();
  touchInIndex(idx, app);
  evictIfFull(idx);
  writeIndex(idx);
}

/**
 * Bump the usage counter for a cache hit. Reorders LRU so popular guides
 * survive eviction even when they're not the most-recently-fetched.
 */
export function touchUsage(app: string): void {
  const meta = readJsonSafe<GuideMeta>(metaPath(app));
  if (!meta) return;
  meta.usageCount += 1;
  writeJsonSafe(metaPath(app), meta);
  const idx = readIndex();
  touchInIndex(idx, app);
  writeIndex(idx);
}

/** List every app currently in the cache, ordered most-recently-used first. */
export function listCached(): Array<{ app: string; meta: GuideMeta }> {
  const idx = readIndex();
  const out: Array<{ app: string; meta: GuideMeta }> = [];
  for (const app of [...idx.order].reverse()) {
    const meta = readJsonSafe<GuideMeta>(metaPath(app));
    if (meta) out.push({ app, meta });
  }
  return out;
}

/** Force-delete a single cached guide. */
export function evict(app: string): void {
  try { fs.unlinkSync(guidePath(app)); } catch { /* ok */ }
  try { fs.unlinkSync(metaPath(app));  } catch { /* ok */ }
  const idx = readIndex();
  idx.order = idx.order.filter(a => a !== app);
  writeIndex(idx);
}

/** Wipe the whole cache. Used by `clawdcursor guides clean`. */
export function clearCache(): void {
  try {
    if (fs.existsSync(cacheDir())) {
      fs.rmSync(cacheDir(), { recursive: true, force: true });
    }
  } catch { /* ok */ }
}

/** Test hook — surface internal constants so suites can assert behaviour. */
export const CACHE_INTERNALS = {
  TTL_MS,
  LRU_CAPACITY,
  MAX_PAYLOAD_KB,
  cacheDir,
};
