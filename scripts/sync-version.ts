/**
 * Propagate package.json version to every other place it appears.
 *
 * Why: SKILL.md frontmatter, the marketing site (docs/index.html), and the
 * install scripts (docs/install.{sh,ps1}) all carry the version as a
 * literal. Hand-syncing them on every release is exactly the kind of
 * task that gets forgotten — leading to a site that advertises the wrong
 * version or an MCP host registry that lies about which version is in
 * the npm package.
 *
 * Wired into npm's `version` lifecycle hook (see package.json scripts).
 * `npm version <bump>` flow:
 *   1. npm bumps package.json
 *   2. THIS script runs — propagates the new version to all other files
 *   3. npm stages the version-bump commit (we git-add the propagated files)
 *   4. npm creates the tag
 *
 * Can also be invoked directly as `tsx scripts/sync-version.ts` to verify
 * everything is in sync without bumping (exits 0 if no changes needed).
 *
 * Adding new sites: append a SyncTarget below. Each target uses an
 * intent-anchored regex (e.g. matched against the surrounding HTML
 * attribute or YAML key) rather than a global "find any v0.x.y" — this
 * avoids accidentally rewriting historical version markers in the
 * CHANGELOG / "What's new" sections.
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..');
const PKG = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));
const VERSION: string = PKG.version;

if (!/^\d+\.\d+\.\d+/.test(VERSION)) {
  console.error(`✗ package.json version "${VERSION}" is not a valid semver`);
  process.exit(1);
}

interface SyncTarget {
  file: string;
  pattern: RegExp;
  replacement: string;
  /** Human-readable description of what this target represents. */
  desc: string;
  /** When true, a non-matching pattern is NOT an error (illustrative examples
   *  that may be absent depending on the marketing-site layout). */
  optional?: boolean;
}

const TARGETS: SyncTarget[] = [
  // SKILL.md frontmatter — the version field MCP hosts read for skill metadata.
  {
    file: 'SKILL.md',
    pattern: /^(version:\s*)\d+\.\d+\.\d+([^\d.]|$)/m,
    replacement: `$1${VERSION}$2`,
    desc: 'SKILL frontmatter `version:` field',
  },

  // docs/index.html — marketing site. Six places, all distinct contexts.
  {
    file: 'docs/index.html',
    pattern: /(<title>Clawd Cursor v)\d+\.\d+\.\d+/,
    replacement: `$1${VERSION}`,
    desc: 'index.html <title>',
  },
  {
    file: 'docs/index.html',
    pattern: /(<meta name="description"[^>]*?Clawd Cursor v)\d+\.\d+\.\d+/,
    replacement: `$1${VERSION}`,
    desc: 'index.html meta description',
  },
  {
    file: 'docs/index.html',
    pattern: /(property="og:title"\s*content="Clawd Cursor v)\d+\.\d+\.\d+/,
    replacement: `$1${VERSION}`,
    desc: 'index.html og:title',
  },
  {
    file: 'docs/index.html',
    pattern: /(<div class="hero-badge"><div class="pulse"><\/div>\s*v)\d+\.\d+\.\d+/,
    replacement: `$1${VERSION}`,
    desc: 'index.html hero badge',
  },
  {
    file: 'docs/index.html',
    pattern: /(clawd<strong>cursor<\/strong> v)\d+\.\d+\.\d+/,
    replacement: `$1${VERSION}`,
    desc: 'index.html footer brand',
  },
  // The installer-pin examples — PowerShell + bash. These are illustrative and
  // the marketing site may render only one (or neither) depending on layout, so
  // the PowerShell example is OPTIONAL: update it if present, don't error if not.
  {
    file: 'docs/index.html',
    pattern: /(\$env:VERSION='v)\d+\.\d+\.\d+(')/g,
    replacement: `$1${VERSION}$2`,
    desc: 'index.html PowerShell install-pin example',
    optional: true,
  },
  {
    file: 'docs/index.html',
    pattern: /(\bVERSION=v)\d+\.\d+\.\d+(\b)/g,
    replacement: `$1${VERSION}$2`,
    desc: 'index.html bash install-pin example',
  },

  // Installer scripts — header comments that document the example pin.
  // The runtime VERSION="${VERSION:-main}" default below is intentionally
  // dynamic (defaults to main branch) and is NOT touched.
  {
    file: 'docs/install.sh',
    pattern: /(# Specify version: VERSION=v)\d+\.\d+\.\d+/,
    replacement: `$1${VERSION}`,
    desc: 'install.sh header pin example',
  },
  {
    file: 'docs/install.ps1',
    pattern: /(# Specify version: \$env:VERSION='v)\d+\.\d+\.\d+(')/,
    replacement: `$1${VERSION}$2`,
    desc: 'install.ps1 header pin example',
  },
];

let changed = 0;
const touchedFiles = new Set<string>();
const errors: string[] = [];

for (const t of TARGETS) {
  const fp = path.join(REPO_ROOT, t.file);
  if (!fs.existsSync(fp)) {
    errors.push(`✗ missing file: ${t.file} (target: ${t.desc})`);
    continue;
  }
  const before = fs.readFileSync(fp, 'utf-8');
  const after = before.replace(t.pattern, t.replacement);
  if (before === after) {
    // Either already at the right version, or the pattern didn't match — both
    // are non-fatal but the second case is interesting. We can't distinguish
    // cleanly without re-scanning, so just print a quiet status line.
    if (!t.pattern.test(after) && !t.optional) {
      errors.push(`✗ ${t.desc} pattern did not match in ${t.file}`);
    }
    continue;
  }
  fs.writeFileSync(fp, after);
  changed++;
  touchedFiles.add(t.file);
  console.log(`  ✓ ${t.desc}  →  ${t.file}`);
}

if (errors.length > 0) {
  console.error('\nErrors:');
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}

if (changed === 0) {
  console.log(`All version literals already match v${VERSION}.`);
  process.exit(0);
}

console.log(`\nUpdated ${changed} site(s) in ${touchedFiles.size} file(s) to v${VERSION}.`);
console.log('Files: ' + Array.from(touchedFiles).join(', '));
