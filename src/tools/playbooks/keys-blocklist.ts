/**
 * Destructive-key blocklist.
 *
 * v0.8.0 shipped a 3-entry list (alt+f4, ctrl+alt+delete, ctrl+alt+del).
 * The audit flagged this as cosmetic. v0.8.1 expands to the full known
 * destructive set with whitespace-normalized matching so "alt +f4" also
 * blocks.
 *
 * Used by the SafetyLayer. Adding a combo here blocks it across EVERY
 * path (text-agent, vision-agent, MCP direct, REST /action, playbooks).
 */

/**
 * Platform-aware substitution for the `mod` modifier — resolves to `cmd` on
 * macOS and `ctrl` on Windows/Linux. Mirrors the `mod` alias in `src/keys.ts`
 * so `mod+q` on macOS is treated the same as `cmd+q` for blocklist matching.
 */
const PLATFORM_MOD_LOWER = process.platform === 'darwin' ? 'cmd' : 'ctrl';

/** Normalize a user-supplied combo for comparison — lowercase, trim, collapse whitespace, resolve `mod`. */
export function normalizeCombo(combo: string): string {
  const flat = combo.toLowerCase().replace(/\s+/g, '').replace(/[+_-]+/g, '+');
  // Resolve the platform-aware `mod` token in any position so `mod+q` matches
  // `cmd+q` on macOS and `ctrl+q` (etc.) on Win/Linux.
  if (!flat.includes('mod')) return flat;
  return flat.split('+').map(p => p === 'mod' ? PLATFORM_MOD_LOWER : p).join('+');
}

// Two tiers (v1.6.0): the old single list HARD-blocked everything with NO
// confirm path — even though `blockReason` promised "consent via Confirm-tier".
// That dead-ended legitimate agent actions: win+d (show desktop), ctrl+w
// (close a tab), win+r. Split by reversibility/intent:
//   HARD   — locks the machine, force-quits, or fires a secure-attention /
//            shutdown sequence. Never an agent action; no confirm path.
//   CONFIRM — consequential but legitimate (close window/tab, show desktop,
//            open a launcher). Routes through the normal confirm/allowConfirm
//            gate so an authorized caller can proceed.

/** Hard-blocked: no confirm path. */
const HARD_BLOCK: string[] = [
  'ctrl+alt+delete', 'ctrl+alt+del',  // secure attention sequence
  'win+l', 'cmd+ctrl+q',              // lock the machine
  'cmd+shift+q',                      // macOS log out
  'cmd+opt+esc',                      // macOS force-quit picker
  'ctrl+shift+esc',                   // task manager / force-quit escalation
  'fn+alt+f4',                        // shutdown combo some laptops map to
];

/** Confirm-tier: consequential but a legitimate agent action with approval. */
const CONFIRM_BLOCK: string[] = [
  'alt+f4', 'cmd+q',                  // close all windows / quit app (may lose unsaved work)
  'ctrl+w', 'cmd+w',                  // close tab/window
  'win+r', 'cmd+space',               // Run dialog / Spotlight launcher
  'win+d', 'cmd+f3',                  // show desktop / minimize everything
  'f11',                              // full-screen — often interferes with UIA
];

const HARD_BLOCK_SET: ReadonlySet<string> = new Set(HARD_BLOCK.map(normalizeCombo));
const CONFIRM_BLOCK_SET: ReadonlySet<string> = new Set(CONFIRM_BLOCK.map(normalizeCombo));

export type KeyBlockTier = 'block' | 'confirm' | null;

/** Classify a combo: 'block' (hard, no path), 'confirm' (allowConfirm-able), or null (free). */
export function keyBlockTier(combo: string): KeyBlockTier {
  const n = normalizeCombo(combo);
  if (HARD_BLOCK_SET.has(n)) return 'block';
  if (CONFIRM_BLOCK_SET.has(n)) return 'confirm';
  return null;
}

/** Truthful reason for the given tier. */
export function keyBlockReason(combo: string, tier: 'block' | 'confirm'): string {
  return tier === 'block'
    ? `Key combo "${combo}" is hard-blocked — it locks the machine, force-quits, or fires a system/shutdown sequence an agent must never send.`
    : `Key combo "${combo}" needs confirmation — it closes windows/tabs, shows the desktop, or opens a run/search launcher. If the user authorized it, re-issue inside batch({allowConfirm:true}).`;
}

// ── Back-compat: the old names now mean HARD blocks only ──
/** The read-only normalized HARD-block set. */
export const BLOCKED_KEYS: ReadonlySet<string> = HARD_BLOCK_SET;
/** True only for HARD-blocked combos (no confirm path). */
export function isBlockedKey(combo: string): boolean {
  return HARD_BLOCK_SET.has(normalizeCombo(combo));
}
/** Reason string for a HARD block. */
export function blockReason(combo: string): string {
  return keyBlockReason(combo, 'block');
}
