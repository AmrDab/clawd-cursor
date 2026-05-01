import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

// Single-source-of-truth guard. The McpServer constructor and onboarding
// consent file each had their own hardcoded version string for multiple
// releases (the v0.8.6 release shipped specifically to flush the drift).
// This test fails the build if any .ts under src/ pins package.json's
// current version as a literal — the helper at src/version.ts is the
// only allowed home for that string.

const ROOT = join(__dirname, '..');
const SRC = join(ROOT, 'src');
const ALLOW = new Set([join(SRC, 'version.ts')]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('version drift guard', () => {
  it('no .ts file under src/ hardcodes the package.json version', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')) as { version: string };
    const needle = pkg.version;
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (ALLOW.has(file)) continue;
      const text = readFileSync(file, 'utf-8');
      if (text.includes(`'${needle}'`) || text.includes(`"${needle}"`)) {
        offenders.push(file.slice(ROOT.length + 1));
      }
    }
    expect(offenders, `Hardcoded version "${needle}" found. Import VERSION from './version' instead.`).toEqual([]);
  });
});
