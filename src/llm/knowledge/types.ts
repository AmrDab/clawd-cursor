/**
 * Knowledge-layer types — AppGuide, AppWorkflow.
 *
 * These types were previously in pipeline-types.ts. Moved here so the
 * knowledge layer (cache, loader, guide-linter, remote-loader) can be
 * deleted cleanly in Phase 5 without pulling down unrelated pipeline types.
 */

export interface AppGuide {
  /** App key, e.g. "gmail", "outlook", "notion". */
  app: string;
  /** Human-readable display name. Loader fills from `app` if absent. */
  name: string;
  /** Keyboard shortcuts known for this app (platform-aware modifier). */
  shortcuts?: Record<string, string>;
  /**
   * Named workflows. Each entry is EITHER:
   *   - a prose string ("Press Ctrl+N. Type. Click Save.") — human-readable
   *     hint the LLM reasons from. Easiest to author; what most guides use.
   *   - a structured `AppWorkflow` with typed steps — useful when a future
   *     template runner can execute the workflow deterministically.
   * Both shapes ship and load the same way; consumers should handle both.
   */
  workflows?: Record<string, AppWorkflow | string>;
  /**
   * Layout cues — named UI regions and what lives in them. Surfaced to the
   * agent so it can navigate without a screenshot.
   */
  layout?: Record<string, string>;
  /** Free-form tips injected into the text-agent prompt. */
  tips?: string[];
  /** Domain → app mapping hints (gmail → "gmail"). */
  domainHints?: string[];
  /**
   * Auto-persisted workflows from successful `learn_app` calls. Prose form,
   * FIFO-capped at 20. Distinct from hand-curated `workflows` so the user-
   * override learning loop never overwrites curated entries.
   */
  learnedWorkflows?: Record<string, string>;
}

export interface AppWorkflow {
  /** Display name for the workflow. */
  name: string;
  /** Ordered steps. */
  steps: Array<
    | { type: 'pressKey'; key: string; note?: string }
    | { type: 'typeAtFocus'; field: string; note?: string }
    | { type: 'click'; target: string; note?: string }
    | { type: 'wait'; ms: number; note?: string }
    | { type: 'verify'; name: string; note?: string }
  >;
}
