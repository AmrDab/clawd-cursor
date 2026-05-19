/**
 * Unified pipeline (v0.8.1) — three layers, ONE agent.
 *
 *   Layer 1 — PREPROCESSOR         ONE job: decide the shape per task.
 *     └─ emits {strategy, subtasks, hints}
 *
 *   Layer 2 — EXECUTOR              ONE job: execute the chosen strategy.
 *     ├─ router              0 LLM  (app launches, shortcuts)
 *     └─ agent               LLM    (ONE agent, three modes:
 *                                     blind / hybrid / vision)
 *
 *   Layer 3 — ESCALATOR             ONE job: when a rung fails, pick the
 *                                   next one (router → blind → hybrid →
 *                                   vision). No premium retry tier.
 *
 * Differences from the pre-unification design:
 *   • text-agent and vision-agent are deleted. Both are the same loop now,
 *     just different tool catalogs and perception seeds.
 *   • Vision is ALWAYS the fallback, never the default.
 *   • All tool calls flow through the agent's SafetyLayer gate — no more
 *     `ctx.platform.*` bypass via the old vision-agent/tools.ts.
 *   • Native tool_use replaces JSON-in-prose parsing (Anthropic tool_use
 *     + OpenAI tool_calls; generic fallback for other providers).
 *   • Per-turn a11y snapshot refresh keeps the model oriented.
 *   • FingerprintHistory stagnation detection forces the agent to change
 *     approach or give_up, not loop forever on a dead button.
 *
 * Model-agnostic: LLM configs flow through AgentLlmDeps. Mixed-provider is
 * supported natively — text can be Ollama, vision can be Anthropic, etc.
 * OS-agnostic: every I/O goes through PlatformAdapter.
 */

import {
  newCorrelationId,
  runWithCorrelation,
} from './observability/correlation';
import { CostMeter } from './observability/cost-meter';
import { logger, EVENTS } from './observability/logger';
import type {
  TaskResult as PipelineTaskResult,
  PipelineAction,
} from './pipeline-types';
import type { PlatformAdapter } from '../platform/types';

import { preprocess, type Strategy } from './preprocessor/preprocessor';
import { Router, type RouteResult } from './router/router';
import { SkillCache } from './skills/skill-cache';
import { runAgent } from './agent-loop/agent';
import type { AgentLlmConfig, AgentLlmDeps, AgentMode, AgentResult } from './agent-loop/types';
import type { Verifier, StateSnapshot, TaskType, ReflectionFeedback } from './verifier-types';
import { GroundTruthVerifier } from './verifier';
import type { Capability } from './classify/capability';
import { decomposeWithLlm } from './decompose/llm-decomposer';
import { callLLMWithTools } from '../llm/client';
import { OcrEngine } from '../platform/ocr-engine';
import { PLAYBOOKS } from '../tools/playbooks';
import { composeSend as composeSendPlaybook } from '../tools/playbooks/compose-send';
import { extractComposeFields } from '../tools/playbooks/extract-compose';
import { resolveSchemeHandlerExecutable, launchHandlerAndVerify } from '../platform/uri-handler';

/**
 * Patterns that gate the LLM decomposer (v0.9: opt-in instead of always-on).
 *
 * The decomposer runs ONLY when one of these matches OR the offline
 * regex preprocessor already split the task into ≥2 subtasks. Trust
 * the agent with the raw task for everything else.
 *
 * Run LLM when:
 *   • "open any wikipedia page"        → INDEFINITE_INTENT_PATTERN matches
 *   • "open the latest article"        → INDEFINITE_INTENT_PATTERN matches
 *   • "open notepad and type hello"    → COMPOUND_TASK_PATTERN matches
 *   • "find a restaurant near me"      → INDEFINITE_INTENT_PATTERN matches
 *
 * Skip LLM (single-clause concrete task → agent handles it whole):
 *   • "open notepad"                   → no compound, no indefinite
 *   • "send Sarah the Q2 numbers"      → no compound, no indefinite
 *   • "focus outlook"                  → no compound, no indefinite
 *   • "draw a stickman in Paint"       → no compound, no indefinite
 *   • "summarize this page"            → no compound, no indefinite
 */

/** Compound-task hint. Triggers LLM decomposition. */
const COMPOUND_TASK_PATTERN = /\b(?:and|then|,)\b/i;

/**
 * Indefinite phrasing — "any X", "the latest", "a random", "some Y",
 * "today's news", "anything", "an example". Any of these forces LLM
 * decomposition even when the surrounding structure looks trivial.
 *
 * Word-boundary anchored. App-agnostic — these are language patterns,
 * not app-specific rules. English-only (same coupling as the rest of
 * the pipeline's regex layer).
 */
const INDEFINITE_INTENT_PATTERN = new RegExp(
  [
    '\\bany\\b',                           // "any wikipedia page"
    '\\ba\\s+random\\b',                   // "a random article"
    '\\bsome\\s+(?:random\\s+)?\\w+',      // "some restaurant"
    '\\bseveral\\b',                       // "several photos"
    '\\bthe\\s+(?:latest|first|top|most\\s+recent)\\b', // "the latest email"
    '\\btoday\'?s\\b',                     // "today's news"
    '\\bsomething\\b',                     // "something funny"
    '\\banything\\b',                      // "anything trending"
    '\\ban?\\s+example\\b',                // "an example"
    '\\bdefault\\s+(?:browser|mail\\s+client|editor)\\b', // "default browser"
  ].join('|'),
  'i',
);

/**
 * Map the preprocessor's `capability` hint to a verifier `TaskType`.
 * Returning `undefined` lets the verifier fall back to its own regex
 * inference — appropriate for capabilities the verifier doesn't
 * specialize on (e.g. `'window_mgmt'` doesn't have a TaskType).
 *
 * App-agnostic + model-agnostic by construction: pure data lookup, no
 * branching on specific apps or LLM providers.
 */
function capabilityToTaskType(cap?: Capability): TaskType | undefined {
  switch (cap) {
    case 'app_launch':  return 'open_app';
    case 'text_input':  return 'type_text';
    case 'navigation':  return 'navigate_url';
    case 'spatial':     return 'draw';
    case 'file_ops':    return 'create_file';
    // 'form_fill', 'window_mgmt', 'general' have no specialized
    // TaskType — let the verifier infer from task text.
    default:            return undefined;
  }
}

// ─── Dependency injection contract ──────────────────────────────────

/**
 * LLM dependency contract. Each slot is independent — a caller can wire
 * text-only, vision-only, or mixed. The agent gracefully degrades when
 * a required slot is missing (clean give_up with an actionable error).
 */
export interface PipelineLlm {
  /** Text-model config (used for blind + hybrid modes). */
  text?: AgentLlmConfig;
  /** Vision-model config (used for vision mode, and hybrid fallback). */
  vision?: AgentLlmConfig;
}

export interface PipelineDeps {
  adapter: PlatformAdapter;
  llm: PipelineLlm;
  /** Refuse vision even if configured (high-security mode). */
  disableVision?: boolean;
  /** Cap inside the agent loop. Default 20. */
  maxTurnsPerRung?: number;
  /** Maximum strategy escalations per task. Default 3. */
  maxEscalations?: number;
  /**
   * Independent ground-truth verifier. When supplied, every successful
   * agent rung (blind / hybrid / vision) is post-checked against actual
   * screen state — if the verifier rejects (e.g. compose still open
   * after the agent claimed `done`), the rung is demoted to
   * `failureReason: 'verifier_rejected'` and the ladder climbs to the
   * next rung.
   *
   * Skipped for `router` rungs (those already use a deterministic
   * before/after window-list diff).
   *
   * Caller can pass a real `GroundTruthVerifier(adapter)` or any test
   * double satisfying the `Verifier` interface. When omitted, the
   * pipeline auto-creates a `GroundTruthVerifier` unless
   * `disableVerifier` is true.
   */
  verifier?: Verifier;
  /**
   * Disable the verifier entirely. The agent's `done()` claim is taken
   * at face value (the pre-verifier behavior). Use for tests that mock
   * the agent without setting up screen state, or for users that
   * explicitly opted out.
   */
  disableVerifier?: boolean;
  /**
   * LLM-based task decomposer for compound natural-language tasks
   * containing indefinite phrasing ("any wikipedia page", "a random
   * article", "the latest email"). Without this, the regex decomposer
   * passes the literal phrase through to the router, which then types
   * "any wikipedia page" into a search bar — the v0.7-vs-v0.8
   * regression.
   *
   * Auto-instantiated from `llm.text` when present. Pass `null` to
   * disable, or a custom function for tests. Invocation is conditional
   * on `INDEFINITE_INTENT_PATTERN` matching the original task — most
   * tasks ("open notepad", "send email to ...") don't trigger it and
   * pay no extra latency.
   */
  decomposer?: ((task: string) => Promise<string[] | null>) | null;
}

export const PIPELINE_DEFAULTS: Required<Pick<PipelineDeps, 'disableVision' | 'maxTurnsPerRung' | 'maxEscalations' | 'disableVerifier'>> = {
  disableVision: false,
  maxTurnsPerRung: 20,
  maxEscalations: 3,
  disableVerifier: false,
};

export interface PipelineRunInput {
  task: string;
  isAborted?: () => boolean;
}

// ─── Pipeline class ─────────────────────────────────────────────────

export class Pipeline {
  private readonly router: Router;
  private readonly skillCache: SkillCache;
  private readonly disableVision: boolean;
  private readonly maxTurnsPerRung: number;
  private readonly maxEscalations: number;
  private readonly verifier: Verifier | null;
  private readonly decomposer: ((task: string) => Promise<string[] | null>) | null;
  /**
   * Lazy OCR engine for the verifier's `after`-snapshot. Constructed on
   * first use so tests that don't exercise verification pay no cost.
   * OS-agnostic: OcrEngine internally dispatches to Win/Mac/Linux
   * backends. Model-agnostic: no LLM involved.
   */
  private ocrEngine: OcrEngine | null = null;

  constructor(private readonly deps: PipelineDeps) {
    this.router = new Router(deps.adapter);
    this.skillCache = new SkillCache();
    this.disableVision = deps.disableVision ?? PIPELINE_DEFAULTS.disableVision;
    this.maxTurnsPerRung = deps.maxTurnsPerRung ?? PIPELINE_DEFAULTS.maxTurnsPerRung;
    this.maxEscalations = deps.maxEscalations ?? PIPELINE_DEFAULTS.maxEscalations;
    // Verifier wiring:
    //   • explicit `disableVerifier: true` → null (skip post-check entirely)
    //   • caller-supplied `verifier`      → use as-is (lets tests inject)
    //   • neither                         → instantiate the default
    //                                       GroundTruthVerifier from the adapter
    if (deps.disableVerifier) {
      this.verifier = null;
    } else {
      this.verifier = deps.verifier ?? new GroundTruthVerifier(deps.adapter);
    }
    // Auto-wire the LLM decomposer when a text model is configured. The
    // decomposer is gated by `INDEFINITE_INTENT_PATTERN` at call time
    // (see `maybeRefineSubtasks`), so the LLM only fires for tasks that
    // actually need interpretation.
    if (deps.decomposer === null) {
      this.decomposer = null;
    } else if (deps.decomposer) {
      this.decomposer = deps.decomposer;
    } else if (deps.llm.text) {
      const textConfig = deps.llm.text;
      this.decomposer = async (task: string) => {
        const callTextLlm = async (system: string, user: string, opts?: { maxTokens?: number }) => {
          const result = await callLLMWithTools({
            baseUrl: textConfig.baseUrl,
            model: textConfig.model,
            apiKey: textConfig.apiKey,
            isAnthropic: textConfig.isAnthropic,
            system,
            tools: [],
            messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
            maxTokens: opts?.maxTokens ?? 512,
            timeoutMs: 30_000,
            toolChoice: 'auto',
          });
          return result.text ?? '';
        };
        return decomposeWithLlm(task, { callTextLlm });
      };
    } else {
      this.decomposer = null;
    }
  }

  async run(input: PipelineRunInput): Promise<PipelineTaskResult> {
    const correlationId = newCorrelationId();
    const startedAt = Date.now();
    const costMeter = new CostMeter();
    const log = logger.with({ correlationId, task: input.task });
    const isAborted = input.isAborted ?? (() => false);

    return runWithCorrelation({ correlationId, taskText: input.task }, async () => {
      const modelSummary = [
        this.deps.llm.text ? `text=${this.deps.llm.text.model}` : 'text=off',
        this.disableVision ? 'vision=disabled' : (this.deps.llm.vision ? `vision=${this.deps.llm.vision.model}` : 'vision=off'),
      ].join(' ');
      log.info(EVENTS.PIPELINE_START, { task: input.task, models: modelSummary });

      // ── PREPROCESS ONCE to decide whether this is a compound task.
      const outerActive = await this.safeActiveWindow();
      const outerDecision = preprocess(input.task, {
        activeWindowTitle: outerActive?.title,
        activeWindowProcessName: outerActive?.processName,
      });
      log.info(EVENTS.PIPELINE_PREPROCESS, {
        strategy: outerDecision.strategy,
        reason: outerDecision.hints.reason,
        appKey: outerDecision.hints.appKey,
        capability: outerDecision.hints.capability,
        subtasks: outerDecision.subtasks.length,
      });

      // Track soft-fails so the footer can report e.g. "3/6 subtasks
      // completed (1 soft-fail continued)" instead of pretending nothing
      // failed. Hard fail still aborts; soft fail is a warning.
      let subtaskSoftFails = 0;
      // Tracks subtasks where the agent itself failed to finish (max_turns,
      // stagnation, give_up, cannot_read, etc.). Distinct from the broader
      // softFails count which also includes low-confidence verifier doubt
      // on otherwise-finished work. Aggregate success demotes only on
      // agent-side failures so the v0.8.0 "agent reports, caller decides"
      // contract still applies to verifier-doubt cases.
      let subtaskAgentFails = 0;

      let subtasks = outerDecision.subtasks.length > 0
        ? outerDecision.subtasks
        : [input.task];

      // ── Tier 0: LLM intent resolution (opt-in for genuinely compound tasks).
      //
      // Evolution:
      //   v0.7.x — LLM decomposer ran UNCONDITIONALLY (slow, but always-on).
      //   v0.8.x — demoted to a regex-gated fallback (fast, but missed
      //            indefinite intents like "any wikipedia page").
      //   v0.8.1 — reverted to "always-on except trivial" (slow again,
      //            and invented phantom scaffolding subtasks like
      //            "create a new canvas in Paint" right after "open Paint").
      //   v0.9   — opt-in: run ONLY when the preprocessor already split
      //            the task into ≥2 subtasks OR the task text matches a
      //            compound/indefinite pattern. Single-clause concrete
      //            tasks ("send Sarah an email", "focus Outlook",
      //            "draw a stickman") go straight to the agent whole —
      //            the agent's own perception loop handles them more
      //            reliably than two isolated subtask agents can.
      //
      // This is the v0.8.0 contract: trust the agent with the original
      // task unless we have strong evidence it's actually compound. Net
      // win: ~700 ms median latency cut, plus elimination of "decomposer
      // invented a phantom subtask" failures. The decomposer stays
      // available for tasks that genuinely need it (cross-app workflows,
      // "the latest X", "any Y", "find a Z").
      //
      // Critical for the picking-up-where-an-upstream-agent-left-off
      // use case: when a caller hands us "send Sarah the Q2 numbers"
      // with Outlook already focused, we no longer insert a phantom
      // "open Outlook" subtask. The router's focus_existing path was
      // already idempotent; this just stops us paying the LLM round-trip
      // for a subtask that didn't need to exist.
      const needsDecompose =
        outerDecision.subtasks.length >= 2
        || COMPOUND_TASK_PATTERN.test(input.task)
        || INDEFINITE_INTENT_PATTERN.test(input.task);
      if (this.decomposer && needsDecompose) {
        log.info('pipeline.decompose.refine_attempt', { task: input.task });
        try {
          const refined = await this.decomposer(input.task);
          if (refined && refined.length > 0) {
            log.info('pipeline.decompose.refined', {
              originalSubtasks: subtasks.length,
              refinedSubtasks: refined.length,
              first: refined[0],
            });
            subtasks = refined;
          } else {
            log.info('pipeline.decompose.refine_skipped', { reason: 'llm returned empty' });
          }
        } catch (err) {
          log.warn('pipeline.decompose.refine_failed', {
            error: err instanceof Error ? err.message : String(err),
          });
          // Fall through with the regex decomposer's original subtasks —
          // refinement is best-effort, never authoritative.
        }
      }

      const aggregateTrace: PipelineTaskResult['trace'] = [];
      let lastText = '';
      let lastPath: PipelineTaskResult['path'] = 'text-agent';

      for (let i = 0; i < subtasks.length; i++) {
        if (isAborted()) {
          const result = this.buildResult({
            success: false, path: lastPath, costMeter, startedAt, correlationId,
            text: 'aborted', trace: aggregateTrace,
          });
          log.info(EVENTS.PIPELINE_DONE, {
            success: result.success,
            path: result.path,
            costUsd: result.costUsd,
            durationMs: result.durationMs,
            subtasksTotal: subtasks.length,
            subtasksCompleted: i,
            subtasksSoftFailed: subtaskSoftFails,
            abortReason: 'aborted',
          });
          return result;
        }

        const subtask = subtasks[i];
        log.info(EVENTS.PIPELINE_SUBTASK, { index: i + 1, of: subtasks.length, subtask });

        const subActive = await this.safeActiveWindow();
        const subDecision = i === 0 && subtasks.length === 1
          ? outerDecision
          : preprocess(subtask, {
              activeWindowTitle: subActive?.title,
              activeWindowProcessName: subActive?.processName,
            });

        const subResult = await this.runOneSubtask(
          subtask,
          subDecision,
          { costMeter, log, isAborted, trace: aggregateTrace },
        );

        lastText = subResult.text;
        lastPath = subResult.path;

        if (!subResult.success) {
          // v0.8.0 had NO chain to abort — one task, one verifier pass at
          // the end. v0.8.1 introduced per-subtask verification and made
          // chain-abort the default on any failure; that turned a single
          // imperfect subtask into a whole-task failure. The user-facing
          // contract v0.8.0 had was: "the agent ran, here's what it
          // claims; you decide what to do." v0.9 walks back to that
          // contract for everything except true unrecoverable failures.
          //
          // Hard-abort ONLY on:
          //   - 'aborted'                        → user pressed cancel
          //   - 'error'                          → infrastructure threw
          //   - 'anti_pattern'                   → explicit failure signal
          //                                        detected on the post-screen
          //                                        ("send failed", "401",
          //                                        "cannot save", error modal)
          //   - 'verifier_rejected' + conf≥0.8  → verifier is CERTAIN it failed
          //
          // Soft-fail (log + continue) on everything else:
          //   max_turns, stagnation, give_up, cannot_read, no_text_model,
          //   vision_disabled, router_miss, no_llm, no_ladder,
          //   verifier_rejected with confidence < 0.8.
          //
          // The aggregate result still reports which subtasks soft-failed,
          // so callers see partial completion. This matches v0.8.0's "agent
          // reports, caller decides" contract while keeping v0.9's
          // structured chain telemetry. OS/model/app-agnostic.
          const reason = subResult.failureReason;
          const verifierConfidence = subResult.verifierConfidence ?? 0;
          // Route the hard-abort decision off the STRUCTURED category, not
          // the stringly-typed reason. Before this change the gate matched
          // `reason === 'aborted'` for user-cancel — but a rung-internal
          // LLM-call timeout (e.g. `AbortSignal.timeout(45s)` firing inside
          // `callLLMWithTools`) surfaces with an AbortError whose downstream
          // labels can blur with the user-cancel label. Routing off the
          // category collapses that ambiguity: `user_abort` is the only
          // abort-class category that maps from `failureReason: 'aborted'`,
          // and `rung_llm_error` (timeouts, transport, 5xx) explicitly
          // does NOT hard-abort — it lets the ladder climb to vision.
          //
          // Fall back to the legacy mapping if a rung wrapper forgot to
          // set `failureCategory` (older custom verifiers / extension points
          // may not have been updated). The explicit field wins when both
          // are present.
          const category = subResult.failureCategory ?? categorizeFailureReason(reason);
          const isHardAbort =
            category === 'user_abort'
            || category === 'infra_error'
            || category === 'anti_pattern'
            || (category === 'verifier_rejected' && verifierConfidence >= 0.8);

          if (!isHardAbort) {
            log.warn('pipeline.subtask.soft_fail_continue', {
              index: i + 1, of: subtasks.length, subtask,
              path: subResult.path,
              reason,
              confidence: verifierConfidence,
              note: reason === 'verifier_rejected'
                ? 'low-confidence verifier rejection — likely idempotent no-op; chain continues'
                : `non-fatal failure (${reason}) — chain continues; aggregate result reports soft-fail`,
            });
            subtaskSoftFails += 1;
            // Distinguish agent-side soft-fails (the agent itself gave up
            // or ran out of turns / stagnated, OR every rung's LLM call
            // failed) from verifier-doubt soft-fails (agent claimed `done`
            // but verifier wasn't certain).
            // Aggregate `success` reflects whether the agent's work was
            // completed end-to-end; verifier doubt at low confidence doesn't
            // demote success since the previous design rationale ("agent
            // reports, caller decides") was specifically aimed at idempotent
            // no-op rejections like "create new canvas" after "open Paint".
            //
            // Route off `failureCategory` instead of re-matching strings.
            // Anything that isn't `verifier_rejected` (verifier-doubt) counts
            // as an agent-side fail for aggregate accounting — including
            // `rung_llm_error`, which previously fell through the
            // string-match list and let a chain of pure LLM timeouts report
            // a phantom `success: true`.
            const subCategory = subResult.failureCategory ?? categorizeFailureReason(reason);
            const isAgentSideFailure = subCategory !== 'verifier_rejected';
            if (isAgentSideFailure) subtaskAgentFails += 1;
            // Don't update lastText with a failure message — the next
            // subtask should see "what came before" as the agent's claim.
          } else {
            log.warn('pipeline.subtask.failed_chain_abort', {
              index: i + 1, subtask, path: subResult.path, reason: subResult.failureReason,
            });
            const result = this.buildResult({
              success: false, path: subResult.path, costMeter, startedAt, correlationId,
              text: subtasks.length > 1
                ? `Subtask ${i + 1}/${subtasks.length} failed ("${subtask}"): ${subResult.text}`
                : subResult.text,
              trace: aggregateTrace,
            });
            log.info(EVENTS.PIPELINE_DONE, {
              success: result.success,
              path: result.path,
              costUsd: result.costUsd,
              durationMs: result.durationMs,
              subtasksTotal: subtasks.length,
              subtasksCompleted: i,
              subtasksSoftFailed: subtaskSoftFails,
              abortReason: subResult.failureReason,
            });
            return result;
          }
        }

        // Brief settle between subtasks so the next preprocess sees the
        // correct active window.
        if (i < subtasks.length - 1) await delay(400);
      }

      this.recordSkillOnPass(input.task, aggregateTrace, outerActive?.processName).catch(() => {});
      // success boolean reflects whether the agent's work actually finished,
      // not whether the pipeline machinery ran without an exception. A
      // subtask hitting max_turns / give_up / stagnation / cannot_read /
      // verifier_rejected is the agent failing to complete its work; the
      // aggregate must NOT silently report success in that case. The
      // soft-fail-continue path (chain doesn't hard-abort on a single bad
      // subtask) is still useful for partial work, but the aggregate
      // boolean has to be honest. The previous unconditional `success: true`
      // gave callers (CLI, MCP clients, the user) a false positive every
      // time anything soft-failed, e.g. the Outlook send-email run that
      // hit max_turns on subtask 2 yet showed up as `done`.
      const aggregateSuccess = subtaskAgentFails === 0;
      const result = this.buildResult({
        success: aggregateSuccess, path: lastPath, costMeter, startedAt, correlationId,
        text: subtasks.length > 1
          ? (aggregateSuccess
              ? `All ${subtasks.length} subtasks completed${subtaskSoftFails ? ` (${subtaskSoftFails} verifier-doubt continued)` : ''}. Last: ${lastText}`
              : `${subtasks.length - subtaskAgentFails}/${subtasks.length} subtasks completed by the agent; ${subtaskAgentFails} agent-side failures. Last: ${lastText}`)
          : (aggregateSuccess ? lastText : `Subtask did not finish: ${lastText}`),
        trace: aggregateTrace,
      });
      log.info(EVENTS.PIPELINE_DONE, {
        success: result.success,
        path: result.path,
        costUsd: result.costUsd,
        durationMs: result.durationMs,
        subtasksTotal: subtasks.length,
        subtasksCompleted: subtasks.length,
        subtasksSoftFailed: subtaskSoftFails,
      });
      return result;
    });
  }

  /**
   * Run one subtask through the escalation ladder.
   *
   * Verifier integration:
   *   - Capture a `before` state ONCE before the ladder runs (not per-rung).
   *     The verifier's job is "did the WHOLE work for this subtask result
   *     in the desired screen state?" — so we want to compare against the
   *     state at the start of the subtask, not the state at the start of
   *     each rung (which is what blind has potentially-already-changed to).
   *   - After each AGENT rung (blind / hybrid / vision) reports success,
   *     capture an `after` state and run `verifier.verify(...)`. If the
   *     verifier rejects, demote `success: false` with
   *     `failureReason: 'verifier_rejected'` and let the ladder climb.
   *   - The `router` rung is exempt — it already does its own deterministic
   *     window-list diff and emitting a screenshot for verification on
   *     every router success would be expensive (router is the fast path).
   *   - If the verifier itself throws (platform hiccup, etc.), log and
   *     accept the agent's claim — the verifier is supplementary, not
   *     authoritative. Adopt-don't-override on error.
   */
  private async runOneSubtask(
    task: string,
    decision: ReturnType<typeof preprocess>,
    env: StrategyEnv,
  ): Promise<StrategyResult> {
    const ladder = this.buildLadder(decision.strategy);
    env.log.debug('pipeline.ladder', { ladder, strategy: decision.strategy });

    // Snapshot the "before" state ONCE per subtask, only if a verifier is
    // active. Skipped for tasks that can't escalate to an agent rung
    // (router-only ladder is the only such case, but those are quickly
    // followed by agent rungs anyway, so we still capture).
    const before = await this.captureVerifierState(env, 'before');

    let last: StrategyResult = {
      success: false, path: 'text-agent',
      text: 'no strategies tried', failureReason: 'no_ladder',
      failureCategory: 'config_missing',
    };
    let rungsTried = 0;
    /** Last structured feedback from the verifier — carried into the next rung's agent call. */
    let lastFeedback: ReflectionFeedback | undefined;

    // Whether the Reflector override is active (gated env var — see PR9 spec).
    const reflectorEnabled = process.env.CLAWD_REFLECTOR === '1';

    for (let ladderIdx = 0; ladderIdx < ladder.length; ladderIdx++) {
      if (env.isAborted()) {
        // True user abort — the AbortController fed from the host (CLI,
        // MCP, scheduler) flipped. Distinct from a rung-internal LLM
        // timeout, which would have already surfaced as `rung_llm_error`
        // via the agent's catch in agent-loop/agent.ts.
        return {
          success: false, path: last.path, text: 'aborted',
          failureReason: 'aborted', failureCategory: 'user_abort',
        };
      }
      if (rungsTried >= this.maxEscalations) break;

      let rung = ladder[ladderIdx];

      // Reflector override: when CLAWD_REFLECTOR=1 and the previous verifier
      // run returned a `suggestedStrategy`, jump to that rung instead of the
      // default next-ladder entry. Log the override so we have telemetry for
      // the 0.9.1 graduation decision.
      if (reflectorEnabled && lastFeedback?.suggestedStrategy) {
        const overrideStrategy = lastFeedback.suggestedStrategy;
        // Only override if the suggestion maps to a real agent rung and we
        // haven't already tried it (don't loop forever).
        const agentRungs = new Set<string>(['router', 'blind', 'hybrid', 'vision']);
        if (agentRungs.has(overrideStrategy)) {
          const overrideRung = overrideStrategy as Strategy;
          if (!ladder.slice(0, ladderIdx).includes(overrideRung)) {
            env.log.info('pipeline.reflector.override', {
              fromRung: rung,
              toRung: overrideRung,
              cause: lastFeedback.causes[0]?.kind,
              suggestedStrategy: overrideStrategy,
            });
            rung = overrideRung;
          }
        }
        // wait_and_retry / change_target don't map to a specific ladder rung —
        // log them and fall through to the default rung.
        if (!agentRungs.has(overrideStrategy)) {
          env.log.info('pipeline.reflector.override', {
            fromRung: rung,
            toRung: 'default (non-rung strategy)',
            cause: lastFeedback.causes[0]?.kind,
            suggestedStrategy: overrideStrategy,
          });
        }
      }

      rungsTried++;
      env.log.info(EVENTS.PIPELINE_RUNG, { strategy: rung, attempt: rungsTried });

      const attempt = await this.executeStrategy(rung, task, decision, env, lastFeedback);
      last = attempt;

      // Verifier post-check. Only runs when:
      //   • a verifier is active (not disabled)
      //   • the rung claims success
      //   • the rung was NOT the router (router has its own window-list-diff
      //     evidence — it only reports success when a new matching window
      //     was observed after launch. The pre-v0.9 pixel-diff verifier
      //     used to overrule that and escalate a successful 2-second mailto
      //     into 20 wasted LLM turns; the router exemption survives.)
      //   • playbooks are NO LONGER exempt (v0.9.1). The deterministic
      //     keyboard choreography in compose-send returns success=true
      //     unconditionally — it cannot tell from inside whether a "no
      //     subject" dialog intercepted, whether the message stuck in
      //     Outbox, or whether Send fired at all. Real user report on
      //     macOS Mail showed subject + body collapsing into one field
      //     with the playbook still claiming success. The send_email task
      //     assertions in verifier.ts (compose_closed via window-list,
      //     recipient_visible, not_just_saved_as_draft) catch exactly this
      //     class of bug — but only if we let them run. Verifier is <500ms;
      //     soft-fail on low confidence already exists for idempotent ops.
      //   • we managed to capture a `before` state earlier
      if (
        attempt.success
        && this.verifier
        && rung !== 'router'
        && before
      ) {
        const verdict = await this.runVerifier(
          task,
          rung,
          before,
          capabilityToTaskType(decision.hints.capability),
          env,
        );
        // Always stash feedback for the next rung's hint injection.
        if (verdict.kind !== 'skipped' && verdict.feedback) {
          lastFeedback = verdict.feedback;
        }
        if (verdict.kind === 'rejected') {
          env.log.warn('pipeline.verifier.rejected', {
            strategy: rung,
            attempt: rungsTried,
            confidence: verdict.confidence,
            reason: verdict.reason,
          });
          // Demote this rung to a failure so the ladder climbs.
          attempt.success = false;
          attempt.failureReason = 'verifier_rejected';
          attempt.failureCategory = 'verifier_rejected';
          attempt.verifierConfidence = verdict.confidence;
          attempt.text = `${attempt.text} (verifier rejected: ${verdict.reason})`;
          last = attempt;
          // Continue the loop — try the next rung.
          continue;
        }
        if (verdict.kind === 'verified') {
          env.log.info('pipeline.verifier.verified', {
            strategy: rung,
            attempt: rungsTried,
            confidence: verdict.confidence,
          });
        }
        // verdict.kind === 'skipped' (verifier threw / unavailable) →
        // adopt the agent's claim as-is and fall through to return.
      }

      if (attempt.success) return attempt;

      env.log.info('pipeline.rung.failed', {
        strategy: rung, reason: attempt.failureReason, attempt: rungsTried,
      });

      // If blind failed with cannot_read, that's an explicit escalation
      // signal from the agent — move to hybrid (or vision if hybrid also
      // misses). Don't attempt blind twice.
      if (rung === 'blind' && attempt.failureReason === 'cannot_read') {
        // Skip hybrid if we have no vision model — go straight to the
        // next different path (or give up).
      }
    }

    return last;
  }

  // ─── Verifier helpers ──────────────────────────────────────────────

  /**
   * Capture a `StateSnapshot` for the verifier, or null when the verifier
   * is disabled / capture fails. OCR text is left empty — the verifier's
   * window/focus/pixel signals work regardless, and OCR-dependent
   * assertions degrade gracefully (they just don't add weight to the
   * verdict). OCR runs ONLY on the `after`-snapshot so `task_assertions`
   * (weight 0.3 — the largest single signal) can match recipient strings,
   * URLs, typed text, etc. The `before`-snapshot keeps `ocrText: ''`
   * because `ocr_delta` compares deltas and degrades gracefully when one
   * side is empty. Net cost: one OCR pass per subtask (~150-400 ms on
   * Win/Mac native OCR, ~600 ms-1.5 s on Tesseract/Linux), in exchange
   * for restoring v0.8.0-grade verifier accuracy on send_email,
   * navigate_url, type_text, compose_message, search.
   *
   * If OCR is unavailable on this platform (no Tesseract installed,
   * permissions denied), captureState gets `''` and the verifier falls
   * back to pixel/window/focus signals — same as before this change.
   * OS-agnostic, model-agnostic, app-agnostic.
   */
  private async captureVerifierState(
    env: StrategyEnv,
    label: 'before' | 'after',
  ): Promise<StateSnapshot | null> {
    if (!this.verifier) return null;
    try {
      const ocrText = label === 'after' ? await this.captureOcrText() : '';
      return await this.verifier.captureState(ocrText);
    } catch (err) {
      env.log.warn('pipeline.verifier.capture_failed', {
        label, error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Best-effort OCR of the current screen for the verifier's after-state.
   * Returns '' on any failure (unavailable platform, timeout, permission
   * denied) — the verifier then degrades to pixel/window/focus only,
   * which is the same contract we shipped pre-this-change.
   */
  private async captureOcrText(): Promise<string> {
    try {
      if (!this.ocrEngine) this.ocrEngine = new OcrEngine();
      if (!this.ocrEngine.isAvailable()) return '';
      const result = await this.ocrEngine.recognizeScreen();
      return result.fullText ?? '';
    } catch {
      return '';
    }
  }

  /**
   * Run the verifier and classify the verdict into one of three actionable
   * outcomes:
   *   - 'verified'   → confidence ≥ 0.6, accept the agent's claim
   *   - 'rejected'   → low confidence, demote and escalate
   *   - 'skipped'    → after-state capture failed / verifier threw —
   *                    adopt the agent's claim as-is (defensive: don't
   *                    block the user on a verifier infra hiccup)
   *
   * Uses `verifyWithFeedback` when available so the pipeline always has
   * structured ReflectionFeedback for logging and (when CLAWD_REFLECTOR=1)
   * for ladder-override decisions.
   */
  private async runVerifier(
    task: string,
    rung: Strategy,
    before: StateSnapshot,
    taskType: TaskType | undefined,
    env: StrategyEnv,
  ): Promise<
    | { kind: 'verified'; confidence: number; reason: string; feedback?: ReflectionFeedback }
    | { kind: 'rejected'; confidence: number; reason: string; feedback?: ReflectionFeedback }
    | { kind: 'skipped'; reason: string }
  > {
    if (!this.verifier) return { kind: 'skipped', reason: 'verifier disabled' };
    const after = await this.captureVerifierState(env, 'after');
    if (!after) return { kind: 'skipped', reason: 'after-state capture failed' };
    try {
      // Prefer `verifyWithFeedback` (always present on GroundTruthVerifier and
      // any conforming test double) for structured Cause[]. Fall back to the
      // plain `verify` for legacy doubles that only implement the old interface.
      let feedback: ReflectionFeedback | undefined;
      if (typeof this.verifier.verifyWithFeedback === 'function') {
        feedback = await this.verifier.verifyWithFeedback({ task, before, after, taskType });
      }

      // Always log the structured feedback regardless of CLAWD_REFLECTOR flag —
      // the flag only gates the ladder-override behaviour, not observability.
      if (feedback) {
        env.log.debug('pipeline.verifier.verdict', {
          strategy: rung,
          pass: feedback.pass,
          confidence: feedback.confidence,
          hint: feedback.hint,
          causes: feedback.causes.map(c => c.kind),
          suggestedStrategy: feedback.suggestedStrategy,
        });
      } else {
        // Plain verify path (legacy test doubles).
        const verdict = await this.verifier.verify({ task, before, after, taskType });
        env.log.debug('pipeline.verifier.verdict', {
          strategy: rung,
          pass: verdict.pass,
          confidence: verdict.confidence,
          reason: verdict.reason,
          signals: verdict.signals.map(s => ({ name: s.name, value: s.value, weight: s.weight })),
        });
        return verdict.pass
          ? { kind: 'verified', confidence: verdict.confidence, reason: verdict.reason }
          : { kind: 'rejected', confidence: verdict.confidence, reason: verdict.reason };
      }

      return feedback.pass
        ? { kind: 'verified', confidence: feedback.confidence, reason: feedback.hint, feedback }
        : { kind: 'rejected', confidence: feedback.confidence, reason: feedback.hint, feedback };
    } catch (err) {
      env.log.warn('pipeline.verifier.threw', {
        error: err instanceof Error ? err.message : String(err),
      });
      return { kind: 'skipped', reason: 'verifier threw' };
    }
  }

  // ─── Strategy dispatch ──────────────────────────────────────────

  private buildLadder(initial: Strategy): Strategy[] {
    if (initial === 'router') {
      return ['router', 'blind', 'hybrid', 'vision'];
    }
    if (initial === 'playbook') {
      // Playbook is the cheapest non-router path. Failure escalates into
      // the normal LLM ladder so a broken keyboard shortcut on a custom
      // app still recovers via the agent.
      return ['playbook', 'blind', 'hybrid', 'vision'];
    }
    if (initial === 'blind') {
      return ['blind', 'hybrid', 'vision'];
    }
    if (initial === 'hybrid') {
      return ['hybrid', 'vision'];
    }
    return ['vision'];
  }

  private async executeStrategy(
    strategy: Strategy,
    task: string,
    decision: ReturnType<typeof preprocess>,
    env: StrategyEnv,
    prevFeedback?: ReflectionFeedback,
  ): Promise<StrategyResult> {
    switch (strategy) {
      case 'router':   return this.runRouter(task, env);
      case 'playbook': return this.runPlaybook(task, decision, env);
      case 'blind':    return this.runUnifiedAgent(task, decision, env, 'blind', prevFeedback);
      case 'hybrid':   return this.runUnifiedAgent(task, decision, env, 'hybrid', prevFeedback);
      case 'vision':   return this.runUnifiedAgent(task, decision, env, 'vision', prevFeedback);
    }
  }

  private async runRouter(task: string, env: StrategyEnv): Promise<StrategyResult> {
    void env;
    const r: RouteResult = await this.router.route(task);
    if (r.handled) {
      return { success: true, text: r.description ?? 'router handled', path: 'router' };
    }
    return {
      success: false,
      text: r.description ?? 'router miss',
      path: 'router',
      failureReason: 'router_miss',
      failureCategory: 'config_missing',
    };
  }

  /**
   * Run a deterministic capability playbook with zero LLM turns.
   *
   * The preprocessor sets strategy='playbook' when matchPlaybook() returns
   * a registry key for the task. The pipeline calls this method, which
   * dispatches to PLAYBOOKS[name] with extracted fields. On any failure
   * (extraction returned empty, playbook threw, no compose window appeared)
   * the rung returns failureReason='playbook_miss' and the ladder escalates
   * into blind→hybrid→vision normally.
   *
   * compose-send specifically: prefer the OS mailto: handler path (one
   * URI dispatch pre-fills To/Subject/Body atomically, then one mod+Return
   * sends it). Fall back to the in-app keyboard choreography if no mailto
   * handler is registered or the dispatched compose never appears.
   *
   * Cost target: zero LLM calls, zero screenshots, <3 seconds wall clock.
   */
  private async runPlaybook(
    task: string,
    decision: ReturnType<typeof preprocess>,
    env: StrategyEnv,
  ): Promise<StrategyResult> {
    const name = decision.hints.playbookName;
    if (!name) {
      return { success: false, text: 'playbook: no name in hints', path: 'playbook', failureReason: 'playbook_miss', failureCategory: 'config_missing' };
    }

    if (name === 'compose-send') {
      return this.runComposeSendPlaybook(task, env);
    }

    const playbook = PLAYBOOKS[name];
    if (!playbook) {
      return { success: false, text: `playbook: unknown name "${name}"`, path: 'playbook', failureReason: 'playbook_miss', failureCategory: 'config_missing' };
    }
    try {
      const result = await playbook({ adapter: this.deps.adapter, input: {} });
      env.log.info('pipeline.playbook.run', { name, success: result.success, steps: result.steps.length });
      return {
        success: result.success,
        text: result.text,
        path: 'playbook',
        failureReason: result.success ? undefined : 'playbook_miss',
        failureCategory: result.success ? undefined : 'config_missing',
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      env.log.warn('pipeline.playbook.threw', { name, error: msg });
      return { success: false, text: `playbook "${name}" threw: ${msg}`, path: 'playbook', failureReason: 'playbook_miss', failureCategory: 'config_missing' };
    }
  }

  /**
   * compose-send specialized path. Two execution strategies, in order:
   *
   *   1. mailto: URI dispatch — single OS call pre-fills To/Subject/Body.
   *      Confirmed working for New Outlook via the resolved-handler path
   *      (commit 740ead8). If a new compose window appears AND fields
   *      could be extracted, this is ~1.5 seconds end-to-end with one
   *      mod+Return to send.
   *
   *   2. In-app keyboard choreography — PLAYBOOKS['compose-send']. Used
   *      when the URI dispatch fails (no registered handler, or the
   *      target app ignores the dispatch). Drives the app's native
   *      compose UI with mod+n + Tab + type, finished with mod+Return.
   *
   * Returns failureReason='playbook_miss' on either path failure so the
   * ladder escalates to blind. Doesn't mark the chain as hard-failed —
   * the agent ladder is a legitimate recovery mode.
   */
  private async runComposeSendPlaybook(task: string, env: StrategyEnv): Promise<StrategyResult> {
    const fields = extractComposeFields(task);
    if (!fields.recipient) {
      env.log.info('pipeline.playbook.compose_send.no_recipient', { task });
      return { success: false, text: 'compose-send: could not extract recipient email from task', path: 'playbook', failureReason: 'playbook_miss', failureCategory: 'config_missing' };
    }

    // Strategy 1: mailto: URI — pre-fill everything in one shot.
    if (process.platform === 'win32') {
      const uri = buildMailtoUri(fields);
      env.log.info('pipeline.playbook.compose_send.try_mailto', { recipient: fields.recipient, hasSubject: !!fields.subject, hasBody: !!fields.body });
      try {
        const exe = await resolveSchemeHandlerExecutable('mailto');
        if (exe) {
          const launchResult = await launchHandlerAndVerify(exe, uri, { waitMs: 5000 });
          if (launchResult.success && launchResult.windowOpened) {
            // Compose appeared with everything pre-filled. Send it.
            await this.deps.adapter.keyPress('mod+Return');
            await new Promise(r => setTimeout(r, 600));
            env.log.info('pipeline.playbook.compose_send.sent_via_mailto', {
              recipient: fields.recipient,
              handlerExe: exe,
              composeTitle: launchResult.hwndLabel,
            });
            return {
              success: true,
              text: `compose-send (mailto): opened compose "${launchResult.hwndLabel ?? '(unknown)'}" and sent to ${fields.recipient}.`,
              path: 'playbook',
            };
          }
          env.log.info('pipeline.playbook.compose_send.mailto_no_window', { handlerExe: exe });
        } else {
          env.log.info('pipeline.playbook.compose_send.no_handler', {});
        }
      } catch (err) {
        env.log.warn('pipeline.playbook.compose_send.mailto_threw', { error: err instanceof Error ? err.message : String(err) });
      }
    }

    // Strategy 2: in-app keyboard choreography fallback.
    try {
      const result = await composeSendPlaybook({
        adapter: this.deps.adapter,
        input: { to: fields.recipient, subject: fields.subject, body: fields.body },
      });
      env.log.info('pipeline.playbook.compose_send.in_app', { success: result.success, steps: result.steps.length });
      return {
        success: result.success,
        text: result.text,
        path: 'playbook',
        failureReason: result.success ? undefined : 'playbook_miss',
        failureCategory: result.success ? undefined : 'config_missing',
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      env.log.warn('pipeline.playbook.compose_send.in_app_threw', { error: msg });
      return { success: false, text: `compose-send (in-app): ${msg}`, path: 'playbook', failureReason: 'playbook_miss', failureCategory: 'config_missing' };
    }
  }

  /**
   * Run the unified agent in the requested mode. Enforces vision-disable
   * config, wires DI into runAgent, projects the AgentResult into the
   * pipeline trace, and maps the exit code to a StrategyResult.
   *
   * When `prevFeedback` is supplied (from the previous rung's verifier
   * rejection), its `hint` is forwarded to the agent as a `reflectorHint`
   * so the planner understands why the prior step failed. The agent injects
   * it as a synthetic `tool_result` at the start of the next turn's history.
   */
  private async runUnifiedAgent(
    task: string,
    decision: ReturnType<typeof preprocess>,
    env: StrategyEnv,
    mode: AgentMode,
    prevFeedback?: ReflectionFeedback,
  ): Promise<StrategyResult> {
    const path: PipelineTaskResult['path'] = mode === 'vision' || mode === 'hybrid'
      ? 'vision-agent'
      : 'text-agent';

    // ── Config availability & vision-disable gating
    if ((mode === 'vision' || mode === 'hybrid') && this.disableVision) {
      return {
        success: false,
        text: 'Vision disabled (--no-vision / OPENCLAW_DISABLE_VISION=1).',
        path,
        failureReason: 'vision_disabled',
        failureCategory: 'config_missing',
      };
    }
    if (mode === 'blind' && !this.deps.llm.text) {
      return {
        success: false,
        text: 'No text model configured. Run `clawdcursor doctor` to set AI_TEXT_MODEL.',
        path,
        failureReason: 'no_text_model',
        failureCategory: 'config_missing',
      };
    }
    if ((mode === 'vision' || mode === 'hybrid') && !this.deps.llm.vision && !this.deps.llm.text) {
      return {
        success: false,
        text: 'No vision or text model configured. Run `clawdcursor doctor`.',
        path,
        failureReason: 'no_llm',
        failureCategory: 'config_missing',
      };
    }

    const llmDeps: AgentLlmDeps = {
      text: this.deps.llm.text,
      vision: this.disableVision ? undefined : this.deps.llm.vision,
    };

    const agentResult: AgentResult = await runAgent(
      {
        task,
        mode,
        guide: decision.hints.guide,
        capability: decision.hints.capability,
        maxTurns: this.maxTurnsPerRung,
        isAborted: env.isAborted,
        reflectorHint: prevFeedback?.hint,
      },
      { adapter: this.deps.adapter, llm: llmDeps },
    );

    // Cost approximation — crude but non-zero. Each turn ≈ 400 input +
    // 120 output tokens for blind; vision bumps that by ~1500 per screenshot.
    const turns = agentResult.steps.length;
    const inputTokens = turns * 400 + agentResult.screenshotsCaptured * 1500;
    const outputTokens = turns * 120;
    env.costMeter.record({
      model: mode === 'vision' || mode === 'hybrid' ? 'vision-agent' : 'text-agent',
      stage: mode,
      inputTokens,
      outputTokens,
    });

    // Project agent steps into the uniform pipeline trace.
    for (const step of agentResult.steps) {
      env.trace.push({
        action: synthActionFromStep(step.toolName, step.toolArgs),
        result: { success: step.result.success, text: step.result.text },
        durationMs: step.durationMs,
      });
    }

    if (agentResult.success) {
      return { success: true, text: agentResult.text, path };
    }

    // Map exit → failureReason so the escalator can make intelligent
    // decisions. `cannot_read` in blind mode should escalate cleanly.
    //
    // The `aborted` exit comes ONLY from the agent's user-abort gate
    // (`isAborted()` returning true at the top of a turn). A rung-internal
    // LLM-call timeout — e.g. `AbortSignal.timeout` firing inside the
    // fetch in `callLLMWithTools` — surfaces as `exit: 'llm_error'`
    // because the agent's `try/catch` around the LLM call converts the
    // AbortError into the `llm_error` exit. That distinction is exactly
    // what the chain-abort gate relies on via `failureCategory` below:
    // `aborted` → `user_abort` → hard-abort the chain; everything else →
    // soft-fail and let the ladder climb.
    const failureReason = agentResult.exit === 'cannot_read' ? 'cannot_read'
      : agentResult.exit === 'give_up' ? 'give_up'
      : agentResult.exit === 'max_turns' ? 'max_turns'
      : agentResult.exit === 'stagnation' ? 'stagnation'
      : agentResult.exit === 'llm_error' ? 'llm_error'
      : agentResult.exit === 'aborted' ? 'aborted'
      : 'agent_failed';

    return {
      success: false,
      text: agentResult.text,
      path,
      failureReason,
      failureCategory: categorizeFailureReason(failureReason),
    };
  }

  // ─── Helpers ────────────────────────────────────────────────────

  private async safeActiveWindow() {
    try { return await this.deps.adapter.getActiveWindow(); }
    catch { return null; }
  }

  private async recordSkillOnPass(
    task: string,
    trace: PipelineTaskResult['trace'],
    appName?: string,
  ): Promise<void> {
    if (!appName || trace.length === 0) return;
    const steps = trace
      .map(t => actionToCachedStep(t.action))
      .filter((s): s is NonNullable<ReturnType<typeof actionToCachedStep>> => s !== null);
    if (steps.length > 0) this.skillCache.record(task, appName, steps);
  }

  private buildResult(args: {
    success: boolean;
    path: PipelineTaskResult['path'];
    costMeter: CostMeter;
    startedAt: number;
    correlationId: string;
    text: string;
    trace: PipelineTaskResult['trace'];
  }): PipelineTaskResult {
    const cost = args.costMeter.snapshot();
    return {
      success: args.success,
      path: args.path,
      costUsd: cost.totalUsd,
      durationMs: Date.now() - args.startedAt,
      correlationId: args.correlationId,
      trace: args.trace,
      text: args.text,
    };
  }
}

// ─── Internal types ─────────────────────────────────────────────────

interface StrategyEnv {
  costMeter: CostMeter;
  log: ReturnType<typeof logger.with>;
  isAborted: () => boolean;
  trace: PipelineTaskResult['trace'];
}

interface StrategyResult {
  success: boolean;
  text: string;
  path: PipelineTaskResult['path'];
  failureReason?: string;
  /**
   * Structured failure category, decoupled from the stringly-typed
   * `failureReason` label. Set on every non-success StrategyResult so the
   * chain-abort gate can decide hard-abort vs soft-fail without re-parsing
   * `failureReason`. See `RungFailureCategory` for the taxonomy.
   *
   * NOTE: `failureReason` is intentionally preserved as the human-readable
   * label for telemetry and existing log consumers. The category is the
   * load-bearing field for control flow; the reason is for humans.
   */
  failureCategory?: RungFailureCategory;
  /** Verifier confidence (0..1) when failureReason === 'verifier_rejected'.
   *  Used by the chain-abort policy to distinguish "verifier strongly says no"
   *  (high confidence) from "verifier couldn't tell" (low confidence). The
   *  latter shouldn't kill a multi-subtask chain on what's likely an
   *  idempotent no-op (e.g. "create new canvas in Paint" when Paint just
   *  opened with a blank canvas → zero pixel-change → low confidence). */
  verifierConfidence?: number;
}

/**
 * Structured failure category for a rung result. Replaces stringly-typed
 * dispatch on `failureReason` for the chain-abort gate and ladder loop.
 *
 * The original bug: when the hybrid rung threw an LLM-call timeout
 * (`AbortSignal.timeout` → `AbortError: operation aborted due to timeout`),
 * the agent surfaced exit='llm_error' and `failureReason: 'llm_error'`,
 * BUT the chain-abort gate fired on `failureReason === 'aborted'` (intended
 * for user-initiated cancellation) — and downstream code paths that
 * forwarded the underlying AbortError's `name === 'AbortError'` ended up
 * collapsing the ladder before the vision rung was tried, even though
 * vision was configured. This category typing makes the user-abort vs
 * rung-internal-failure distinction explicit so no future caller can
 * conflate the two by guessing at the label.
 *
 * Categories — and how the gate must treat each:
 *   • `user_abort`         hard-abort the chain. The user (or the host that
 *                          owns the AbortController fed to the pipeline)
 *                          asked the run to stop; honour that.
 *   • `rung_llm_error`     escalate to the next ladder rung. LLM transport,
 *                          timeout, 5xx, parse error — none of those are a
 *                          signal that the TASK itself can't be done; they
 *                          mean THIS rung's LLM call didn't return useful
 *                          output. The whole point of having a ladder of
 *                          three rungs with different models / perception
 *                          modes is to climb past exactly this failure.
 *   • `agent_gave_up`      escalate to the next ladder rung. The agent
 *                          itself decided to stop (max_turns, stagnation,
 *                          give_up, cannot_read). The aggregate-success
 *                          accounting at the chain level still demotes the
 *                          subtask, but it doesn't collapse the ladder.
 *   • `verifier_rejected`  escalate to the next ladder rung; at the chain
 *                          level, only abort when the verifier's confidence
 *                          is ≥ 0.8 (the existing v0.9 threshold; preserved
 *                          unchanged for backward compat).
 *   • `config_missing`     soft-fail. Missing model / vision disabled /
 *                          router miss / playbook miss / no_ladder /
 *                          no_text_model / no_llm — not a runtime fault,
 *                          just a not-applicable rung. The ladder either
 *                          climbs to the next rung or runs out.
 *   • `anti_pattern`       hard-abort. The agent / verifier detected an
 *                          explicit failure signal on screen (error modal,
 *                          "send failed", auth dialog) — climbing the
 *                          ladder won't help.
 *   • `infra_error`        hard-abort. Pipeline machinery itself threw
 *                          (uncaught exception leaked out of a rung wrapper);
 *                          we can't keep climbing on a structurally broken
 *                          state.
 */
export type RungFailureCategory =
  | 'user_abort'
  | 'rung_llm_error'
  | 'agent_gave_up'
  | 'verifier_rejected'
  | 'config_missing'
  | 'anti_pattern'
  | 'infra_error';

/**
 * Map a legacy `failureReason` string to a structured category. This is
 * the single source of truth — every rung wrapper and every chain-abort
 * decision routes through here, so any new failure-reason string needs
 * exactly one update: add its mapping below, and the chain-abort policy
 * picks up the new case via the category it maps to.
 *
 * The mapping is intentionally exhaustive over the union of reasons
 * currently emitted by `runUnifiedAgent`, `runRouter`, `runPlaybook`,
 * `runOneSubtask`'s ladder-exhaustion path, and the verifier demotion in
 * `runOneSubtask`. Unknown strings fall through to `'infra_error'` —
 * conservative, because an unrecognised failure-reason is usually a sign
 * something further up the call stack threw and the rung wrapper masked
 * the categorisation.
 */
export function categorizeFailureReason(reason: string | undefined): RungFailureCategory {
  switch (reason) {
    case 'aborted':
      return 'user_abort';
    case 'anti_pattern':
      return 'anti_pattern';
    case 'error':
      return 'infra_error';
    case 'llm_error':
    case 'parse_error':
      return 'rung_llm_error';
    case 'max_turns':
    case 'stagnation':
    case 'give_up':
    case 'cannot_read':
      return 'agent_gave_up';
    case 'verifier_rejected':
      return 'verifier_rejected';
    case 'no_text_model':
    case 'no_llm':
    case 'vision_disabled':
    case 'router_miss':
    case 'playbook_miss':
    case 'no_ladder':
      return 'config_missing';
    default:
      return 'infra_error';
  }
}

export type { TaskResult } from './pipeline-types';

// ─── Private utilities ──────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Build an RFC 6068 mailto: URI from extracted compose fields. Encoding
 * preserves @ and , in the recipient path (multi-recipient is valid in
 * the path component) and URL-encodes subject/body so newlines and
 * special chars survive the OS dispatch.
 */
function buildMailtoUri(fields: { recipient: string; subject: string; body: string }): string {
  const safeQuery = (v: string): string =>
    encodeURIComponent(v).replace(/'/g, '%27').replace(/"/g, '%22');
  const safePath = encodeURIComponent(fields.recipient)
    .replace(/%40/g, '@')
    .replace(/%2C/g, ',');
  const params: string[] = [];
  if (fields.subject) params.push(`subject=${safeQuery(fields.subject)}`);
  if (fields.body)    params.push(`body=${safeQuery(fields.body)}`);
  return params.length ? `mailto:${safePath}?${params.join('&')}` : `mailto:${safePath}`;
}

function actionToCachedStep(action: PipelineAction): any | null {
  const src = 'pipeline.agent';
  switch (action.type) {
    case 'a11y_click':     return { type: 'click',  description: `a11y "${action.target}"`, producedBy: src };
    case 'a11y_set_value': return { type: 'type',   description: `a11y set "${action.target}"`, text: action.value, producedBy: src };
    case 'click':          return { type: 'click',  description: `click @${action.x},${action.y}`, x: action.x, y: action.y, producedBy: src };
    case 'type':           return { type: 'type',   description: 'type', text: action.text, producedBy: src };
    case 'press':          return { type: 'key',    description: `press ${action.combo}`, key: action.combo, producedBy: src };
    case 'scroll':         return { type: 'scroll', description: `scroll ${action.dir}`, direction: action.dir, amount: action.amount, producedBy: src };
    case 'wait':           return { type: 'wait',   description: `wait ${action.ms}ms`, ms: action.ms, producedBy: src };
    default:               return null;
  }
}

/**
 * Project a unified-agent tool call into the PipelineAction trace vocabulary
 * so the pipeline's trace stays uniform across router / playbook / agent.
 */
function synthActionFromStep(toolName: string, args: any): PipelineAction {
  switch (toolName) {
    case 'click':
      return { type: 'click', x: Number(args?.x ?? 0), y: Number(args?.y ?? 0) };
    case 'type':
      return { type: 'type', text: String(args?.text ?? '') };
    case 'key':
      return { type: 'press', combo: String(args?.combo ?? args?.key ?? '') };
    case 'scroll': {
      const dir = ['up', 'down', 'left', 'right'].includes(args?.direction) ? args.direction : 'down';
      return { type: 'scroll', dir, amount: args?.amount };
    }
    case 'drag':
      return {
        type: 'drag',
        startX: Number(args?.startX ?? 0),
        startY: Number(args?.startY ?? 0),
        endX:   Number(args?.endX ?? 0),
        endY:   Number(args?.endY ?? 0),
      };
    case 'wait':            return { type: 'wait', ms: Number(args?.ms ?? 0) };
    case 'screenshot':      return { type: 'screenshot' };
    case 'invoke_element':  return { type: 'a11y_click', target: String(args?.name ?? '') };
    case 'set_field_value': return { type: 'a11y_set_value', target: String(args?.name ?? ''), value: String(args?.value ?? '') };
    case 'done':            return { type: 'done', reason: String(args?.evidence ?? args?.reason ?? 'ok') };
    case 'give_up':         return { type: 'give_up', reason: String(args?.reason ?? 'unknown') };
    case 'cannot_read':     return { type: 'cannot_read', reason: String(args?.reason ?? 'a11y insufficient') };
    // Non-mutating tools don't have a dedicated PipelineAction type — they
    // read state only. We project them as `wait(0)` trace entries so the
    // trace stays truthful (the action ran) without polluting retry/replay
    // with a non-executable verb. Keeps skill-cache sane.
    case 'read_screen':
    case 'list_windows':
    case 'read_clipboard':
    case 'write_clipboard':
    case 'open_app':
    case 'focus_window':
      return { type: 'wait', ms: 0 };
    default:
      return { type: 'cannot_read', reason: `unmapped tool: ${toolName}` };
  }
}
