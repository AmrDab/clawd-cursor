/**
 * Layer B — pure, deterministic semantic finders over a compiled UIMap.
 * Turn an intent/purpose into the best el_NN. No LLM, no platform calls,
 * no process.platform branching. See the Layer B design spec.
 *
 * BOUNDARY: ranks only elements the UIMap marks clickable/editable (a11y-exposed
 * interactive elements, where the Part-2 ref-act chain is valid). OCR text is a
 * label SOURCE only (Task 3), not an independent actionable candidate.
 */
import type { UIElement, Role } from './ui-map-types';
import { normText } from './ui-map-normalize';

export const MATCH_THRESHOLD = 0.4;   // min score×confidence to count as a match
export const AMBIGUITY_MARGIN = 0.03; // top-two closeness that forces 'ambiguous'
export const MAX_CANDIDATES = 5;

export interface FindCandidate { element_id: string; label: string; role: Role; score: number; confidence: number; }
export type FindResult =
  | { status: 'ok'; snapshot_id: string; best: FindCandidate; candidates: FindCandidate[] }
  | { status: 'ambiguous'; snapshot_id: string; reason: string; candidates: FindCandidate[] }
  | { status: 'none'; snapshot_id: string; reason: string; candidates: FindCandidate[] };

/** Curated intent → synonym sets. Unknown intents fall back to literal/token match. */
const ACTION_SYNONYMS: Record<string, string[]> = {
  submit: ['submit', 'send', 'ok', 'confirm', 'save', 'continue', 'next', 'post', 'publish', 'apply', 'done', 'go'],
  cancel: ['cancel', 'close', 'dismiss', 'back', 'no'],
  delete: ['delete', 'remove', 'trash', 'discard'],
  search: ['search', 'find', 'go', 'query'],
  login: ['login', 'log in', 'sign in', 'signin'],
  open: ['open', 'launch', 'view'],
  add: ['add', 'new', 'create', 'plus'],
};

export interface ExpandedTerms {
  /** The normalized intent literal and its tokens — exact match → score 1.0. */
  literals: Set<string>;
  /** Synonyms drawn from the table — synonym match → score 0.9. */
  synonyms: Set<string>;
}

/** Expand an intent into literal + synonym sets. Keeps exact vs synonym distinct
 *  so that scoreLabel can assign different raw scores to each tier. */
export function expandTerms(intent: string, table: Record<string, string[]>): ExpandedTerms {
  const lit = normText(intent);
  const literals = new Set<string>([lit]);
  lit.split(' ').filter(Boolean).forEach(t => literals.add(t));
  literals.delete('');

  const synonyms = new Set<string>();
  for (const [key, syns] of Object.entries(table)) {
    if (key === lit || syns.includes(lit)) {
      syns.forEach(s => {
        if (!literals.has(s)) synonyms.add(s);
      });
    }
  }
  return { literals, synonyms };
}

/** Raw 0..1 match of a label against the term sets (no confidence yet).
 *  Literal exact → 1.0; synonym exact / literal substring → 0.9; token overlap → ≤0.5. */
export function scoreLabel(label: string, { literals, synonyms }: ExpandedTerms, intentTokens: string[]): number {
  const L = normText(label);
  if (!L) return 0;
  // Exact literal match (highest tier)
  if (literals.has(L)) return 1.0;
  const lTokens = L.split(' ').filter(Boolean);
  const lSet = new Set(lTokens);
  // Synonym exact match or literal term as whole word / substring in label
  for (const t of synonyms) {
    if (lSet.has(t)) return 0.9;
    if (t.length > 2 && L.includes(t)) return 0.9;
  }
  for (const t of literals) {
    if (lSet.has(t)) return 0.9;                          // intent token is a whole word in the label
    if (t.length > 2 && L.includes(t)) return 0.9;        // intent token is a substring of the label
  }
  const overlap = intentTokens.filter(t => lSet.has(t)).length;
  return intentTokens.length > 0 ? 0.5 * (overlap / intentTokens.length) : 0;
}

/** Shared finder core. `labelOf` lets fields override with geometric association. */
export function runFinder(
  elements: UIElement[],
  snapshotId: string,
  intent: string,
  table: Record<string, string[]>,
  isCandidate: (e: UIElement) => boolean,
  labelOf: (e: UIElement, all: UIElement[]) => string,
): FindResult {
  const terms = expandTerms(intent, table);
  const intentTokens = normText(intent).split(' ').filter(Boolean);
  const scored: FindCandidate[] = [];
  for (const e of elements) {
    if (!isCandidate(e)) continue;
    const label = labelOf(e, elements);
    const raw = scoreLabel(label, terms, intentTokens);
    if (raw <= 0) continue;
    scored.push({ element_id: e.id, label, role: e.role, score: raw * e.confidence, confidence: e.confidence });
  }
  scored.sort((a, b) => b.score - a.score);
  const candidates = scored.slice(0, MAX_CANDIDATES);
  const best = scored[0];
  if (!best || best.score < MATCH_THRESHOLD) {
    return { status: 'none', snapshot_id: snapshotId, reason: 'no candidate cleared the match threshold', candidates };
  }
  const second = scored[1];
  if (second && best.score - second.score < AMBIGUITY_MARGIN) {
    return { status: 'ambiguous', snapshot_id: snapshotId, reason: `top candidates within ${AMBIGUITY_MARGIN} score margin`, candidates };
  }
  return { status: 'ok', snapshot_id: snapshotId, best, candidates };
}

export function findActionButton(elements: UIElement[], snapshotId: string, intent: string): FindResult {
  return runFinder(elements, snapshotId, intent, ACTION_SYNONYMS,
    e => e.clickable === true,
    e => e.normalized_text ?? '');
}
