/**
 * Rank-before-truncate for a11y snapshots.
 *
 * Problem: Paint's a11y tree had "Pencil" at index 20 (it was NOT truncated),
 * but Explorer / Outlook / Teams can easily spew 200+ a11y nodes where the
 * buttons the agent actually needs sit at indices 80–150. The previous
 * `slice(0, 80)` strategy threw those overboard.
 *
 * This module ranks elements by how likely the agent is to act on them, then
 * the snapshot renderer truncates from the bottom. No app-specific rules —
 * the signals come from accessibility roles and bounding-box geometry,
 * nothing encoded per-app.
 *
 * Signals (additive, all non-app-specific):
 *   + Interactive roles (Button, MenuItem, Hyperlink, Edit, ComboBox, Tab,
 *     CheckBox, RadioButton, ListItem, TreeItem) get a strong boost.
 *   + Named elements (non-empty `name`) beat anonymous ones.
 *   + Focused element gets a big boost.
 *   + Elements marked `interactive: true` get a small boost.
 *   + Smaller elements (typical for buttons / icons) slightly preferred
 *     over full-window panes / group containers.
 *   + Top-edge and right-edge toolbars get a modest boost (Paint palette,
 *     Office ribbon live there).
 *   - Containers (Pane, Group, Document, ScrollBar) get a penalty — they
 *     hold other interactive nodes but aren't themselves clickable.
 *   - Huge elements (> 80% of screen) get a penalty — usually the window
 *     body, not a target.
 *
 * The ranker is a pure function of the snapshot element list. It never
 * consults app name / window title / anything app-specific. A new LOB app
 * with exotic roles will rank cleanly because it obeys the same a11y
 * contract every Windows/macOS/Linux UI toolkit does.
 */

import type { SnapshotElement } from './types';

/**
 * Score weights. Tuned to be monotonic: the sum for a typical interactive
 * button exceeds the sum for a container pane by a healthy margin. Exact
 * numbers matter less than the ordering.
 */
const ROLE_BOOSTS: Record<string, number> = {
  // ─── Clickable/commandable ────────────────────────────────
  'button': 40,
  'menuitem': 38,
  'hyperlink': 38,
  'link': 38,
  'tab': 32,
  'checkbox': 30,
  'radiobutton': 30,
  'splitbutton': 30,
  'togglebutton': 30,
  'listitem': 24,
  'treeitem': 24,
  'menubaritem': 30,
  // ─── Editable ─────────────────────────────────────────────
  'edit': 35,
  'text': 18,           // generic; raised only slightly
  'combobox': 32,
  'spinner': 26,
  'slider': 26,
  'datepicker': 26,
  // ─── Informational but often targeted ─────────────────────
  'image': 6,
  'statictext': 5,
  'statusbar': 8,
  // ─── Containers (penalized, but not eliminated) ───────────
  'pane': -12,
  'group': -8,
  'document': -10,
  'scrollbar': -20,
  'titlebar': -4,
  'menubar': 0,
  'toolbar': 6,         // toolbars themselves aren't clicked, but they
                        // geographically concentrate buttons — keep them
                        // visible so the agent has orientation
  'window': -18,
};

/** Extra boost when the element sits along a toolbar edge (top/right). */
const TOOLBAR_EDGE_BOOST = 6;
/** Boost for an explicitly focused element. */
const FOCUSED_BOOST = 25;
/** Boost for having a readable name. */
const NAMED_BOOST = 10;
/** Boost for interactive flag (set by the platform adapter). */
const INTERACTIVE_FLAG_BOOST = 6;
/** Penalty for being >= 80% of the screen area. */
const HUGE_ELEMENT_PENALTY = -25;
/** Penalty for being 0 bounds (invisible). */
const ZERO_BOUNDS_PENALTY = -80;

export interface RankOpts {
  /** Physical screen width for "huge element" detection. */
  screenWidth?: number;
  /** Physical screen height for "huge element" detection. */
  screenHeight?: number;
  /** Active window processId — elements outside this process get penalized. */
  focusProcessId?: number;
  /** Explicitly-focused element coords, if the adapter reports one. */
  focusPoint?: { x: number; y: number };
}

/**
 * Score one element. Higher = more likely the agent wants to act on it.
 * Pure: no I/O, no app-specific tables.
 */
export function scoreElement(el: SnapshotElement, opts: RankOpts = {}): number {
  let score = 0;

  // Role signal — the single biggest ranker.
  const role = (el.role || '').toLowerCase().replace(/[^a-z]/g, '');
  if (role && role in ROLE_BOOSTS) score += ROLE_BOOSTS[role];
  else if (role) score += 4; // unknown role gets a small positive (don't zero-weight new a11y roles)

  // Named elements beat anonymous.
  const name = (el.name || '').trim();
  if (name) score += NAMED_BOOST;
  // Longer readable names (up to ~30 chars) get a small additional weight.
  if (name.length > 2) score += Math.min(name.length, 20) * 0.15;

  // Interactive flag from adapter.
  if (el.interactive) score += INTERACTIVE_FLAG_BOOST;

  // A11y source beats OCR — a11y tree entries come with stable roles and
  // names; OCR is often noisy text labels.
  if (el.source === 'a11y') score += 4;

  // Geometric sanity:
  const screenW = opts.screenWidth ?? 1920;
  const screenH = opts.screenHeight ?? 1080;
  const screenArea = screenW * screenH;
  const elArea = Math.max(0, el.width) * Math.max(0, el.height);

  if (el.width <= 0 || el.height <= 0) {
    score += ZERO_BOUNDS_PENALTY;
  } else if (screenArea > 0 && elArea / screenArea > 0.8) {
    score += HUGE_ELEMENT_PENALTY;
  } else {
    // Smaller elements (typical of buttons) get a modest positive. Weighted
    // so a 40×40 button scores +6, a 200×200 control scores ~+2, a big pane
    // scores near 0.
    const normalized = 1 - Math.min(1, elArea / (screenArea / 50));
    score += normalized * 6;
  }

  // Toolbar-edge boost — elements near the top (y < 140) or right
  // (x > screenW - 200) are often command buttons (Paint palette, Office
  // ribbon, sidebar buttons). No app-specific code needed.
  if (el.y < 140) score += TOOLBAR_EDGE_BOOST;
  else if (el.x > screenW - 200) score += TOOLBAR_EDGE_BOOST * 0.7;

  // Focused element wins big.
  if (opts.focusPoint) {
    const cx = el.x + el.width / 2;
    const cy = el.y + el.height / 2;
    const dx = cx - opts.focusPoint.x;
    const dy = cy - opts.focusPoint.y;
    const dist = Math.hypot(dx, dy);
    // Within 40px — definitely focused.
    if (dist < 40) score += FOCUSED_BOOST;
    // Within 200 — nearby / probably related.
    else if (dist < 200) score += FOCUSED_BOOST * 0.3;
  }

  // Prefer elements in the focused window's process.
  if (opts.focusProcessId != null && el.processId != null && el.processId !== opts.focusProcessId) {
    score -= 30;
  }

  return score;
}

/**
 * Rank elements from most-likely-to-act-on to least. Stable: equal scores
 * preserve document order (often the left-to-right, top-to-bottom order
 * Windows UIA returns, which tends to match visual scan order).
 *
 * Does NOT truncate — callers decide the cap based on their token budget.
 * The snapshot renderer typically calls rank(), then slices the top N.
 */
export function rankElements(elements: SnapshotElement[], opts: RankOpts = {}): SnapshotElement[] {
  // Attach indices to preserve stable order on ties.
  const scored = elements.map((el, i) => ({ el, i, s: scoreElement(el, opts) }));
  scored.sort((a, b) => {
    if (b.s !== a.s) return b.s - a.s;
    return a.i - b.i;
  });
  return scored.map(x => x.el);
}

/**
 * Debug-friendly: return the top-N with their scores. Used by the
 * observability logger so the user can see WHY "Pencil" ranked 3rd when
 * the tree had 200 elements.
 */
export function rankWithScores(elements: SnapshotElement[], opts: RankOpts = {}): Array<{ el: SnapshotElement; score: number }> {
  return elements
    .map(el => ({ el, score: scoreElement(el, opts) }))
    .sort((a, b) => b.score - a.score);
}
