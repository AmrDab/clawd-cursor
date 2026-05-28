/**
 * Task classifier — zero-LLM regex routing.
 *
 * Ported from src/task-classifier.ts (v0.6.3 → v0.8.0). Returns the four
 * canonical categories (mechanical / navigation / reasoning / spatial) plus
 * adaptive timeouts and a boolean that tells the orchestrator whether to
 * skip straight to vision (for genuinely spatial work: drag/draw/paint).
 *
 * v0.8.1 additions over legacy:
 *  - Returns ClassifyResult from pipeline/types.ts — integrates with the
 *    unified pipeline's shared vocabulary.
 *  - Reports matched patterns for telemetry (which rule fired, useful for
 *    tuning the regex corpus over time).
 */

import type { ClassifyResult, TaskCategory } from '../pipeline-types';

// Regex corpus. Kept verbatim from v0.8.0 legacy with minor tightening.
const MECHANICAL_START = /^(open|close|press|click|tap|type|save\s+(the\s+file\s+)?as|minimize|maximize|focus|switch to)\b/i;
const MECHANICAL_FULL  = /^(select all|undo|redo|copy|paste|cut|delete|scroll (up|down)|go back|go forward|refresh)\b/i;

// "click in/on the middle/center/area" → needs structured perception to resolve coords.
const POSITIONAL_CLICK = /\b(click|tap)\s+(in|on|at)\s+(the\s+)?(middle|center|top|bottom|left|right|corner|area|canvas|screen|background|workspace)\b/i;

const NAVIGATION     = /\b(go to|navigate to|visit|open\s+https?:|browse to|search for|find on page)\b/i;
const NAVIGATION_URL = /\b(https?:\/\/|www\.|\.com|\.org|\.io|\.dev|\.net)\b/i;

// `drag\s.*\b(to|onto|into)\b` — must stay in sync with the capability
// classifier's spatial rule (classify/capability.ts). Earlier this only
// matched a standalone "to", so "drag X into/onto Y" fell through to the
// default reasoning bucket → blind rung, even though the capability layer
// already tagged it spatial. A blind text-agent has no screenshot and
// cannot compute drag coordinates, so those tasks wasted a full rung
// before escalating to vision. Cover into/onto so drag gestures go
// straight to vision as the docstring promises.
const SPATIAL   = /\b(draw|sketch|paint|design|arrange|drag\s+.*\b(to|onto|into)\b|resize|move\s+(the\s+)?element|color|shade|fill\s+(with|in)|illustrate|diagram|annotate)\b/i;
const REASONING = /\b(compose|write|draft|fill\s+(out|in)\b|log\s*in|sign\s*in|register|check|compare|review|analyze|read|summarize|reply|respond|forward)\b/i;
const EMAIL     = /\b(email|send\s+(an?\s+)?email|compose\s+mail|send\s+to\s+\S+@)\b/i;

interface Rule {
  pattern: RegExp;
  name: string;
  result: Omit<ClassifyResult, 'matches'>;
}

// Rule table — evaluated in order, first match wins. Order encodes precedence:
// spatial > positional click > mechanical > email (before navigation — email
// addresses contain .com) > navigation > reasoning > default.
const RULES: Rule[] = [
  {
    pattern: SPATIAL,
    name: 'spatial',
    result: {
      kind: 'spatial',
      needsVision: false, // text-agent can drag via structured perception; vision is fallback only
      suggestedLayers: ['sense', 'text-agent', 'vision-agent'],
      timeoutMs: 90_000,
    },
  },
  {
    pattern: POSITIONAL_CLICK,
    name: 'positional_click',
    result: {
      kind: 'reasoning',
      needsVision: false,
      suggestedLayers: ['sense', 'text-agent', 'vision-agent'],
      timeoutMs: 45_000,
    },
  },
  {
    pattern: MECHANICAL_START,
    name: 'mechanical_start',
    result: {
      kind: 'mechanical',
      needsVision: false,
      suggestedLayers: ['router', 'sense', 'text-agent'],
      timeoutMs: 30_000,
    },
  },
  {
    pattern: MECHANICAL_FULL,
    name: 'mechanical_full',
    result: {
      kind: 'mechanical',
      needsVision: false,
      suggestedLayers: ['router', 'sense', 'text-agent'],
      timeoutMs: 30_000,
    },
  },
  {
    pattern: EMAIL,
    name: 'email',
    result: {
      kind: 'reasoning',
      needsVision: false,
      suggestedLayers: ['router', 'playbook', 'sense', 'text-agent'],
      timeoutMs: 90_000,
    },
  },
  {
    pattern: NAVIGATION,
    name: 'navigation',
    result: {
      kind: 'navigation',
      needsVision: false,
      suggestedLayers: ['router', 'sense', 'text-agent'],
      timeoutMs: 45_000,
    },
  },
  {
    pattern: NAVIGATION_URL,
    name: 'navigation_url',
    result: {
      kind: 'navigation',
      needsVision: false,
      suggestedLayers: ['router', 'sense', 'text-agent'],
      timeoutMs: 45_000,
    },
  },
  {
    pattern: REASONING,
    name: 'reasoning',
    result: {
      kind: 'reasoning',
      needsVision: false,
      suggestedLayers: ['sense', 'text-agent', 'vision-agent'],
      timeoutMs: 90_000,
    },
  },
];

const DEFAULT: Omit<ClassifyResult, 'matches'> = {
  kind: 'reasoning',
  needsVision: false,
  suggestedLayers: ['router', 'sense', 'text-agent', 'vision-agent'],
  timeoutMs: 55_000,
};

/**
 * Classify a task. Pure, zero-LLM.
 *
 * Returns every rule that matched in `matches` so the router/telemetry can
 * log which pattern triggered for later corpus tuning.
 */
export function classifyTask(task: string): ClassifyResult {
  const t = task.trim();
  const matches: string[] = [];
  let winner: Omit<ClassifyResult, 'matches'> | null = null;

  for (const rule of RULES) {
    if (rule.pattern.test(t)) {
      matches.push(rule.name);
      if (!winner) winner = rule.result;
      // Keep scanning so telemetry sees secondary matches.
    }
  }

  const result = winner ?? DEFAULT;
  return { ...result, matches };
}

/** Re-export so pipeline consumers can import from one place. */
export type { ClassifyResult, TaskCategory };
