/**
 * App-knowledge loader.
 *
 * Ported from src/ui-knowledge.ts. Two key changes over the legacy:
 *
 *   1. **Bundled guides ship with the package** (`llm/knowledge/guides/*.json`)
 *      so a fresh install has real app-knowledge from day one. The legacy layer
 *      pointed at `~/.clawdcursor/ui-knowledge/` which shipped empty — making
 *      the whole feature stubbed. We now bundle and overlay.
 *
 *   2. **User override directory** at `${home}/.clawdcursor/ui-knowledge/`
 *      (still controlled by `CLAWD_HOME`). A file there takes precedence over
 *      the bundled version — users or Cloudana can ship updated guides
 *      without a clawdcursor release.
 *
 * The Cloudana DB hook (`TODO` in legacy L91) stays dormant. When it lands,
 * this file grows a remote-fetch pathway *before* the user-override check.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { AppGuide, AppWorkflow } from './types';
import { detectApp } from './domain-map';
import { getCached, touchUsage } from './cache';
import { fetchGuide } from './remote-loader';
import { lintGuide } from './guide-linter';

export { detectApp };

function bundledGuidesDir(): string {
  // Module is at src/llm/knowledge/loader.ts → bundled guides live next to it
  // by default. `CLAWD_BUNDLED_GUIDES_DIR` lets the test suite (and any
  // packager that ships an alternate location) redirect without changing
  // code. Used by knowledge.test.ts to point at `seed-registry/guides/`
  // for tests that still reference now-remote-only apps.
  return process.env.CLAWD_BUNDLED_GUIDES_DIR || path.join(__dirname, 'guides');
}

function userGuidesDir(): string {
  const home = process.env.CLAWD_HOME || os.homedir();
  return path.join(home, '.clawdcursor', 'ui-knowledge');
}

/** Cache keyed on app name. null = previously-attempted miss (don't re-read disk). */
const cache = new Map<string, AppGuide | null>();

/** Apps for which a remote prefetch is already in-flight or completed this session. */
const inFlightPrefetch = new Set<string>();

/**
 * Normalize a guide loaded from disk so the rest of the codebase can rely on
 * `name` being a string. Also re-runs the linter as defense-in-depth even on
 * bundled guides (a corrupt or tampered bundle should fail closed, not inject).
 * Returns null when the guide fails lint.
 */
function adoptGuide(raw: unknown): AppGuide | null {
  const lint = lintGuide(raw);
  if (!lint.ok) {
    // eslint-disable-next-line no-console
    console.warn('[guide-loader] rejected guide failing lint', {
      errors: lint.findings.filter(f => f.severity === 'error').map(f => f.rule),
    });
    return null;
  }
  const guide = raw as AppGuide;
  if (!guide.name) guide.name = guide.app;
  return guide;
}

/**
 * Synchronous guide lookup. Reads, in priority order:
 *   1. process-memory cache (zero IO)
 *   2. user-override dir (`~/.clawdcursor/ui-knowledge/{app}.json`) — the
 *      learn_app write target. Highest user-intent priority.
 *   3. remote-fetch cache (`~/.clawdcursor/guide-cache/{app}.json`) — touched
 *      by `prefetchGuideForApp`. Stale entries still serve (offline tolerance).
 *   4. bundled minimum core (`src/llm/knowledge/guides/{app}.json`) — only
 *      msedge/notepad ship today; the rest of the registry is remote.
 *
 * Returns null when nothing resolves. Pure sync — never blocks the agent
 * loop on the network. For remote-only guides on first encounter, callers
 * should ALSO fire `prefetchGuideForApp(app)` so the NEXT call has data.
 */
export function loadGuide(app: string): AppGuide | null {
  if (cache.has(app)) return cache.get(app) ?? null;

  // 1. User override — direct file read (the learn_app sink).
  const userPath = path.join(userGuidesDir(), `${app}.json`);
  if (fs.existsSync(userPath)) {
    try {
      const guide = adoptGuide(JSON.parse(fs.readFileSync(userPath, 'utf8')));
      cache.set(app, guide);
      if (guide) return guide;
    } catch { /* fall through */ }
  }

  // 2. Remote-fetch cache (populated by prefetchGuideForApp / `guides install`).
  const cached = getCached(app);
  if (cached) {
    const guide = adoptGuide(cached.guide);
    cache.set(app, guide);
    if (guide) {
      touchUsage(app);
      return guide;
    }
  }

  // 3. Bundled minimum core.
  const bundledPath = path.join(bundledGuidesDir(), `${app}.json`);
  if (fs.existsSync(bundledPath)) {
    try {
      const guide = adoptGuide(JSON.parse(fs.readFileSync(bundledPath, 'utf8')));
      cache.set(app, guide);
      if (guide) return guide;
    } catch { /* fall through */ }
  }

  cache.set(app, null);
  return null;
}

/**
 * Fire-and-forget remote prefetch. Idempotent within a session. Used by the
 * preprocessor when it detects an active app: kicks off a remote fetch so the
 * cache is warm for the next task (or the current one, if the agent reaches
 * back to load before the fetch completes — but we don't wait for it).
 *
 * Errors are swallowed; this is a perf-only path.
 */
export function prefetchGuideForApp(app: string): void {
  if (!app || inFlightPrefetch.has(app)) return;
  inFlightPrefetch.add(app);
  // Don't await; the promise lives on the microtask queue.
  fetchGuide(app)
    .then(g => {
      if (g) {
        // Invalidate the in-memory miss-cache so the next sync loadGuide
        // picks up the fresh disk cache.
        cache.delete(app);
      }
    })
    .catch(() => { /* logged inside remote-loader */ });
}

/** Clear the cache — tests call this when they mutate the user override dir. */
export function clearCache(): void {
  cache.clear();
  inFlightPrefetch.clear();
}

// ── Write path (learn_app MCP tool) ─────────────────────────────────────────
//
// Writes NEVER touch the bundled source tree (`src/llm/knowledge/guides/`) —
// those are versioned and would be overwritten on the next git pull / install.
// Instead they land in the user-override dir (`~/.clawdcursor/ui-knowledge/`),
// which `loadGuide()` already prefers over the bundle. If no override file
// exists yet we seed it from the bundled copy so curated data is preserved.
//
// `processName` (whatever the MCP caller passed) is resolved to an app key
// via `detectApp` so writes from a process named "EXCEL" land in `excel.json`
// rather than creating a stray `EXCEL.json`.

/**
 * Resolve a free-form process / window-title string to a canonical app key.
 * Tries `detectApp` first, then a lowercase sanitized fallback. Always returns
 * a non-empty string — callers can rely on it for filename construction.
 */
export function resolveAppKey(processName: string): string {
  const detected = detectApp(processName);
  if (detected) return detected;
  return processName.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40) || 'unknown';
}

/** Read the bundled copy of a guide (no user override), used to seed writes. */
function readBundled(app: string): Record<string, unknown> | null {
  const bundledPath = path.join(bundledGuidesDir(), `${app}.json`);
  if (!fs.existsSync(bundledPath)) return null;
  try { return JSON.parse(fs.readFileSync(bundledPath, 'utf8')) as Record<string, unknown>; }
  catch { return null; }
}

/**
 * Open the user-override JSON for an app, creating the directory and seeding
 * from the bundled copy if needed. Returns the parsed object plus its path.
 */
function openUserOverride(app: string): { path: string; data: Record<string, unknown> } {
  const dir = userGuidesDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${app}.json`);

  if (fs.existsSync(file)) {
    try { return { path: file, data: JSON.parse(fs.readFileSync(file, 'utf8')) }; }
    catch { /* fall through to seed */ }
  }
  // Seed from bundled (preserves shortcuts/workflows/tips so we don't lose curation).
  const seed = readBundled(app) ?? { app, name: app };
  return { path: file, data: seed };
}

/**
 * Persist a successful task as a learned workflow (prose-string form) for the
 * given process / app. Saved under `learnedWorkflows` so it stays distinct
 * from hand-curated `workflows`. Capped FIFO at 20 entries per app.
 *
 * Best-effort — never throws to the caller; learning failures are logged and
 * swallowed so they can't break the agent loop.
 */
export function saveLearnedLesson(
  processName: string,
  taskDescription: string,
  actionLog: Array<{ action: string; description?: string }>,
): void {
  if (!processName || !taskDescription || !Array.isArray(actionLog) || actionLog.length === 0) return;

  const app = resolveAppKey(processName);
  const key = taskDescription
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, '_')
    .substring(0, 40);
  if (!key) return;

  const steps = actionLog
    .filter(a => a.action !== 'done' && a.action !== 'done_rejected' && a.action !== 'blocked' && a.action !== 'parse_error')
    .map(a => {
      const desc = a.description ?? '';
      if (a.action === 'key')        return `Press ${desc.split(': ').pop() ?? desc}`;
      if (a.action === 'click')      return `Click ${desc}`;
      if (a.action === 'type')       return `Type text`;
      if (a.action === 'a11y_click') return `Click "${desc.split('"')[1] ?? 'element'}"`;
      if (a.action === 'drag')       return `Drag ${desc}`;
      if (a.action === 'scroll')     return `Scroll ${desc}`;
      return desc;
    })
    .filter(Boolean)
    .join('. ');
  if (!steps) return;

  try {
    const { path: file, data } = openUserOverride(app);
    const learned = (data.learnedWorkflows ?? {}) as Record<string, string>;
    learned[key] = steps;

    // FIFO cap at 20 entries.
    const keys = Object.keys(learned);
    while (keys.length > 20) {
      const oldest = keys.shift()!;
      delete learned[oldest];
    }
    data.learnedWorkflows = learned;
    if (!data.app) data.app = app;
    if (!data.name) data.name = app;

    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    cache.delete(app); // next loadGuide() will pick this up
  } catch {
    // Learning is best-effort; never propagate.
  }
}

/**
 * Merge shortcut / tip additions into the user-override JSON for an app.
 * Existing entries are preserved; new ones are appended (tips de-duped).
 * Returns the resolved app key, or null if nothing was written.
 */
export function mergeIntoUserGuide(
  processName: string,
  patch: { shortcuts?: Record<string, string>; tips?: string[] },
): string | null {
  if (!processName) return null;
  const { shortcuts, tips } = patch;
  const hasShortcuts = shortcuts && typeof shortcuts === 'object' && Object.keys(shortcuts).length > 0;
  const hasTips      = Array.isArray(tips) && tips.length > 0;
  if (!hasShortcuts && !hasTips) return null;

  const app = resolveAppKey(processName);
  try {
    const { path: file, data } = openUserOverride(app);
    if (hasShortcuts) {
      data.shortcuts = { ...(data.shortcuts as Record<string, string> ?? {}), ...shortcuts };
    }
    if (hasTips) {
      const existing = (data.tips as string[]) ?? [];
      data.tips = Array.from(new Set([...existing, ...tips!]));
    }
    if (!data.app)  data.app  = app;
    if (!data.name) data.name = app;
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    cache.delete(app);
    return app;
  } catch {
    return null;
  }
}

// ── Prompt rendering ────────────────────────────────────────────────────────

/**
 * Hard cap on the prompt fragment in characters (~1500 tokens at 4:1).
 * Generous so a rich guide (30+ shortcuts, 20+ workflows, full layout +
 * tips) survives intact for the agent to reason from. Modern models cache
 * the system prompt so re-injection across turns is cheap.
 *
 * Section order below is chosen so graceful degradation drops TIPS first,
 * then LAYOUT, while preserving the active workflow + shortcuts.
 */
const PROMPT_FRAGMENT_MAX = 6000;
/** Per-workflow prose cap. The ★ active workflow gets the full text; the
 *  rest are truncated so a 20-workflow guide doesn't crowd out LAYOUT/TIPS. */
const INACTIVE_WORKFLOW_PROSE_MAX = 180;

/** Render an `AppWorkflow` (structured steps) as a single prose line. */
function renderWorkflow(workflow: AppWorkflow | string): string {
  if (typeof workflow === 'string') return workflow;
  return workflow.steps.map((s, i) => {
    if (s.type === 'pressKey')    return `${i + 1}. pressKey ${s.key}${s.note ? ` (${s.note})` : ''}`;
    if (s.type === 'typeAtFocus') return `${i + 1}. typeAtFocus — the ${s.field}${s.note ? ` (${s.note})` : ''}`;
    if (s.type === 'click')       return `${i + 1}. click ${s.target}${s.note ? ` (${s.note})` : ''}`;
    if (s.type === 'wait')        return `${i + 1}. wait ${s.ms}ms${s.note ? ` (${s.note})` : ''}`;
    return `${i + 1}. verify ${s.name ?? ''}`;
  }).join(' ');
}

/**
 * Render the whole guide as a compact, rich prompt fragment. Surfaces
 * layout, workflows (prose or structured), shortcuts, tips — capped at
 * PROMPT_FRAGMENT_MAX chars.
 *
 * Philosophy: guides are HINTS, not scripts. The fragment offers the agent
 * raw knowledge (here are the workflows, here are the shortcuts, here's the
 * layout) and trusts it to reason about which apply to the current task.
 * No "follow these EXACT steps" — the agent picks what fits.
 *
 * @param guide       parsed AppGuide
 * @param activeKey   optional workflow key to highlight first (set when a
 *                    matcher determined "this is the most relevant workflow")
 */
export function renderAppKnowledge(guide: AppGuide, activeKey?: string): string {
  const lines: string[] = [];
  const title = (guide.name || guide.app).toUpperCase();
  lines.push(`APP KNOWLEDGE — ${title}`);
  lines.push('(Reference data. Use what fits the task, ignore the rest. Not a script.)');

  // Order matters for graceful degradation. If the fragment overflows the
  // cap, sections at the END are truncated first — so put high-information-
  // density / most-essential sections at the top:
  //   1. SHORTCUTS  (compact, universally useful, ~1 line)
  //   2. WORKFLOWS  (the matched one ★-promoted, the rest as references)
  //   3. LAYOUT     (helpful for navigation when the agent is blind)
  //   4. TIPS       (gotchas, failure modes, supplementary)
  // Keyboard nudge always appended last but is short enough to survive.

  if (guide.shortcuts && Object.keys(guide.shortcuts).length > 0) {
    const pairs = Object.entries(guide.shortcuts).map(([k, v]) => `${k}=${v}`);
    lines.push(`SHORTCUTS: ${pairs.join(', ')}`);
  }

  const allWorkflows = { ...(guide.workflows ?? {}), ...(guide.learnedWorkflows ?? {}) };
  const workflowKeys = Object.keys(allWorkflows);
  if (workflowKeys.length > 0) {
    lines.push('WORKFLOWS:');
    const ordered = activeKey && allWorkflows[activeKey]
      ? [activeKey, ...workflowKeys.filter(k => k !== activeKey)]
      : workflowKeys;
    for (const key of ordered) {
      const wf = allWorkflows[key];
      const isActive = key === activeKey;
      let prose = renderWorkflow(wf);
      // Active workflow keeps its full text; the rest are truncated so a
      // 20-workflow guide doesn't drown out LAYOUT and TIPS.
      if (!isActive && prose.length > INACTIVE_WORKFLOW_PROSE_MAX) {
        prose = prose.slice(0, INACTIVE_WORKFLOW_PROSE_MAX - 1) + '…';
      }
      const star = isActive ? '★ ' : '  ';
      lines.push(`${star}${key}: ${prose}`);
    }
  }

  if (guide.layout && Object.keys(guide.layout).length > 0) {
    lines.push('LAYOUT:');
    for (const [region, desc] of Object.entries(guide.layout)) {
      lines.push(`  ${region}: ${desc}`);
    }
  }

  if (guide.tips && guide.tips.length > 0) {
    lines.push('TIPS:');
    for (const tip of guide.tips) lines.push(`  - ${tip}`);
  }

  lines.push('Prefer keyboard over mouse where a shortcut exists; verify before declaring done.');

  let out = lines.join('\n');
  if (out.length > PROMPT_FRAGMENT_MAX) {
    out = out.slice(0, PROMPT_FRAGMENT_MAX - 24) + '\n  …(truncated, guide cont.)';
  }
  return out;
}

/**
 * Resolve a task description + current URL/title to an injected prompt
 * fragment describing the known workflow, if any.
 *
 * Returns null when no app is detected; non-null when the URL/title matches
 * a known app, regardless of whether a workflow keyword matched. When a
 * keyword DOES match, the matched workflow is promoted to the top of the
 * fragment with a ★ marker — but the rest of the guide travels along so the
 * agent has full context. (Prior versions returned null on no keyword match,
 * which silently suppressed guide injection for any task the legacy email-
 * specific keyword table didn't recognize.)
 *
 * The text-agent consumes this as a trusted prompt addendum.
 */
export function getWorkflowForTask(taskText: string, urlOrTitle: string): {
  guide: AppGuide;
  workflow: AppWorkflow | string | null;
  promptFragment: string;
} | null {
  const app = detectApp(urlOrTitle);
  if (!app) return null;

  const guide = loadGuide(app);
  if (!guide) return null;

  const taskLower = taskText.toLowerCase();

  // Keyword → workflow key mapping. Kept identical to v0.8.0 legacy for the
  // email-heavy entries; extended in v0.9 with general web-service verbs so
  // the matcher actually fires for YouTube / Reddit / etc. The MATCH table
  // is consulted top-down; first key whose keywords hit AND whose entry
  // exists in this guide wins.
  const MATCH: Record<string, string[]> = {
    compose_and_send: ['send email', 'compose', 'write email', 'new email', 'email to'],
    reply:            ['reply', 'respond'],
    reply_all:        ['reply all'],
    forward:          ['forward'],
    archive:          ['archive'],
    delete_:          ['delete email', 'trash'],
    go_to_inbox:      ['go to inbox', 'open inbox', 'inbox'],
    // Generic media / web verbs
    search_and_play:  ['play', 'listen to', 'watch'],
    play_song_by_artist: ['song by', 'song from', 'track by'],
    queue_video:      ['queue', 'add to queue'],
    subscribe:        ['subscribe'],
    like_video:       ['like', 'thumbs up'],
    comment:          ['comment'],
    fullscreen:       ['fullscreen', 'full screen'],
    search:           ['search', 'find', 'look for'],
  };

  const allWorkflows = { ...(guide.workflows ?? {}), ...(guide.learnedWorkflows ?? {}) };
  let activeKey: string | null = null;
  for (const [key, keywords] of Object.entries(MATCH)) {
    if (keywords.some(kw => taskLower.includes(kw)) && allWorkflows[key]) {
      activeKey = key;
      break;
    }
  }

  const promptFragment = renderAppKnowledge(guide, activeKey ?? undefined);
  return {
    guide,
    workflow: activeKey ? (allWorkflows[activeKey] ?? null) : null,
    promptFragment,
  };
}
