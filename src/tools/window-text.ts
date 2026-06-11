/**
 * Window/title text normalization for substring matching.
 *
 * Real-world window titles contain invisible Unicode that breaks naive
 * substring compares. Microsoft Edge inserts a NO-BREAK SPACE (U+00A0) between
 * "Microsoft" and "Edge", so a guard like `expect:{window:"Microsoft Edge"}`
 * against the live title "... - Microsoft Edge" silently fails even though the
 * window IS Edge (session 2026-06-11). Normalize both sides before comparing:
 * strip zero-width characters, fold every Unicode whitespace run to a single
 * ASCII space, lower-case, trim.
 */

// Zero-width / formatting characters that carry no visible meaning but defeat
// equality: ZWSP/ZWNJ/ZWJ + LTR/RTL marks (U+200B-U+200F), embedding/override
// controls (U+202A-U+202E), word joiner (U+2060), BOM/ZWNBSP (U+FEFF).
// (NBSP U+00A0, narrow-NBSP U+202F and the rest of the Zs category are matched
//  by \s in JS regexes, so the whitespace fold below already handles them.)
const ZERO_WIDTH = new RegExp('[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]', 'g');

/** Normalize a title/window string for robust case-insensitive substring matching. */
export function normalizeWindowText(s: string | undefined | null): string {
  if (!s) return '';
  return s
    .replace(ZERO_WIDTH, '')
    .replace(/\s+/g, ' ')   // folds NBSP/narrow-NBSP/tabs/newlines to one space
    .trim()
    .toLowerCase();
}

/** True when `haystack` contains `needle` after both are window-normalized. */
export function windowTextIncludes(
  haystack: string | undefined | null,
  needle: string | undefined | null,
): boolean {
  const n = normalizeWindowText(needle);
  if (!n) return false;
  return normalizeWindowText(haystack).includes(n);
}
