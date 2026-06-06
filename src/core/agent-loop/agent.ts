/**
 * Unified agent loop — replaces text-agent + vision-agent with ONE harness.
 *
 * Design summary:
 *   • ONE tool vocabulary built by `tools.ts` (mode-parameterized).
 *   • Perception: accessibility snapshot EVERY turn (cheap, structured).
 *     Screenshots only when:
 *       (a) mode === 'vision' (turn 1 seed), or
 *       (b) the model explicitly calls the `screenshot` tool, or
 *       (c) a screen-changing tool ran AND mode is hybrid/vision
 *           (so the model sees the result before its next turn).
 *   • LLM: native tool_use via callLLMWithTools (Anthropic tool_use / OpenAI
 *     tool_calls). JSON-from-prose fallback for providers without native support.
 *   • Safety: every tool call runs through `safety.evaluate()` BEFORE its
 *     execute() fires. Single chokepoint.
 *   • Stagnation: FingerprintHistory tracks screen state; 3 identical
 *     fingerprints = force the agent to try something different or give_up.
 *   • Streaming logs: tree-shaped turn logs via the observability logger
 *     so the user can watch what the agent is thinking/doing in real time.
 *
 * Model-agnostic + OS-agnostic by construction: provider config comes from
 * AgentLlmDeps, I/O goes through PlatformAdapter, zero `process.platform`
 * branching here.
 */

import type { ScreenshotResult } from '../../platform/types';
import { FingerprintHistory } from '../sense/fingerprint';
import { captureSnapshot } from '../sense/snapshot';
import { logger, EVENTS, beginSpan } from '../observability/logger';
import { getCorrelationId } from '../observability/correlation';
import { evaluate as safetyEvaluate, isAllowed } from '../safety';
import {
  callLLMWithTools,
  type LLMTool,
  type LLMToolTurn,
  type LLMUserBlock,
  type ToolUseResult,
  type LLMAssistantBlock,
} from '../../llm/client';
import { buildSystemPrompt, renderSnapshot, renderHistory, wrapUntrustedScreenContent } from './prompt';
import { LLM_TARGET_WIDTH } from './coord-scale';
import { buildUnifiedTools } from './tools';
import type {
  AgentInput,
  AgentLlmConfig,
  AgentLlmDeps,
  AgentResult,
  AgentStep,
  AgentToolContext,
  UnifiedTool,
  AgentExit,
  AgentMode,
} from './types';

// Backstop turn cap. With the runaway guard (repeated identical actions) and
// stagnation hard-abort catching genuine stuck-loops early, max_turns is a
// safety net, not the primary detector — so it can be generous enough to
// support long sequential tasks (e.g. a multi-challenge benchmark) that
// legitimately need 30+ actions. Was 20, which truncated such runs mid-task.
const DEFAULT_MAX_TURNS = 70;
/**
 * Number of consecutive identical fingerprints that triggers a stagnation
 * WARNING in the next turn's prompt. Below this we trust the agent to
 * recover on its own (a single side-effect-free tool call like
 * `read_screen` legitimately leaves the fingerprint unchanged).
 */
const STAGNATION_WINDOW = 3;
/**
 * Number of consecutive turns where stagnation kept firing before we abort
 * the rung with `exit: 'stagnation'`. Triggers the pipeline ladder to
 * escalate to the next strategy (blind → hybrid → vision). The previous
 * behavior was warn-only, which let the agent keep typing into a stale
 * screen for the rest of its turn budget — exactly the "agent kept going
 * blind, called done() with hedged evidence" pattern observed live.
 *
 * Tuned conservatively (5) so a couple of legitimate stagnant turns —
 * waiting on a slow window, an a11y blip — don't trip it.
 */
const STAGNATION_HARD_LIMIT = 5;
const MAX_HISTORY_SCREENSHOTS = 2;
/**
 * After this many consecutive turns of `agent.no_tool_call` (model
 * produced text but no parseable tool call), the rung aborts so the
 * pipeline ladder can climb. Three is conservative — a single
 * malformed turn from a degenerate model state can usually self-correct
 * with the "retry with a tool call" reprompt, but three in a row
 * means the model is stuck in a loop and the next strategy has a
 * better chance.
 */
const NO_TOOL_CALL_LIMIT = 3;

export interface AgentDeps {
  adapter: import('../../platform/types').PlatformAdapter;
  llm: AgentLlmDeps;
  /** Optional CDP driver for the browser_* tools (dedicated agent-owned
   *  browser). Resolved lazily by the pipeline from the daemon's driver. */
  cdp?: import('../../platform/cdp-driver').CDPDriver | null;
}

/**
 * Run the unified agent against a task.
 *
 * The function is a pure orchestrator — no side effects outside the
 * tool calls themselves. Returns an AgentResult even on failure.
 */
export async function runAgent(input: AgentInput, deps: AgentDeps): Promise<AgentResult> {
  const startedAt = Date.now();
  const maxTurns = input.maxTurns ?? DEFAULT_MAX_TURNS;
  const isAborted = input.isAborted ?? (() => false);
  const correlationId = getCorrelationId();
  const log = correlationId ? logger.with({ correlationId }) : logger;

  // Select the LLM config per mode. Vision mode REQUIRES a vision model;
  // hybrid prefers vision if available but falls back to text if not
  // (text models with tool_use still work — they just can't see pixels).
  const llmConfig = selectLlmConfig(input.mode, deps.llm);
  if (!llmConfig) {
    const text = input.mode === 'vision'
      ? 'No vision model configured. Run `clawdcursor doctor` to set AI_VISION_MODEL.'
      : 'No text model configured. Run `clawdcursor doctor` to set AI_TEXT_MODEL.';
    return earlyExit('give_up', text, startedAt);
  }

  // Set up perception state.
  const fph = new FingerprintHistory(8);
  const screenshotsCaptured = { n: 0 };

  // Cache screen size once — used for scroll center coordinates.
  let screen: AgentToolContext['screen'];
  try {
    screen = await deps.adapter.getScreenSize();
  } catch {
    screen = { logicalWidth: 1920, logicalHeight: 1080, physicalWidth: 1920, physicalHeight: 1080, dpiRatio: 1 };
  }

  // Build the flat tool catalog. Mode and capability params are no longer
  // accepted — the full catalog is served regardless of mode.
  const tools = buildUnifiedTools();
  const toolMap = new Map(tools.map(t => [t.name, t]));
  const llmTools = toUnifiedLLMTools(tools);

  const systemPrompt = buildSystemPromptWithGuide(input);

  // Seed the conversation.
  const history: LLMToolTurn[] = [];
  const steps: AgentStep[] = [];
  let llmCalls = 0;
  let activeApp: string | undefined;
  /**
   * Counts consecutive turns where stagnation fired. Reset to 0 when the
   * fingerprint changes. When this hits `STAGNATION_HARD_LIMIT` the rung
   * exits with `'stagnation'` so the pipeline ladder can climb. Without
   * this, the agent kept looping on stale screens until max_turns and
   * then fabricated `done()` evidence.
   */
  let consecutiveStagnantTurns = 0;
  /**
   * Counts consecutive turns where the model produced no tool call.
   * Reset to 0 whenever the model successfully emits a tool call. When
   * this hits `NO_TOOL_CALL_LIMIT` the rung aborts with `'give_up'` so
   * the pipeline ladder can climb to the next strategy. Without this,
   * a Kimi/Moonshot model that fell into degenerate generation (loop
   * of repeated tokens, hits max_tokens with no parseable tool call)
   * just kept producing more garbage every turn for 5 minutes until the
   * task-level timeout fired — 12 wasted turns, ~$0.03 wasted, 0
   * actions taken. Real trace: Outlook subtask 3 ("type recipient")
   * after focus_element failed legitimately on turn 1, the model
   * emitted `functions.read_screen:1ORTYMQAQBAA…(1024 tokens of
   * garbage)` for 11 turns straight.
   */
  let consecutiveNoToolCallTurns = 0;

  // Turn-1 perception — always an a11y snapshot. In vision mode, also a
  // screenshot. The blind mode gets text-only snapshot.
  try {
    const firstSnapshot = await captureSnapshot(deps.adapter);
    activeApp = firstSnapshot.activeWindow?.processName;
    fph.push(firstSnapshot.fingerprint);

    const snapshotText = renderSnapshot(firstSnapshot, {
      screenWidth: screen.physicalWidth,
      screenHeight: screen.physicalHeight,
      focusProcessId: firstSnapshot.activeWindow?.processId,
    });

    // DPI/scale header — tells the model how screenshot pixels map to
    // tool-input pixels. The mouse_* tools accept IMAGE-SPACE coords
    // (matching whatever the screenshot was sized at) and scale them
    // internally. The model still needs to know to NOT pre-multiply
    // when looking at the screenshot — passing image coords straight
    // through is correct. Spelled out here because models that DO
    // know about DPI sometimes try to "help" by pre-scaling.
    // The TRUE screenshot scale is physical→1280-image (what the model sees),
    // NOT physicalWidth/logicalWidth — on a 2560-wide screen with dpiRatio 1
    // those differ: physical/logical is 1.0 but the screenshot is still
    // downsampled 2× (2560→1280). Use the real image scale so the note matches
    // what the tools actually do.
    const imgScaleNum = screen.physicalWidth > LLM_TARGET_WIDTH
      ? screen.physicalWidth / LLM_TARGET_WIDTH
      : 1;
    const ssScale = imgScaleNum.toFixed(2);
    const dpiNote =
      input.mode === 'vision'
        ? `\nDISPLAY: ${screen.physicalWidth}×${screen.physicalHeight} physical. Screenshots are downsampled to ${LLM_TARGET_WIDTH}px wide (×${ssScale}). Pass screenshot pixel coords DIRECTLY to mouse_* tools — they scale internally. Do NOT pre-multiply.`
        : `\nDISPLAY: ${screen.physicalWidth}×${screen.physicalHeight} physical, screenshot ${LLM_TARGET_WIDTH}px wide (×${ssScale} to screen).`;
    log.info('agent.coordinate_space', {
      mode: input.mode,
      physical: `${screen.physicalWidth}×${screen.physicalHeight}`,
      screenshotScale: ssScale,
      snapshotSpace: 'screen',
      note: 'a11y coords = screen space (pass-through); screenshot coords = image space (need space:image)',
    });

    // Cross-rung handoff: if a previous agent (the morph's other half) worked
    // this same task and escalated to us, lead with its note so we continue
    // rather than restart. Generic — it's just the prior agent's trace summary.
    const handoffPreamble = input.priorHandoff
      ? `${input.priorHandoff}\n\n`
      : '';
    // Anchor the agent to its working window (when the pipeline resolved one)
    // so it refocuses there instead of thrashing to unrelated apps/tools.
    const windowAnchor = input.targetWindow
      ? `WORKING WINDOW: the "${input.targetWindow.processName}" window ("${input.targetWindow.title}") — perform this task there. If focus drifts to another window, refocus it with focus_window(processName:"${input.targetWindow.processName}") rather than opening new apps, tabs, or tools.\n\n`
      : '';
    const initialBlocks: LLMUserBlock[] = [
      {
        type: 'text',
        text: `${handoffPreamble}${windowAnchor}TASK: ${input.task}${dpiNote}\n\nACCESSIBILITY SNAPSHOT:\n${wrapUntrustedScreenContent(snapshotText)}\n\nPICK ONE TOOL CALL.`,
      },
    ];
    if (input.priorHandoff) log.info('agent.handoff.received', { mode: input.mode, chars: input.priorHandoff.length });
    if (input.targetWindow) log.info('agent.window_anchor', { mode: input.mode, window: input.targetWindow.title, process: input.targetWindow.processName });

    if (input.mode === 'vision') {
      const shot = await deps.adapter.screenshot({ maxWidth: 1280 });
      screenshotsCaptured.n += 1;
      initialBlocks.push({ type: 'text', text: '\nINITIAL SCREENSHOT:' });
      initialBlocks.push(shotToBlock(shot));
    }

    history.push({ role: 'user', content: initialBlocks });

    // Reflector hint (PR9): if the pipeline is retrying this task after a
    // verifier rejection, inject the previous rung's failure summary as a
    // synthetic `tool_result` so the planner sees why the last attempt failed.
    // This is a synthetic message — there is no real preceding tool_use block,
    // so we use a sentinel id. The model treats it as an informational result.
    if (input.reflectorHint) {
      const REFLECTOR_TOOL_ID = 'reflector_feedback_0';
      // The Anthropic contract requires an assistant turn with a tool_use
      // block before a tool_result. We insert a minimal assistant turn so the
      // history stays well-formed.
      history.push({
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: REFLECTOR_TOOL_ID,
          name: 'read_screen',
          input: {},
        }],
      } as LLMToolTurn);
      history.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: REFLECTOR_TOOL_ID,
          content: [{ type: 'text', text: `[REFLECTOR] Previous attempt failed: ${input.reflectorHint}` }],
          is_error: false,
        }],
      } as LLMToolTurn);
      log.info('agent.reflector.hint_injected', { hint: input.reflectorHint });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn('agent.perception.initial.failed', { error: msg });
    return earlyExit('cannot_read', `initial perception failed: ${msg}`, startedAt);
  }

  // ─── Main turn loop ─────────────────────────────────────────
  const outerSpan = beginSpan();
  try {
    for (let turn = 1; turn <= maxTurns; turn++) {
      if (isAborted()) return finish('aborted', 'aborted by user', steps, llmCalls, screenshotsCaptured.n, startedAt);

      log.info(EVENTS.AGENT_TURN_START, { turn, mode: input.mode, historyTurns: history.length });
      const turnStart = Date.now();

      // 1. Call the LLM with tools. Retry TRANSIENT failures (overload, rate
      //    limit, timeout, 5xx, dropped socket) with exponential backoff — a
      //    single API blip must not throw away a long multi-step run (a live
      //    14-challenge run died at turn 45 to one transient error after
      //    completing 10 steps). Non-transient errors (bad request, auth) fail
      //    fast — retrying them is pointless.
      let llmResult: ToolUseResult;
      {
        const LLM_MAX_ATTEMPTS = 4;
        let attempt = 0;
        for (;;) {
          attempt += 1;
          try {
            llmResult = await callLLMWithTools({
              baseUrl: llmConfig.baseUrl,
              model: llmConfig.model,
              apiKey: llmConfig.apiKey,
              isAnthropic: llmConfig.isAnthropic,
              system: systemPrompt,
              tools: llmTools,
              messages: history,
              maxTokens: llmConfig.maxTokens ?? 1024,
              timeoutMs: 45_000,
              // Pipeline-driven batching: force a `batch` on turn 1 so the model
              // plans the deterministic stretch up front instead of defaulting
              // to one call per turn. Only when batch is actually in this rung's
              // palette; auto thereafter (re-planning / done).
              toolChoice: (turn === 1 && input.forceBatchFirst && tools.some(t => t.name === 'batch'))
                ? { name: 'batch' }
                : 'auto',
            });
            llmCalls += 1;
            break;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const transient = /\b(timeout|timed out|429|rate.?limit|overload|529|50[0-4]|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network|fetch failed)\b/i.test(msg);
            if (attempt < LLM_MAX_ATTEMPTS && transient) {
              const backoffMs = 800 * 2 ** (attempt - 1); // 0.8s, 1.6s, 3.2s
              log.warn('agent.llm.retry', { turn, attempt, error: truncate(msg, 120), backoffMs });
              await new Promise(r => setTimeout(r, backoffMs));
              continue;
            }
            log.error('agent.llm.failed', { turn, attempt, error: msg });
            return finish('llm_error', `LLM call failed after ${attempt} attempt(s): ${msg}`, steps, llmCalls, screenshotsCaptured.n, startedAt);
          }
        }
      }

      // 2. Log the agent's thinking, if any.
      if (llmResult.text && llmResult.text.trim()) {
        log.info(EVENTS.AGENT_THINK, { turn, text: truncate(llmResult.text.trim(), 160) });
      }

      // 3. Record the assistant turn in history so the next turn sees it.
      //    SAFETY: when the model hit max_tokens with no parseable tool
      //    call, the content is almost certainly degenerate (token-loop
      //    garbage). Feeding it back as assistant context just feeds the
      //    loop. Replace with a short placeholder in that case.
      const looksDegenerate =
        llmResult.toolCalls.length === 0
        && llmResult.stopReason === 'length'
        && llmResult.text.length > 200;
      if (looksDegenerate) {
        history.push({
          role: 'assistant',
          content: [{ type: 'text', text: '(previous response exceeded token limit and produced no tool call)' }],
        });
      } else {
        history.push({ role: 'assistant', content: llmResult.raw });
      }

      // 4. No tool call → treat as parse failure (re-prompt once).
      if (llmResult.toolCalls.length === 0) {
        consecutiveNoToolCallTurns += 1;
        log.warn('agent.no_tool_call', {
          turn,
          stopReason: llmResult.stopReason,
          text: truncate(llmResult.text, 200),
          consecutive: consecutiveNoToolCallTurns,
          degenerate: looksDegenerate,
        });

        // Hard abort if the model has produced no tool call N turns in
        // a row — it's stuck in a degenerate state and won't recover.
        // Exit with 'give_up' so the pipeline ladder climbs to the
        // next rung (blind → hybrid → vision), which uses a different
        // model / prompt shape and is likely to escape the loop.
        if (consecutiveNoToolCallTurns >= NO_TOOL_CALL_LIMIT) {
          log.error('agent.no_tool_call.runaway_abort', {
            turn,
            consecutive: consecutiveNoToolCallTurns,
            hardLimit: NO_TOOL_CALL_LIMIT,
          });
          return finish(
            'give_up',
            `Model produced no parseable tool call for ${consecutiveNoToolCallTurns} consecutive turns (last stopReason="${llmResult.stopReason}"). Likely degenerate generation — aborting rung so the pipeline ladder can escalate.`,
            steps,
            llmCalls,
            screenshotsCaptured.n,
            startedAt,
          );
        }

        history.push({
          role: 'user',
          content: [{ type: 'text', text: 'You must call exactly one tool per turn. Try again with a tool call.' }],
        });
        steps.push({
          turn,
          toolName: '(no-tool)',
          toolArgs: {},
          result: { success: false, text: llmResult.text.slice(0, 200) || '(empty response)' },
          durationMs: Date.now() - turnStart,
          fingerprintChanged: false,
          thought: llmResult.text,
        });
        continue;
      }

      // Successful tool-call emission resets the runaway counter.
      consecutiveNoToolCallTurns = 0;

      // 5. Process every tool call the model emitted this turn. Most
      //    models return exactly one; if more, we process them in order
      //    and all results flow back on the next turn.
      const toolResults: Array<{ id: string; text: string; isError: boolean; screenshot?: ScreenshotResult; stop?: boolean; terminalExit?: AgentExit }> = [];
      let terminal: { exit: AgentExit; text: string } | null = null;
      // Tracks whether ANY tool in this turn was supposed to change the
      // screen. Pure-compute tools (build_uri, wait, list_windows,
      // read_screen, etc.) don't move the fingerprint by design, so they
      // must NOT count as stagnant turns. Without this, the agent's last
      // turn before dispatching a mailto URI (build_uri -> open_uri) was
      // killed by the stagnation hard-abort because build_uri is
      // changesScreen=false. The agent had the right plan and got cut off
      // one step before execution.
      let anyScreenChangingTool = false;

      for (const call of llmResult.toolCalls) {
        if (isAborted()) return finish('aborted', 'aborted by user', steps, llmCalls, screenshotsCaptured.n, startedAt);

        const tool = toolMap.get(call.name);
        if (!tool) {
          log.warn('agent.unknown_tool', { turn, tool: call.name });
          toolResults.push({
            id: call.id,
            text: `Unknown tool "${call.name}". Available: ${tools.map(t => t.name).join(', ')}`,
            isError: true,
          });
          steps.push({
            turn,
            toolName: call.name,
            toolArgs: call.args,
            result: { success: false, text: 'unknown tool' },
            durationMs: Date.now() - turnStart,
            fingerprintChanged: false,
            thought: llmResult.text,
          });
          continue;
        }

        const targetLabel = typeof call.args.name === 'string' ? call.args.name
          : typeof call.args.target === 'string' ? call.args.target
          : undefined;

        // 5a. Safety gate — single chokepoint. Pass through the user's task
        // text so the layer can detect intent-matched bypasses (when the user
        // explicitly asked for a destructive action, the confirm tier is
        // skipped — the agent isn't hallucinating a Send click out of nowhere,
        // the user typed "hit send").
        const decision = safetyEvaluate({
          tool: call.name,
          args: call.args,
          targetLabel,
          activeApp,
          userTaskText: input.task,
        });
        if (!isAllowed(decision)) {
          const reason = decision.decision === 'block'
            ? decision.reason
            : `requires ${decision.decision}: ${decision.tier}`;
          log.info('agent.tool.blocked', { turn, tool: call.name, decision: decision.decision, reason });
          toolResults.push({
            id: call.id,
            text: `[${decision.decision}] ${reason}`,
            isError: true,
          });
          steps.push({
            turn,
            toolName: call.name,
            toolArgs: call.args,
            result: { success: false, text: `safety_${decision.decision}: ${reason}` },
            durationMs: Date.now() - turnStart,
            fingerprintChanged: false,
            thought: llmResult.text,
          });
          continue;
        }

        // 5a' v0.8.3 RUNAWAY GUARD. If the agent has issued the SAME
        // tool+args combination more than REPEAT_THRESHOLD times in the
        // last REPEAT_WINDOW turns, force-exit with `give_up`. This is the
        // fix for the "Outlook keeps opening" class of bug — when the
        // agent can't see the result of its own action (sparse WebView2
        // a11y, for example) it sometimes re-issues the same action every
        // turn. Platform-level idempotency on open_app already prevents
        // duplicate Outlook windows; this guard protects against the same
        // anti-pattern generalized to every tool.
        const REPEAT_THRESHOLD = 3;
        const REPEAT_WINDOW = 6;
        const argKey = JSON.stringify(call.args ?? {});
        const recentRepeats = steps
          .slice(-REPEAT_WINDOW)
          .filter(s => s.toolName === call.name && JSON.stringify(s.toolArgs ?? {}) === argKey)
          .length;
        // Only ACTION tools (changesScreen) can "run away" — re-issuing the
        // same action because the agent can't see its result. Perception tools
        // (screenshot, read_screen, list_windows, wait — all changesScreen:false)
        // are HOW a vision agent sees a canvas that changes every challenge;
        // repeating them is mandatory, not a loop. Counting them aborted a
        // legitimately-progressing vision run mid-exam (live test 2026-05-28).
        //
        // Scroll is also exempt: traversing a long list/panel legitimately
        // repeats the SAME scroll (same x,y,direction,amount) many times — that
        // is forward progress, not a stuck loop. max_turns still caps a truly
        // endless scroll. Observed: scrolling a 60-row list to row 48 tripped
        // the guard after 3 identical scrolls and aborted the run mid-exam.
        const isScroll = call.name === 'scroll'
          || (call.name === 'mouse' && (call.args as Record<string, unknown>)?.action === 'scroll');
        if (tool.changesScreen && !isScroll && recentRepeats >= REPEAT_THRESHOLD) {
          log.warn('agent.runaway_guard', {
            turn, tool: call.name, repeats: recentRepeats, window: REPEAT_WINDOW,
          });
          steps.push({
            turn,
            toolName: call.name,
            toolArgs: call.args,
            result: {
              success: false,
              text: `runaway-guard: ${call.name} called ${recentRepeats} times in last ${REPEAT_WINDOW} turns with same args — aborting to prevent infinite loop`,
            },
            durationMs: Date.now() - turnStart,
            fingerprintChanged: false,
            thought: llmResult.text,
          });
          return finish(
            'give_up',
            `runaway-guard: repeated ${call.name} with identical args (${recentRepeats}× in last ${REPEAT_WINDOW} turns). The agent is likely unable to see whether the action succeeded — try a different approach or use detect_webview_apps + CDP bridge if the target is an Electron/WebView2 app.`,
            steps, llmCalls, screenshotsCaptured.n, startedAt,
          );
        }

        // 5a''. cannot_read soft-guard. cannot_read is meant for genuinely
        // unreadable screens (CAPTCHA, blank canvas, OCR garbage). Some models
        // — especially safety-trained text models on irreversible actions like
        // "Send" — try to use it as a "can I have a moment to think" pause AFTER
        // they already located an interactive target. That stalls the pipeline
        // for no good reason. If a perception/locator tool succeeded with REAL
        // CONTENT in the last few turns, refuse cannot_read and tell the model
        // to act on what it already found. Pattern-based; doesn't care which
        // model is asking.
        //
        // v0.9.0: tightened to check for actual content, not just "success".
        // A read_screen that returned "(empty a11y tree — app may be
        // custom-canvas)" is technically successful but has no content for the
        // model to act on — don't block cannot_read in that case.
        if (call.name === 'cannot_read') {
          const LOOKBACK = 4;
          // Resolvers split into two tiers:
          //   STRONG: action-y tools whose success means the agent actually
          //   resolved a specific target (invoke_element, set_field_value,
          //   focus_window). Pure success = real resolution.
          //   WEAK: perception tools (read_screen, screenshot, a11y_snapshot,
          //   list_windows) where success can be returned with empty content.
          //   For those we ALSO require the result text to look non-empty.
          const STRONG_RESOLVERS = new Set([
            'wait_for_element', 'find_element', 'invoke_element', 'set_field_value',
            'focus_window',
          ]);
          const WEAK_RESOLVERS = new Set([
            'read_screen', 'a11y_snapshot', 'screenshot', 'list_windows',
          ]);
          const EMPTY_TREE_HINTS = /empty a11y tree|app may be custom-canvas|\(empty\)|\(no elements found\)|no elements/i;
          const recentReal = steps.slice(-LOOKBACK).some(s => {
            if (!s.result.success) return false;
            if (STRONG_RESOLVERS.has(s.toolName)) return true;
            if (WEAK_RESOLVERS.has(s.toolName)) {
              const txt = (s.result as { text?: string }).text ?? '';
              if (!txt || txt.length < 60) return false;
              if (EMPTY_TREE_HINTS.test(txt)) return false;
              return true;
            }
            return false;
          });
          if (recentReal) {
            log.info('agent.cannot_read.suppressed', {
              turn, reason: 'recent perception or locator returned real content',
              lookback: LOOKBACK,
            });
            toolResults.push({
              id: call.id,
              text: 'cannot_read refused: a recent perception/locator tool succeeded with real content in this run, so the screen IS readable. Act on what you already located (invoke_element / mouse_click / key) instead. cannot_read is for blank/garbled screens only.',
              isError: true,
            });
            steps.push({
              turn,
              toolName: call.name,
              toolArgs: call.args,
              result: { success: false, text: 'cannot_read suppressed (perception just succeeded)' },
              durationMs: Date.now() - turnStart,
              fingerprintChanged: false,
              thought: llmResult.text,
            });
            continue;
          }
        }

        // 5a'''. BLIND-MODE RAW-COORDINATE-CLICK GUARD.
        //
        // Failure mode (BUG-D): in blind mode the LLM sometimes can't locate
        // a target in the a11y snapshot and, instead of emitting `cannot_read`,
        // starts random-clicking at guessed coordinates like click(1280,800).
        // In a live run, this advanced an exam-test UI from the landing screen
        // through several screens — real user-visible state damage — before
        // the verifier even ran. The verifier alone (confidence threshold) is
        // not a sufficient safety net because a more confident model could
        // produce false-positive success.
        //
        // The guard: in blind mode, refuse `click(x, y)` unless an a11y-aware
        // selector tool (invoke_element / set_field_value / focus_element /
        // a11y_select / a11y_toggle / a11y_expand / a11y_collapse /
        // wait_for_element) SUCCEEDED in the last A11Y_RECENCY turns. That
        // tight window covers the legitimate "I just located the element by
        // a11y; coord-click as fallback" pattern while rejecting guesses.
        //
        // Refusal consumes one turn (the runaway-guard above caps infinite
        // retries) and routes the agent to either call `cannot_read` (the
        // explicit blind→vision escape) or use an a11y-aware variant first.
        // Refusal is NOT a tool success — it surfaces as an error in
        // tool_result so the verifier won't read it as evidence of progress.
        if (call.name === 'click' && input.mode === 'blind') {
          const A11Y_RECENCY = 2; // last N step entries
          const A11Y_RESOLVERS = new Set([
            'invoke_element', 'set_field_value', 'focus_element',
            'a11y_select', 'a11y_toggle', 'a11y_expand', 'a11y_collapse',
            'wait_for_element', 'find_element',
          ]);
          const recentA11y = steps.slice(-A11Y_RECENCY).some(s =>
            A11Y_RESOLVERS.has(s.toolName) && s.result.success,
          );
          if (!recentA11y) {
            log.warn('agent.blind_coord_click.refused', {
              turn,
              args: compactArgs(call.args),
              reason: 'no recent successful a11y selection',
              recency: A11Y_RECENCY,
            });
            toolResults.push({
              id: call.id,
              text: 'raw coordinate click rejected in blind mode: no a11y element was selected in the last 2 turns, so (x,y) is a guess. Either (a) call invoke_element / focus_element / set_field_value with the element\'s a11y name from the snapshot, or (b) emit cannot_read to escalate to vision and get pixel evidence first. Guessing coordinates from a text snapshot can navigate the app to an unintended state.',
              isError: true,
            });
            steps.push({
              turn,
              toolName: call.name,
              toolArgs: call.args,
              result: { success: false, text: 'blind-mode coord-click refused (no recent a11y selection)' },
              durationMs: Date.now() - turnStart,
              fingerprintChanged: false,
              thought: llmResult.text,
            });
            continue;
          }
        }

        // 5b. Log and execute.
        log.info(EVENTS.AGENT_TOOL_CALL, { turn, tool: call.name, args: compactArgs(call.args) });
        const toolStart = Date.now();
        const ctx: AgentToolContext = {
          platform: deps.adapter,
          task: input.task,
          mode: input.mode,
          screen,
          screenshotsCaptured,
          activeApp,
          targetWindow: input.targetWindow,
          cdp: deps.cdp ?? null,
        };

        let result: Awaited<ReturnType<UnifiedTool['execute']>>;
        try {
          result = await tool.execute(call.args, ctx);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          result = { success: false, text: `tool threw: ${msg}` };
        }

        const toolMs = Date.now() - toolStart;
        log.info(EVENTS.AGENT_TOOL_RESULT, {
          turn,
          tool: call.name,
          success: result.success,
          ms: toolMs,
          // 200 (was 120) so the click/drag coordinate-space + focus breadcrumb
          // survives — that line is what makes wrong-window clicks diagnosable.
          text: truncate(result.text, 200),
        });

        // 5c. Re-capture perception if the tool changed the screen. We do
        // this AFTER the tool, BEFORE stagnation detection.
        let postSnapshot: Awaited<ReturnType<typeof captureSnapshot>> | null = null;
        if (tool.changesScreen) {
          anyScreenChangingTool = true;
          try {
            postSnapshot = await captureSnapshot(deps.adapter);
            activeApp = postSnapshot.activeWindow?.processName ?? activeApp;
          } catch {
            postSnapshot = null;
          }
        }

        const fingerprintChanged = postSnapshot ? fph.getHistory().slice(-1)[0] !== postSnapshot.fingerprint : false;
        if (postSnapshot) fph.push(postSnapshot.fingerprint);

        steps.push({
          turn,
          toolName: call.name,
          toolArgs: call.args,
          result: { success: result.success, text: result.text },
          durationMs: toolMs,
          fingerprintChanged,
          thought: llmResult.text,
        });

        toolResults.push({
          id: call.id,
          text: result.text,
          isError: !result.success,
          screenshot: result.screenshot,
          stop: result.stop,
          terminalExit: result.terminalExit,
        });

        // Terminal action → wrap up after this turn.
        if (result.stop && result.terminalExit) {
          terminal = { exit: result.terminalExit, text: result.text };
          break;
        }
      }

      // 6. Build next-turn user payload: tool_result blocks + fresh
      //    perception + (for hybrid/vision) optional screenshot of the
      //    post-action state.
      const nextBlocks: LLMUserBlock[] = [];

      // 6a. tool_result blocks preserve the Anthropic contract and feed
      //     OpenAI's `tool` messages when we normalize in llm-client.
      for (const tr of toolResults) {
        const content: Array<{ type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }> = [
          { type: 'text', text: tr.text },
        ];
        if (tr.screenshot && (input.mode === 'hybrid' || input.mode === 'vision')) {
          content.push(shotToInnerBlock(tr.screenshot));
        }
        nextBlocks.push({ type: 'tool_result', tool_use_id: tr.id, content, is_error: tr.isError });
      }

      // 6b. If any tool changed the screen, append a fresh snapshot for
      //     the next turn. This is the "per-turn refresh" the old
      //     vision-agent lacked.
      const anyChanged = toolResults.some(r => !!r.screenshot) || steps[steps.length - 1]?.fingerprintChanged;
      if (anyChanged || toolResults.length > 0) {
        try {
          const snap = await captureSnapshot(deps.adapter);
          activeApp = snap.activeWindow?.processName ?? activeApp;
          const snapText = renderSnapshot(snap, {
            screenWidth: screen.physicalWidth,
            screenHeight: screen.physicalHeight,
            focusProcessId: snap.activeWindow?.processId,
          });
          nextBlocks.push({
            type: 'text',
            text: `\nFRESH ACCESSIBILITY SNAPSHOT:\n${wrapUntrustedScreenContent(snapText)}`,
          });
          nextBlocks.push({
            type: 'text',
            text: `\nRECENT ACTIONS:\n${renderHistory(steps, 6)}`,
          });
        } catch {
          nextBlocks.push({
            type: 'text',
            text: '\n(perception refresh failed — rely on tool results above)',
          });
        }
      }

      // 6c. Stagnation check — two-stage:
      //
      //  Stage 1 (warn): the last STAGNATION_WINDOW (3) fingerprints are
      //    identical. Tell the agent to change approach — most of the time
      //    a single nudge is enough and we trust it to recover.
      //
      //  Stage 2 (abort): stagnation has fired for STAGNATION_HARD_LIMIT
      //    consecutive turns. The agent is stuck — abort the rung with
      //    `exit: 'stagnation'` so the pipeline ladder climbs to hybrid
      //    or vision. Without this, the agent kept tying actions to a
      //    stale screen until max_turns and then fabricated `done()`
      //    evidence ("the email should have been sent...").
      //
      //  The counter is reset to 0 every turn the fingerprint moves, so
      //  legitimate stagnant patches (slow window opening, transient a11y
      //  hiccup) don't trip the hard limit.
      // Stagnation is only meaningful for turns where the agent *tried* to
      // change the screen. Pure-compute tools (build_uri, wait, list_windows,
      // read_screen, screenshot, ...) legitimately leave the fingerprint
      // unchanged and must not be counted as stale. The previous behavior
      // killed the Outlook send-email run mid-plan: the agent had called
      // build_uri to construct a mailto URI and was one turn away from
      // dispatching it via open_uri when the stagnation hard-abort fired.
      const stagnant = fph.isStagnant(STAGNATION_WINDOW);
      // The a11y fingerprint only drives stagnation in BLIND mode. In vision
      // and hybrid modes the agent perceives via SCREENSHOTS, and the a11y
      // fingerprint is an unreliable progress signal: on a canvas / custom-
      // rendered app (or inside a browser, where the a11y tree is the static
      // chrome) it stays CONSTANT while the screen advances every action.
      // Counting it falsely aborted a legitimately-progressing vision run
      // mid-exam — the agent itself logged "the a11y fingerprint isn't changing
      // but the screen IS changing" right before the hard-abort fired (live
      // test 2026-05-28). In vision/hybrid the backstops are the runaway guard
      // (repeated identical ACTIONS) and max_turns. Blind mode is unchanged:
      // a11y is its only perception channel, so stale a11y genuinely means
      // stuck (the blind stagnation regression test stays green).
      const a11yStagnationApplies = input.mode === 'blind';
      if (stagnant && anyScreenChangingTool && a11yStagnationApplies) {
        consecutiveStagnantTurns += 1;
      } else if (!stagnant) {
        consecutiveStagnantTurns = 0;
      }
      // else: neutral turn (compute-only tool, or a screenshot-driven mode
      // where the a11y fingerprint is not a valid stuck signal) — leave the
      // counter alone.

      if (consecutiveStagnantTurns >= STAGNATION_HARD_LIMIT) {
        log.warn(EVENTS.AGENT_STAGNATION, {
          turn,
          window: STAGNATION_WINDOW,
          consecutiveStagnantTurns,
          hardLimit: STAGNATION_HARD_LIMIT,
          aborting: true,
          fingerprint: fph.getHistory().slice(-1)[0],
        });
        return finish(
          'stagnation',
          `aborted: ${consecutiveStagnantTurns} consecutive turns with no screen change — escalating strategy`,
          steps, llmCalls, screenshotsCaptured.n, startedAt,
        );
      }

      if (stagnant && a11yStagnationApplies) {
        log.warn(EVENTS.AGENT_STAGNATION, {
          turn,
          window: STAGNATION_WINDOW,
          consecutiveStagnantTurns,
          fingerprint: fph.getHistory().slice(-1)[0],
        });
        nextBlocks.push({
          type: 'text',
          text: `\n⚠ STAGNATION (${consecutiveStagnantTurns}/${STAGNATION_HARD_LIMIT}): the last ${STAGNATION_WINDOW} actions did not change the screen. Try a DIFFERENT approach (keyboard shortcut, different target, wait, list_windows to check focus) or give_up with a reason. Two more stagnant turns and this rung will abort and escalate.`,
        });
      }

      history.push({ role: 'user', content: nextBlocks });

      // 7. Trim old screenshots to stay under the token budget.
      trimOldScreenshots(history, MAX_HISTORY_SCREENSHOTS);

      const turnMs = Date.now() - turnStart;
      log.info(EVENTS.AGENT_TURN_END, {
        turn,
        ms: turnMs,
        tools: toolResults.length,
        changed: !!anyChanged,
      });

      if (terminal) {
        return finish(terminal.exit, terminal.text, steps, llmCalls, screenshotsCaptured.n, startedAt);
      }
    }
  } finally {
    outerSpan.end();
  }

  return finish('max_turns', `hit max turns (${maxTurns}) without a terminal action`, steps, llmCalls, screenshotsCaptured.n, startedAt);
}

// ─── Helpers ────────────────────────────────────────────────────────

function selectLlmConfig(mode: AgentMode, llm: AgentLlmDeps): AgentLlmConfig | undefined {
  if (mode === 'vision') return llm.vision;
  // blind/hybrid: prefer text, fall back to vision if text isn't there
  // (vision models can still drive tool_use without images).
  return llm.text || llm.vision;
}

function buildSystemPromptWithGuide(input: AgentInput): string {
  const base = buildSystemPrompt(input.mode);
  if (!input.guide) return base;
  return `${base}\n\n--- APP KNOWLEDGE (from bundled guide / user override) ---\n${input.guide.promptFragment}`;
}

function toUnifiedLLMTools(tools: UnifiedTool[]): LLMTool[] {
  return tools.map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

function compactArgs(args: Record<string, unknown>): Record<string, unknown> {
  // Deep-safe compact — strings over 60 chars are truncated for logs.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string' && v.length > 60) out[k] = v.slice(0, 57) + '…';
    else out[k] = v;
  }
  return out;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function shotToBlock(shot: ScreenshotResult): LLMUserBlock {
  return {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: shot.buffer.toString('base64') },
  };
}

function shotToInnerBlock(shot: ScreenshotResult): { type: 'image'; source: { type: 'base64'; media_type: string; data: string } } {
  return {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: shot.buffer.toString('base64') },
  };
}

/**
 * Remove image content from all but the most recent N user turns. Keeps
 * the agent in budget when many screenshots accumulate.
 */
function trimOldScreenshots(history: LLMToolTurn[], keepLast: number): void {
  const imageTurnIndices: number[] = [];
  history.forEach((turn, i) => {
    if (Array.isArray(turn.content)) {
      const hasImage = (turn.content as any[]).some(
        b => b.type === 'image' || b.type === 'image_url' ||
             (b.type === 'tool_result' && Array.isArray(b.content) && b.content.some((c: any) => c.type === 'image')),
      );
      if (hasImage) imageTurnIndices.push(i);
    }
  });

  if (imageTurnIndices.length <= keepLast) return;

  const dropSet = new Set(imageTurnIndices.slice(0, imageTurnIndices.length - keepLast));
  for (const i of dropSet) {
    const turn = history[i];
    if (!Array.isArray(turn.content)) continue;
    turn.content = (turn.content as any[]).map(b => {
      if (b.type === 'image' || b.type === 'image_url') {
        return { type: 'text', text: '[earlier screenshot removed to save tokens]' };
      }
      if (b.type === 'tool_result' && Array.isArray(b.content)) {
        b.content = b.content.map((c: any) =>
          c.type === 'image' ? { type: 'text', text: '[earlier tool screenshot removed]' } : c,
        );
        return b;
      }
      return b;
    }) as any;
  }
}

function finish(
  exit: AgentExit,
  text: string,
  steps: AgentStep[],
  llmCalls: number,
  screenshotsCaptured: number,
  startedAt: number,
): AgentResult {
  return {
    success: exit === 'done',
    exit,
    text,
    steps,
    llmCalls,
    screenshotsCaptured,
    durationMs: Date.now() - startedAt,
  };
}

function earlyExit(exit: AgentExit, text: string, startedAt: number): AgentResult {
  return {
    success: exit === 'done',
    exit,
    text,
    steps: [],
    llmCalls: 0,
    screenshotsCaptured: 0,
    durationMs: Date.now() - startedAt,
  };
}
