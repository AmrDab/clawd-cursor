/**
 * `clawdcursor guides` CLI — manage the remote guide registry locally.
 *
 * The marketplace runs out of the `clawdcursor/clawdcursor-guides` GitHub
 * repo (configurable via `CLAWD_GUIDES_REGISTRY_URL`). The agent fetches
 * guides on demand and caches them locally at
 *   $CLAWD_HOME/.clawdcursor/guide-cache/{app}.json
 * with a 7-day TTL + LRU 50-entry cap. This CLI is the user-facing
 * inspection and maintenance layer.
 *
 * Commands:
 *   clawdcursor guides list                    Show cached + their ratings
 *   clawdcursor guides info <app>              Details for one cached guide
 *   clawdcursor guides available               Browse the full remote registry
 *   clawdcursor guides install <app>           Pre-warm the cache for an app
 *   clawdcursor guides install --all           Pre-warm everything (offline prep)
 *   clawdcursor guides refresh <app>           Force re-fetch one app
 *   clawdcursor guides remove <app>            Evict one cached app
 *   clawdcursor guides clean                   Wipe the whole cache
 *   clawdcursor guides submit <file>           Print PR instructions for a new guide
 *   clawdcursor guides lint <file>             Run the linter against a local JSON
 *   clawdcursor guides help                    This message
 *
 * Zero remote writes: submissions go through GitHub PRs (per the marketplace
 * trust model — see docs/guide-marketplace.md). `submit` just shows the user
 * how to fork the repo and open a PR.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  DEFAULT_REGISTRY_URL, fetchGuide, fetchIndex, type RegistryGuideMeta,
} from './knowledge/remote-loader';
import {
  getCached, listCached, evict, clearCache as clearGuideCache, CACHE_INTERNALS,
} from './knowledge/cache';
import { lintGuide, formatLintReport } from './knowledge/guide-linter';

// Where users go to submit. Read from env so tests / forks can override.
function repoUrl(): string {
  return process.env.CLAWD_GUIDES_REPO_URL
    || 'https://github.com/AmrDab/clawdcursor-guides';
}

// ── Helpers ────────────────────────────────────────────────────────────────

function fmtAge(ms: number): string {
  const sec = Math.floor((Date.now() - ms) / 1000);
  if (sec < 60)        return `${sec}s ago`;
  if (sec < 3600)      return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86_400)    return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86_400)}d ago`;
}

function fmtRating(meta?: RegistryGuideMeta): string {
  if (!meta) return '—';
  const up = meta.upvotes ?? 0, down = meta.downvotes ?? 0;
  if (up + down === 0) return '(no votes)';
  const score = up - down;
  const sign = score > 0 ? '+' : '';
  return `${sign}${score} (${up}👍 ${down}👎)`;
}

function fmtTrust(meta?: RegistryGuideMeta): string {
  if (!meta?.trust) return 'unverified';
  return meta.trust;
}

// ── Commands ───────────────────────────────────────────────────────────────

export async function guidesCommand(args: string[]): Promise<void> {
  const sub = (args[0] || 'help').toLowerCase();

  switch (sub) {
    case 'help':
    case '--help':
    case '-h':
      return printUsage();
    case 'list':      return listCachedGuides();
    case 'info':      return infoGuide(args[1]);
    case 'available': return listAvailable();
    case 'install': {
      const target = args[1];
      if (!target) return console.log('\n   Usage: clawdcursor guides install <app|--all>\n');
      if (target === '--all') return installAll();
      return installOne(target);
    }
    case 'refresh': return refreshGuide(args[1]);
    case 'remove':  return removeOne(args[1]);
    case 'clean':   return cleanAll();
    case 'submit':  return submitInstructions(args[1]);
    case 'lint':    return lintLocal(args[1]);
    default:
      // Treat bare name as install — friendlier for first-time users.
      return installOne(sub);
  }
}

function printUsage(): void {
  console.log(`
  /\\___/\\   ClawdCursor Guides Marketplace
 ( >^.^< )  ${repoUrl()}
  )     (
 (_)_(_)_)

  Inspect cache
    clawdcursor guides list                  Show every cached guide + rating
    clawdcursor guides info <app>            Cache metadata for one app

  Browse the registry
    clawdcursor guides available             List every published guide (network)

  Manage the cache
    clawdcursor guides install <app>         Pre-warm cache for one app
    clawdcursor guides install --all         Pre-warm everything (offline prep)
    clawdcursor guides refresh <app>         Force re-fetch one app
    clawdcursor guides remove <app>          Evict one app from cache
    clawdcursor guides clean                 Wipe the whole cache

  Author / submit
    clawdcursor guides lint <file.json>      Validate a local guide before PR
    clawdcursor guides submit <file.json>    Print PR instructions

  How it works
    Guides live in a public GitHub repo. The agent fetches on demand and
    caches locally for 7 days. Frequently-used guides survive LRU eviction.
    Submissions are GitHub PRs — see ${repoUrl()}/blob/main/CONTRIBUTING.md
`);
}

function listCachedGuides(): void {
  const entries = listCached();
  if (entries.length === 0) {
    console.log('\n   No guides cached yet. They populate as the agent encounters apps.');
    console.log('   To pre-warm: clawdcursor guides install <app>\n');
    return;
  }
  console.log(`\n   Cached guides (${entries.length}/${CACHE_INTERNALS.LRU_CAPACITY}):\n`);
  console.log(`   ${'APP'.padEnd(24)} ${'FETCHED'.padEnd(12)} ${'USES'.padEnd(6)} SOURCE`);
  for (const { app, meta } of entries) {
    console.log(
      `   ${app.padEnd(24)} ${fmtAge(meta.fetchedAt).padEnd(12)} ${String(meta.usageCount).padEnd(6)} ${meta.source}`
    );
  }
  console.log('');
}

function infoGuide(app?: string): void {
  if (!app) return console.log('\n   Usage: clawdcursor guides info <app>\n');
  const entry = getCached(app);
  if (!entry) {
    console.log(`\n   "${app}" is not cached locally. Try:`);
    console.log(`     clawdcursor guides install ${app}\n`);
    return;
  }
  const { guide, meta, stale } = entry;
  console.log(`\n   ${guide.name || guide.app}`);
  console.log(`     app key:   ${guide.app}`);
  console.log(`     fetched:   ${new Date(meta.fetchedAt).toISOString()} (${fmtAge(meta.fetchedAt)})${stale ? ' [STALE]' : ''}`);
  console.log(`     usage:     ${meta.usageCount} times`);
  console.log(`     source:    ${meta.source}`);
  console.log(`     shortcuts: ${Object.keys(guide.shortcuts || {}).length}`);
  console.log(`     workflows: ${Object.keys(guide.workflows || {}).length}`);
  console.log(`     tips:      ${(guide.tips ?? []).length}`);
  console.log('');
}

async function listAvailable(): Promise<void> {
  console.log('\n   Fetching registry index...');
  const idx = await fetchIndex();
  if (!idx) {
    console.log('   Could not reach the registry. Check network or CLAWD_GUIDES_REGISTRY_URL.\n');
    return;
  }
  const apps = Object.entries(idx.guides);
  console.log(`\n   Available guides (${apps.length}) — index generated ${idx.generatedAt ?? '(no timestamp)'}\n`);
  console.log(`   ${'APP'.padEnd(24)} ${'TRUST'.padEnd(12)} ${'RATING'.padEnd(20)} VERSION`);
  for (const [app, meta] of apps.sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(
      `   ${app.padEnd(24)} ${fmtTrust(meta).padEnd(12)} ${fmtRating(meta).padEnd(20)} ${meta.version ?? ''}`
    );
  }
  console.log('');
}

async function installOne(app: string): Promise<void> {
  if (!app) return;
  console.log(`   Fetching ${app}...`);
  const guide = await fetchGuide(app, { force: true });
  if (!guide) {
    console.log(`   ✗ Could not install "${app}". Either it isn't in the registry, the fetch failed, or it failed lint.`);
    console.log(`   Browse: clawdcursor guides available\n`);
    return;
  }
  console.log(`   ✓ ${guide.name || guide.app} cached (${Object.keys(guide.shortcuts || {}).length} shortcuts, ${Object.keys(guide.workflows || {}).length} workflows)\n`);
}

async function installAll(): Promise<void> {
  const idx = await fetchIndex();
  if (!idx) {
    console.log('   Could not reach the registry.\n');
    return;
  }
  const apps = Object.keys(idx.guides);
  console.log(`\n   Pre-warming ${apps.length} guides...\n`);
  let ok = 0, fail = 0;
  for (const app of apps) {
    const guide = await fetchGuide(app, { force: true });
    if (guide) { console.log(`     ✓ ${app}`); ok++; }
    else       { console.log(`     ✗ ${app}`); fail++; }
  }
  console.log(`\n   Done: ${ok} ok, ${fail} failed.\n`);
}

async function refreshGuide(app?: string): Promise<void> {
  if (!app) return console.log('\n   Usage: clawdcursor guides refresh <app>\n');
  return installOne(app); // force re-fetch
}

function removeOne(app?: string): void {
  if (!app) return console.log('\n   Usage: clawdcursor guides remove <app>\n');
  if (!getCached(app)) {
    console.log(`\n   "${app}" was not cached. Nothing to remove.\n`);
    return;
  }
  evict(app);
  console.log(`\n   ✓ Evicted "${app}" from local cache.\n`);
}

function cleanAll(): void {
  clearGuideCache();
  console.log('\n   ✓ Guide cache cleared. Next agent run will re-fetch from the registry.\n');
}

function lintLocal(file?: string): void {
  if (!file) return console.log('\n   Usage: clawdcursor guides lint <path/to/guide.json>\n');
  if (!fs.existsSync(file)) {
    console.log(`\n   File not found: ${file}\n`);
    return;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (err) {
    console.log(`\n   JSON parse error: ${(err as Error).message}\n`);
    return;
  }
  const result = lintGuide(parsed);
  console.log('\n' + formatLintReport(result, path.basename(file)) + '\n');
}

function submitInstructions(file?: string): void {
  if (!file) {
    console.log(`\n   Usage: clawdcursor guides submit <path/to/guide.json>\n`);
    return;
  }
  if (!fs.existsSync(file)) {
    console.log(`\n   File not found: ${file}\n`);
    return;
  }
  // Always lint locally first — surface errors before the user opens a PR.
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (err) {
    console.log(`\n   ✗ JSON parse error: ${(err as Error).message}\n`);
    return;
  }
  const result = lintGuide(parsed);
  console.log('\n' + formatLintReport(result, path.basename(file)));
  if (!result.ok) {
    console.log('\n   Fix the errors above before submitting.\n');
    return;
  }
  const app = (parsed as { app?: string }).app ?? '<app>';
  console.log(`
   To submit "${app}" to the marketplace:

   1. Fork ${repoUrl()}
   2. Add your file as ${app}.json at the repo root
   3. Open a Pull Request — CI re-runs lint + schema checks
   4. Once merged, every clawdcursor install will fetch it on demand
      from ${DEFAULT_REGISTRY_URL}/${app}.json

   Trust levels (set by reviewers via PR label):
     verified     — curated by maintainers, fetched by default
     community    — vetted PR, available with opt-in
     experimental — un-vetted, opt-in only

   See ${repoUrl()}/blob/main/CONTRIBUTING.md for review SLAs and style.
`);
}
