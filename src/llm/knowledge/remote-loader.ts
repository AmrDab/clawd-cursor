/**
 * Remote guide loader — fetches app guides from the clawdcursor-guides
 * GitHub repo, caches locally, falls back to bundled guides on failure.
 *
 * Wire model (matches the marketplace design in docs/guide-marketplace.md):
 *
 *   ┌────────────────────────────┐
 *   │ Agent needs guide('youtube') │
 *   └────────────┬───────────────┘
 *                ▼
 *   ┌────────────────────────────┐    HIT (fresh)
 *   │ local cache (TTL 7d, LRU 50)├────────────────► return cached + touchUsage
 *   └────────────┬───────────────┘
 *                │  MISS or STALE
 *                ▼
 *   ┌────────────────────────────┐    200 OK
 *   │ GET registry/{app}.json     ├───► lintGuide ──► cache.set ──► return
 *   └────────────┬───────────────┘     │   FAIL
 *                │  network error      │   ▼
 *                │  or 404             │   reject (poisoned) + log
 *                ▼                     │
 *   ┌────────────────────────────┐
 *   │ bundled fallback (src/...) ├──► return bundled if present, else null
 *   └────────────────────────────┘
 *
 *   ┌────────────────────────────┐
 *   │ STALE + offline: return cached, mark stale (no-op refresh)
 *   └────────────────────────────┘
 *
 * Environment knobs (read at every call so tests can mutate them):
 *   CLAWD_GUIDES_REGISTRY_URL  — base URL for fetches.
 *                                 default: https://clawdcursor.com/app-guides
 *                                 (mirrors github.com/AmrDab/clawdcursor-guides
 *                                 via the docs/app-guides/ sync workflow on
 *                                 GitHub Pages — see docs/guide-marketplace.md)
 *   CLAWD_GUIDES_REGISTRY_OFF  — set to "1" / "true" to disable remote
 *                                 fetches entirely (bundled-only mode).
 *   CLAWD_GUIDES_FETCH_TIMEOUT — fetch timeout in ms. default 4000.
 *
 * Security: every fetched guide is run through `lintGuide` before being
 * cached or injected. A guide that fails linting is discarded with a log
 * line and the caller falls back to bundled / null.
 */

import { lintGuide } from './guide-linter';
import { getCached, setCached, touchUsage } from './cache';
import type { AppGuide } from '../../core/pipeline-types';

export const DEFAULT_REGISTRY_URL = 'https://clawdcursor.com/app-guides';
const DEFAULT_TIMEOUT_MS = 4000;
// URL layout: `${registryUrl()}/{app}.json` and `${registryUrl()}/index.json`.
// The flat (no `/guides/` prefix) layout lets the user host this through any
// CDN / Pages / proxy without rewriting paths. The clawdcursor-guides GitHub
// repo serves files from its root for the same reason.

function registryUrl(): string {
  return (process.env.CLAWD_GUIDES_REGISTRY_URL || DEFAULT_REGISTRY_URL).replace(/\/+$/, '');
}

function registryEnabled(): boolean {
  const off = process.env.CLAWD_GUIDES_REGISTRY_OFF;
  return !(off === '1' || off === 'true');
}

function fetchTimeoutMs(): number {
  const v = parseInt(process.env.CLAWD_GUIDES_FETCH_TIMEOUT ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TIMEOUT_MS;
}

/**
 * Minimal logger — uses console.warn so it surfaces in stderr but doesn't
 * require pulling the heavier `logger` module into a file the test suite
 * exercises without the rest of the pipeline. Tests can stub console.warn.
 */
function warn(event: string, data: Record<string, unknown>): void {
  console.warn(`[guide-registry] ${event}`, data);
}

// ── HTTP fetch ────────────────────────────────────────────────────────────

interface FetchResult {
  ok: boolean;
  status: number;
  body?: string;
  etag?: string;
}

/**
 * Single conditional GET. Uses Node 18+ global fetch (which clawdcursor's
 * .nvmrc pins). The optional `If-None-Match` header lets a cache hit avoid
 * payload transfer on the server side when the etag matches.
 */
async function httpGet(url: string, etag?: string): Promise<FetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), fetchTimeoutMs());
  try {
    const headers: Record<string, string> = { 'accept': 'application/json' };
    if (etag) headers['if-none-match'] = etag;
    const res = await fetch(url, { signal: controller.signal, headers });
    if (res.status === 304) return { ok: false, status: 304 };
    if (!res.ok) return { ok: false, status: res.status };
    const body = await res.text();
    return { ok: true, status: res.status, body, etag: res.headers.get('etag') ?? undefined };
  } catch (err) {
    warn('fetch.error', { url, error: (err as Error).message });
    return { ok: false, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

// ── Public API ────────────────────────────────────────────────────────────

export interface FetchOptions {
  /** Skip the cache and force a network request. */
  force?: boolean;
}

/**
 * Fetch a guide by app key. Returns null when the remote registry doesn't
 * have one AND no cached copy exists. Caller (loader.ts) falls through to
 * the bundled guide on null.
 *
 * Cache strategy:
 *   - fresh hit → return immediately (no network), touch usage.
 *   - stale hit + online → background refresh deferred to NEXT load. Return
 *     the stale copy now so the current task isn't blocked on network.
 *   - miss + online  → fetch synchronously, cache, return.
 *   - miss + offline → return null.
 *
 * The "stale-while-revalidate" pattern keeps the agent loop snappy and the
 * cache hot. Refresh-on-next-load means a long-running session re-fetches
 * naturally without scheduling background work.
 */
export async function fetchGuide(app: string, opts: FetchOptions = {}): Promise<AppGuide | null> {
  if (!app) return null;

  // Cache fast-path
  if (!opts.force) {
    const cached = getCached(app);
    if (cached && !cached.stale) {
      touchUsage(app);
      return cached.guide;
    }
    // Stale: serve stale, queue revalidation for next call (no async job here).
    if (cached && cached.stale && !registryEnabled()) {
      return cached.guide; // offline — keep using stale
    }
  }

  if (!registryEnabled()) {
    // No remote allowed. Return whatever cached we have (even stale), or null.
    const cached = getCached(app);
    return cached?.guide ?? null;
  }

  const cached = getCached(app);
  const url = `${registryUrl()}/${encodeURIComponent(app)}.json`;
  const res = await httpGet(url, cached?.meta.etag);

  if (res.status === 304 && cached) {
    // Server confirmed our cached copy is current — refresh fetchedAt.
    setCached(app, cached.guide, { etag: cached.meta.etag, source: 'remote' });
    touchUsage(app);
    return cached.guide;
  }
  if (!res.ok || !res.body) {
    // Network / 404. Use cached even if stale — better than nothing.
    if (cached) {
      warn('fetch.fallback.stale', { app, status: res.status });
      return cached.guide;
    }
    return null;
  }

  // Parse + lint before persisting.
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    warn('fetch.parse_error', { app, bytes: res.body.length });
    return cached?.guide ?? null;
  }
  const lint = lintGuide(parsed);
  if (!lint.ok) {
    warn('fetch.lint_failed', {
      app,
      errors: lint.findings.filter(f => f.severity === 'error').map(f => `${f.rule}@${f.location}`),
    });
    // Refuse to inject a poisoned guide. Fall back to cached / null.
    return cached?.guide ?? null;
  }
  const guide = parsed as AppGuide;
  setCached(app, guide, { etag: res.etag, source: 'remote' });
  return guide;
}

/**
 * Fetch the registry's index manifest. Used by `clawdcursor guides list`
 * to show available + rated guides. Cached briefly (1h TTL) so listing is
 * snappy without hammering the server.
 *
 * Shape (defined in docs/guide-marketplace.md):
 *   {
 *     "schemaVersion": 1,
 *     "generatedAt": "2025-...",
 *     "guides": {
 *       "youtube": { "version": "1.2.0", "trust": "verified",
 *                    "upvotes": 42, "downvotes": 1, "submitter": "@user",
 *                    "etag": "..." },
 *       ...
 *     }
 *   }
 */
export interface RegistryIndex {
  schemaVersion: number;
  generatedAt?: string;
  guides: Record<string, RegistryGuideMeta>;
}

export interface RegistryGuideMeta {
  version?: string;
  trust?: 'verified' | 'community' | 'experimental';
  upvotes?: number;
  downvotes?: number;
  submitter?: string;
  etag?: string;
}

export async function fetchIndex(): Promise<RegistryIndex | null> {
  if (!registryEnabled()) return null;
  const url = `${registryUrl()}/index.json`;
  const res = await httpGet(url);
  if (!res.ok || !res.body) return null;
  try {
    const parsed = JSON.parse(res.body) as RegistryIndex;
    if (typeof parsed !== 'object' || !parsed || !parsed.guides) return null;
    return parsed;
  } catch { return null; }
}
