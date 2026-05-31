/**
 * Layer 1 — Preprocessor.
 *
 * ONE job: look at the task, decide the SHAPE. Emits a Strategy telling
 * the executor which path to run:
 *
 *   - 'router'         → zero-LLM shortcut path (router handles end-to-end)
 *   - 'blind'          → structured perception + text LLM only, no screenshots
 *   - 'vision'         → vision LLM with screenshots, a11y tree seeded up-front
 *   - 'hybrid'         → blind-first with on-demand screenshot tool for the LLM
 *
 * The order is flexible per task. Spatial / canvas / drag tasks go straight
 * to 'vision'. Mechanical tasks that match router patterns go straight to
 * 'router'. Everything else defaults to 'blind' (cheapest) with escalation
 * available from Layer 3.
 *
 * Pure and synchronous where possible. The only LLM call that could ever
 * happen here is the optional decomposer for compound tasks — and that's
 * opt-in via deps.decomposer.
 *
 * Model-agnostic by construction.
 */

import type { ClassifyResult } from '../pipeline-types';
import { classifyTask } from '../classify/classify';
import { classifyCapability, type Capability } from '../classify/capability';
import { decompose as regexDecompose } from '../decompose/parser';
import {
  detectApp, loadGuide, getWorkflowForTask, renderAppKnowledge, prefetchGuideForApp,
} from '../../llm/knowledge/loader';
import { matchPlaybook } from '../../tools/playbooks';

export type Strategy =
  /** Router handled it zero-LLM — no executor invocation needed. */
  | 'router'
  /** Deterministic capability playbook (e.g. compose-send). Zero LLM. */
  | 'playbook'
  /** Text-LLM over structured perception (a11y + OCR). Cheapest LLM path. */
  | 'blind'
  /** Vision-LLM from turn 1. For canvas / drag / image-only tasks. */
  | 'vision'
  /** Blind-first with an on-demand screenshot() tool — middle ground. */
  | 'hybrid';

export interface PreprocessDecision {
  /** The picked strategy — executor dispatches on this. */
  strategy: Strategy;
  /** Subtasks, if the regex decomposer split the task. Empty => treat whole task atomically. */
  subtasks: string[];
  /** Hints that travel to the executor / downstream prompts. */
  hints: {
    /** App key detected from title/URL (gmail, outlook, etc.), if any. */
    appKey?: string;
    /** Guide prompt fragment to inject into the agent prompt. */
    guide?: { appName: string; promptFragment: string };
    /** Short telemetry reason for why this strategy was picked. */
    reason: string;
    /**
     * Capability classification (Tranche 2.5) — governs which tools the
     * text agent sees on this subtask. `general` = full catalog; specific
     * values scope to a tight palette (`pipeline/agent/palettes.ts`).
     * Vision agent ignores this and uses compound tools regardless.
     */
    capability?: Capability;
    /**
     * Playbook name (key into PLAYBOOKS registry) when strategy === 'playbook'.
     * Set by the preprocess match step; executor reads this to dispatch.
     */
    playbookName?: string;
  };
  /** Underlying classification, preserved for telemetry / debugging. */
  classification: ClassifyResult;
}

export interface PreprocessContext {
  /** Active window title / process — lets the preprocessor seed app-knowledge. */
  activeWindowTitle?: string;
  activeWindowProcessName?: string;
  /**
   * Live desktop survey (open windows + resolved default handlers). When
   * present, downstream planning (esp. the LLM decomposer) grounds itself in
   * what's actually available instead of guessing. Optional + opaque here so
   * preprocess stays pure; the Pipeline performs the perception and passes the
   * result in. Typed as `unknown`-friendly `DesktopSurvey` via structural use.
   */
  survey?: import('../desktop-survey').DesktopSurvey;
}

/**
 * Pure synchronous preprocessor.
 *
 * The design principle: use the cheapest signal available. We read the
 * classification, consult router/knowledge/decompose data, and emit a
 * strategy WITHOUT touching the LLM. If a caller wants LLM-based
 * decomposition, they can run the regex `subtasks` first and re-call
 * preprocess per subtask — the preprocessor stays simple.
 */
export function preprocess(task: string, ctx: PreprocessContext = {}): PreprocessDecision {
  const trimmed = task.trim();
  const classification = classifyTask(trimmed);
  // Capability classification is on the SUBTASK STRING itself. Compound
  // tasks split into subtasks downstream; each subtask carries its own
  // capability, so the outer preprocess runs this against the whole
  // task text as a best-effort hint (the Pipeline re-preprocesses each
  // subtask individually so the final tag is always subtask-specific).
  const capability = classifyCapability(trimmed);

  // ── Compound task? Try regex decomposition. ──
  // If the decomposer splits cleanly, the caller is expected to run each
  // subtask through the pipeline in turn. If it keeps as one (verb-guard
  // tripped), we proceed with the whole task.
  const decomposed = regexDecompose(trimmed);
  const subtasks = decomposed && !decomposed.keptAsOne && decomposed.subtasks.length > 1
    ? decomposed.subtasks
    : [];

  // ── Knowledge: detect the active app and attach its guide. ──
  // This hint goes to the executor regardless of strategy.
  const appHint = ctx.activeWindowTitle ?? ctx.activeWindowProcessName ?? '';
  const appKey = appHint ? detectApp(appHint) ?? undefined : undefined;
  // Fire a remote prefetch in the background so the cache is warm by the
  // NEXT call to loadGuide for this app. First-touch uses whatever's already
  // local (bundled / cached / user-override); the fetch arrives asynchronously
  // for subsequent tasks. Idempotent within a session.
  if (appKey) prefetchGuideForApp(appKey);
  // `getWorkflowForTask` now returns a fragment whenever the app is detected
  // (with the matched workflow ★-highlighted if a keyword matched). The
  // separate `loadGuide` fallback below stays as a safety net for the rare
  // case where getWorkflowForTask returns null (no detectApp hit).
  const workflow = appHint ? getWorkflowForTask(trimmed, appHint) : null;
  let guide: PreprocessDecision['hints']['guide'] = undefined;
  if (workflow) {
    guide = { appName: workflow.guide.app, promptFragment: workflow.promptFragment };
  } else if (appKey) {
    const g = loadGuide(appKey);
    if (g) {
      guide = { appName: g.app, promptFragment: renderAppKnowledge(g) };
    }
  }

  // ── Strategy selection ──
  // Router patterns take precedence — if the classify hints at mechanical
  // or navigation AND the router pattern matches, let the router try.
  // The router itself has a verified refusal path, so if it misses, it
  // returns cleanly and the executor escalates to a blind run.
  const isRouterCandidate =
    /^\s*(?:open|launch|start|run|go to|navigate to|visit|browse to|focus|switch to)\b/i.test(trimmed) &&
    !decomposed?.keptAsOne;

  if (isRouterCandidate) {
    return {
      strategy: 'router',
      subtasks,
      hints: { appKey, guide, reason: 'router-pattern match', capability },
      classification,
    };
  }

  // Spatial / draw / canvas / drag tasks — skip blind, go vision.
  if (classification.kind === 'spatial') {
    return {
      strategy: 'vision',
      subtasks,
      hints: { appKey, guide, reason: 'classify:spatial — a11y cannot describe canvases', capability },
      classification,
    };
  }

  // Positional clicks / "click the blue button in the top right" — a11y
  // can sometimes resolve these but the wording implies the user is
  // describing a visual location. Hybrid: try blind, allow screenshot.
  if (/\b(blue|red|green|top right|top left|bottom right|bottom left|corner)\b.*\b(button|area)\b/i.test(trimmed)) {
    return {
      strategy: 'hybrid',
      subtasks,
      hints: { appKey, guide, reason: 'visual-wording match → blind-first with screenshot tool', capability },
      classification,
    };
  }

  // Deterministic playbook: when the task matches a capability-shaped
  // pattern (compose-send, find-replace, ...) we can run a fixed
  // keyboard choreography with zero LLM. Tried AFTER router (which is
  // strictly cheaper for things like "open X") but BEFORE the blind
  // ladder, because a playbook beats burning 26 turns on the same work.
  // The executor still falls through to blind if the playbook fails
  // (e.g. fields couldn't be extracted, or the keystrokes didn't land).
  const playbookName = matchPlaybook(trimmed, ctx.activeWindowProcessName ?? '');
  if (playbookName) {
    return {
      strategy: 'playbook',
      subtasks,
      hints: {
        appKey, guide, reason: `playbook:${playbookName}`, capability,
        playbookName,
      },
      classification,
    };
  }

  // Default: blind-first. Cheapest. Text-agent has cannot_read to escalate.
  return {
    strategy: 'blind',
    subtasks,
    hints: { appKey, guide, reason: 'default blind-first', capability },
    classification,
  };
}

/**
 * Convenience predicate — true when the strategy needs an LLM to execute.
 * The executor uses this to refuse tasks cleanly when no text/vision model
 * is configured (structured "no LLM" result instead of a hang or crash).
 */
export function requiresLlm(strategy: Strategy): boolean {
  return strategy !== 'router';
}

/**
 * Convenience predicate — true when the strategy reads the screen via
 * vision. Used by --no-vision / OPENCLAW_DISABLE_VISION gating.
 */
export function usesVision(strategy: Strategy): boolean {
  return strategy === 'vision' || strategy === 'hybrid';
}
