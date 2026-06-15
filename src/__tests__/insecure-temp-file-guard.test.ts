/**
 * Source-invariant guard (2026-06-14). Production code must not create temp
 * files at a PREDICTABLE path in the world-writable OS temp dir — a fixed name,
 * or one keyed only on Date.now()/process.pid, is a symlink/race window
 * (CWE-377, CodeQL js/insecure-temporary-file). Two real instances were fixed:
 * the `agent console` terminal scripts (which are EXECUTED) and the macOS
 * screenshot capture. The safe substrate is fs.mkdtemp() (private 0700 dir,
 * unguessable suffix) or an unpredictable filename (crypto.randomUUID()).
 *
 * Scope: src/ excluding __tests__ (tests are lower-stakes; a couple of
 * historical test cases are triaged/dismissed separately). The platform
 * adapters and the PS bridge are impractical to exercise in vitest, so this
 * locks the invariant at the source level — same approach as the P0 guards.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === '__tests__') continue; // production code only
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('insecure temp-file guard', () => {
  it('no production .ts builds a tmpdir() path from a predictable token', () => {
    // A line that references the OS temp dir AND interpolates a predictable
    // token (Date.now()/process.pid) into the same expression…
    const predictable = /tmpdir\(\)[^\n]*\$\{\s*(?:Date\.now\(\)|process\.pid)\s*\}/;
    // …UNLESS that same line also mixes in an unpredictable source. mkdtemp()
    // (private 0700 dir), randomUUID(), and randomBytes() are the sanctioned
    // escape hatches — a pid/timestamp used only as a human-readable prefix
    // alongside real randomness is fine (e.g. clawdcursor-ocr-<pid>-<uuid>.png).
    const sanctioned = /mkdtemp|randomUUID|randomBytes/;
    const offenders: string[] = [];

    for (const file of walk(SRC)) {
      const lines = readFileSync(file, 'utf-8').split('\n');
      lines.forEach((line, i) => {
        if (predictable.test(line) && !sanctioned.test(line)) {
          offenders.push(`${file.slice(SRC.length + 1)}:${i + 1}`);
        }
      });
    }

    expect(
      offenders,
      `Predictable temp-file path(s) in the OS temp dir. Use fs.mkdtemp() or a crypto.randomUUID() filename instead:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
