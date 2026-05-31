/**
 * Verifier — independent ground truth check.
 *
 * The agent loop CAN'T mark its own work as done. The verifier looks at
 * actual screen state (before vs. after) and decides whether the task
 * succeeded. No LLM self-assessment, no prompt heuristics.
 */

import type { ScreenshotResult, UiElement, WindowInfo } from '../platform/types';

// ─── Reflector feedback (PR9 — Mobile-Agent-v3 Manager↔Reflector pattern) ───

/**
 * Structured cause of a verification failure. Each variant captures just the
 * fields needed to drive the pipeline's override decision — no free-form prose
 * inside the discriminant.
 */
export type Cause =
  | { kind: 'no_pixel_change' }
  | { kind: 'wrong_window_focused'; expected?: string; actual: string }
  | { kind: 'modal_intercept'; text: string }          // OCR'd unexpected dialog
  | { kind: 'a11y_target_missing'; target: string }
  | { kind: 'webview_blind' }                           // pixels changed, no a11y signal
  | { kind: 'partial_text_match'; expected: string; observed: string };

/**
 * Structured feedback returned by `verifyWithFeedback`. The pipeline ladder
 * consumes `suggestedStrategy` (gated on CLAWD_REFLECTOR=1) to override its
 * default next-rung pick. `hint` is injected as a synthetic `tool_result` at
 * the start of the next agent turn so the planner understands why the previous
 * step failed.
 */
export interface ReflectionFeedback {
  pass: boolean;
  /** 0..1 weighted-vote confidence. */
  confidence: number;
  /** Structured failure causes — never prose. */
  causes: Cause[];
  /** One-line human-readable summary for the next turn's prompt. */
  hint: string;
  /**
   * Suggested escalation strategy. Set when the dominant cause implies a
   * specific path is more likely to succeed than the default ladder order.
   * Undefined → let the ladder pick (default behaviour).
   */
  suggestedStrategy?:
    | 'router' | 'blind' | 'hybrid' | 'vision'
    | 'wait_and_retry' | 'change_target';
}

/** A snapshot of relevant screen state at a point in time. */
export interface StateSnapshot {
  timestamp: number;
  screenshot: ScreenshotResult;
  windows: WindowInfo[];
  activeWindow: WindowInfo | null;
  focusedElement: UiElement | null;
  ocrText: string;            // OCR result joined into a single string for keyword checks
  clipboard: string;
}

export interface VerifyResult {
  /** True if the task is verifiably complete. */
  pass: boolean;
  /** 0-1: how confident we are in the verdict. */
  confidence: number;
  /** Human-readable explanation. */
  reason: string;
  /** Individual signal contributions for debugging. */
  signals: VerifySignal[];
}

export interface VerifySignal {
  name: string;
  weight: number;       // 0-1, contribution to overall verdict
  value: boolean;
  detail: string;
}

export interface VerifyOptions {
  /** Original task description. Used for keyword + intent matching. */
  task: string;
  /** State BEFORE the agent ran. */
  before: StateSnapshot;
  /** State AFTER the agent claims completion. */
  after: StateSnapshot;
  /** Optional task-type hint to enable specialized assertions. */
  taskType?: TaskType;
  /** Names of the tools the agent invoked, in order. Lets the verifier check
   *  provenance — e.g. a "copy" task whose clipboard was set by write_clipboard
   *  (fabrication) rather than a real source copy. Empty/undefined for legacy
   *  callers → provenance checks degrade off (no false rejections). */
  toolTrace?: string[];
}

export type TaskType =
  | 'send_email'
  | 'compose_message'
  | 'open_app'
  | 'navigate_url'
  | 'type_text'
  | 'create_file'
  | 'search'
  /**
   * Spatial / drawing tasks (Paint, Photoshop, Figma, draw-on-canvas in
   * any app). Uses a much lower pixel-diff threshold because drawings
   * are inherently small pixel changes — a stick figure on a 1280×720
   * canvas might paint only ~300 pixels (~0.03%), which the default
   * 0.5% threshold rejects as noise. The `'generic'` fallback is also
   * inappropriate (no text appears, OCR-keyword check always fails).
   */
  | 'draw'
  /**
   * Copy-to-clipboard tasks ("copy a sentence from X"). Verified by a real
   * clipboard mutation whose value traces back to the source view — and NOT
   * fabricated via write_clipboard (which is treated as a hard-fail
   * anti-pattern, since a genuine copy uses a source-window ctrl+c).
   */
  | 'copy'
  | 'generic';

export interface Verifier {
  /** Run all verification signals and return a verdict. */
  verify(opts: VerifyOptions): Promise<VerifyResult>;

  /**
   * Run all verification signals and return structured ReflectionFeedback.
   * Always populates `causes` and `hint`; `suggestedStrategy` is set when
   * the dominant cause implies a specific escalation path.
   */
  verifyWithFeedback(opts: VerifyOptions): Promise<ReflectionFeedback>;

  /** Capture the current state for use as before/after. */
  captureState(ocrText: string): Promise<StateSnapshot>;
}
