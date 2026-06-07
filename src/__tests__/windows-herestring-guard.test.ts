/**
 * #153 regression guard — PowerShell here-strings are illegal in single-line
 * `-Command` strings.
 *
 * setWindowState/setWindowBounds build their PowerShell as one concatenated line
 * and run it via `powershell.exe -Command <string>`. A here-string header (`@"`)
 * MUST be the last token on its line — in a single-line command there is no
 * newline, so PowerShell raises "No characters are allowed after a here-string
 * header before the end of the line" and the ENTIRE script fails to parse. The
 * call then silently produced no output and returned false: minimize (and resize)
 * appeared to "not work" on every window, UWP or not (#153).
 *
 * The fix is a single-quoted `-MemberDefinition '...'` (C# double-quotes are
 * literal inside it). This guard fails if a single-line here-string creeps back.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const windowsSrc = readFileSync(join(here, '..', 'platform', 'windows.ts'), 'utf8');

describe('#153 — no single-line PowerShell here-strings in -Command builders', () => {
  it('windows.ts contains no `@"` here-string header inside a concatenated PS string', () => {
    // A here-string header appears in our source as the literal sequence `@"`
    // inside a JS string. Comments mentioning it (the explanatory NB) are fine,
    // so we only flag occurrences that look like an emitted PS token: `@"` either
    // immediately preceding a string-concat boundary (`@"' +`) or with C# content
    // glued after it on the same JS line.
    const offenders = windowsSrc
      .split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => /-MemberDefinition\s+@"/.test(line) || /@"'\s*\+/.test(line));
    expect(offenders.map(o => `L${o.n}: ${o.line.trim()}`)).toEqual([]);
  });

  it('Add-Type -MemberDefinition uses a single-quoted C# block', () => {
    // Every EMITTED -MemberDefinition should open with a single quote. Skip
    // comment lines (they explain the bug and mention `-MemberDefinition`).
    const emitted = windowsSrc
      .split('\n')
      .filter(line => !line.trim().startsWith('//'))
      .filter(line => line.includes('-MemberDefinition'));
    expect(emitted.length).toBeGreaterThan(0);
    for (const line of emitted) {
      const m = line.match(/-MemberDefinition\s+(\S)/);
      expect({ line: line.trim(), opensWith: m?.[1] }).toMatchObject({ opensWith: "'" });
    }
  });
});
