/**
 * Regression tests for the chain-abort gate's failure-category routing.
 *
 * Bug history: when the hybrid rung's LLM call timed out (real live-test
 * scenario: `agent.llm.failed("operation aborted due to timeout")`), the
 * ladder collapsed with `failureReason: 'aborted'` and never tried the
 * vision rung — even though vision was configured and available. This
 * made vision dead code on slow networks.
 *
 * Root cause: the chain-abort gate matched a stringly-typed
 * `failureReason === 'aborted'` for user-initiated cancellation, but
 * rung-internal LLM-call timeouts surfaced labels that downstream code
 * could conflate with that string. The fix introduces a structured
 * `RungFailureCategory` and routes the gate off the category instead of
 * the legacy string.
 *
 * These four tests pin the new contract:
 *   1. blind throws LLMError("timeout") → ladder climbs to hybrid.
 *   2. hybrid throws LLMError("timeout") → ladder climbs to vision.
 *   3. AbortSignal-driven user abort → chain hard-aborts (preserved).
 *   4. vision throws LLMError (no rung above) → graceful failure whose
 *      final verdict reports the error class, NOT "aborted".
 */

import { describe, it, expect, vi } from 'vitest';
import { Pipeline, categorizeFailureReason } from '../core/pipeline';
import type { PlatformAdapter, WindowInfo, ScreenshotResult } from '../platform/types';

// ─── Mock helpers (mirroring pipeline-verifier.test.ts) ─────────────

function emptyShot(): ScreenshotResult {
  return { buffer: Buffer.alloc(0), width: 0, height: 0, scaleFactor: 1 };
}

function makeAdapter(): PlatformAdapter {
  return {
    platform: 'win32',
    init: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
    checkPermissions: () => Promise.resolve({ input: true, accessibility: true, screenRecording: true }),
    requestPermissions: () => Promise.resolve({ input: true, accessibility: true, screenRecording: true }),
    getScreenSize: () => Promise.resolve({ physicalWidth: 1920, physicalHeight: 1080, logicalWidth: 1920, logicalHeight: 1080, dpiRatio: 1 }),
    screenshot: () => Promise.resolve(emptyShot()),
    screenshotRegion: () => Promise.resolve(emptyShot()),
    listWindows: () => Promise.resolve<WindowInfo[]>([]),
    getActiveWindow: () => Promise.resolve(null),
    focusWindow: () => Promise.resolve(true),
    maximizeWindow: () => Promise.resolve(),
    getUiTree: () => Promise.resolve([]),
    findElements: () => Promise.resolve([]),
    getFocusedElement: () => Promise.resolve(null),
    invokeElement: () => Promise.resolve({ success: true }),
    mouseClick: () => Promise.resolve(),
    mouseMove: () => Promise.resolve(),
    mouseDrag: () => Promise.resolve(),
    mouseScroll: () => Promise.resolve(),
    typeText: () => Promise.resolve(),
    keyPress: () => Promise.resolve(),
    readClipboard: () => Promise.resolve(''),
    writeClipboard: () => Promise.resolve(),
    openApp: () => Promise.resolve({}),
    launchApp: () => Promise.resolve({}),
  } as unknown as PlatformAdapter;
}

// Per-mode behaviour for the stubbed runAgent. The pipeline reads the
// agent's `exit` and maps it through `runUnifiedAgent` → categorised
// StrategyResult.
type StubAgentOutcome =
  | { kind: 'done' }
  | { kind: 'llm_error'; message: string }
  | { kind: 'aborted' };

const agentOutcomeByMode = new Map<string, StubAgentOutcome>();

vi.mock('../core/agent-loop/agent', () => ({
  runAgent: vi.fn(async (input: { task: string; mode: string }) => {
    const o = agentOutcomeByMode.get(input.mode) ?? { kind: 'llm_error', message: 'no outcome configured' };
    if (o.kind === 'done') {
      return {
        success: true,
        text: `done: ${input.mode}`,
        exit: 'done' as const,
        steps: [],
        llmCalls: 0,
        screenshotsCaptured: 0,
        durationMs: 5,
      };
    }
    if (o.kind === 'aborted') {
      return {
        success: false,
        text: 'aborted by user',
        exit: 'aborted' as const,
        steps: [],
        llmCalls: 0,
        screenshotsCaptured: 0,
        durationMs: 5,
      };
    }
    // llm_error — matches the agent.ts catch around callLLMWithTools when
    // AbortSignal.timeout fires inside fetch.
    return {
      success: false,
      text: `LLM call failed: ${o.message}`,
      exit: 'llm_error' as const,
      steps: [],
      llmCalls: 0,
      screenshotsCaptured: 0,
      durationMs: 5,
    };
  }),
}));

// Force the blind→hybrid→vision ladder regardless of task content.
vi.mock('../core/preprocessor/preprocessor', () => ({
  preprocess: () => ({
    strategy: 'blind' as const,
    subtasks: [],
    hints: { reason: 'test', appKey: undefined, capability: undefined, guide: undefined },
  }),
}));

function makePipeline(opts: { maxEscalations?: number } = {}) {
  return new Pipeline({
    adapter: makeAdapter(),
    llm: {
      text: { baseUrl: 'x', model: 'm', apiKey: 'k', isAnthropic: false },
      vision: { baseUrl: 'x', model: 'v', apiKey: 'k', isAnthropic: false },
    },
    // Disable the verifier; this suite is about LLM-error vs user-abort,
    // not about verifier demotion. The verifier is covered in its own
    // suite (pipeline-verifier.test.ts).
    disableVerifier: true,
    ...(opts.maxEscalations ? { maxEscalations: opts.maxEscalations } : {}),
  });
}

describe('Pipeline chain-abort gate routes off failure category, not string label', () => {
  it('Test 1: blind throws LLMError(timeout) → ladder climbs to hybrid, NOT abort', async () => {
    agentOutcomeByMode.clear();
    agentOutcomeByMode.set('blind', { kind: 'llm_error', message: 'operation aborted due to timeout' });
    agentOutcomeByMode.set('hybrid', { kind: 'done' });
    agentOutcomeByMode.set('vision', { kind: 'done' });

    const { runAgent } = await import('../core/agent-loop/agent');
    (runAgent as unknown as { mockClear: () => void }).mockClear();

    const pipeline = makePipeline();
    const result = await pipeline.run({ task: 'open notepad and type hello' });

    // Hybrid was tried after blind's timeout.
    const calls = (runAgent as unknown as { mock: { calls: any[][] } }).mock.calls;
    const modesCalled = calls.map(c => c[0].mode);
    expect(modesCalled).toContain('blind');
    expect(modesCalled).toContain('hybrid');
    // Pipeline succeeded on hybrid; vision wasn't needed.
    expect(result.success).toBe(true);
  });

  it('Test 2: hybrid throws LLMError(timeout) → ladder climbs to vision, NOT abort', async () => {
    // The live-test scenario: blind already failed (e.g. give_up), hybrid's
    // LLM call timed out, and the previous code surfaced the timeout as
    // `failureReason: 'aborted'` and collapsed the ladder before vision ran.
    agentOutcomeByMode.clear();
    agentOutcomeByMode.set('blind', { kind: 'llm_error', message: 'connection refused' });
    agentOutcomeByMode.set('hybrid', { kind: 'llm_error', message: 'operation aborted due to timeout' });
    agentOutcomeByMode.set('vision', { kind: 'done' });

    const { runAgent } = await import('../core/agent-loop/agent');
    (runAgent as unknown as { mockClear: () => void }).mockClear();

    const pipeline = makePipeline();
    const result = await pipeline.run({ task: 'send sarah the Q2 numbers' });

    const calls = (runAgent as unknown as { mock: { calls: any[][] } }).mock.calls;
    const modesCalled = calls.map(c => c[0].mode);
    // Critical: vision MUST be reached after hybrid timeout.
    expect(modesCalled).toContain('blind');
    expect(modesCalled).toContain('hybrid');
    expect(modesCalled).toContain('vision');
    expect(result.success).toBe(true);
  });

  it('Test 3: AbortSignal-driven user abort → chain hard-aborts (existing behaviour preserved)', async () => {
    // The host (CLI / MCP / scheduler) flips its AbortController, which
    // shows up as `isAborted()` returning true. The ladder loop's top-of-
    // iteration gate MUST short-circuit with a user_abort StrategyResult,
    // and the chain-abort gate MUST then hard-abort. We want to confirm
    // BOTH that no further rungs run and that the run is reported as a
    // failure (success: false) — not a silent climb-past.
    agentOutcomeByMode.clear();
    // The agent stub also surfaces `aborted` — but the ladder loop's
    // `env.isAborted()` check should fire FIRST, before the rung even
    // runs. Either way the result must categorize as user_abort.
    agentOutcomeByMode.set('blind', { kind: 'aborted' });
    agentOutcomeByMode.set('hybrid', { kind: 'done' });
    agentOutcomeByMode.set('vision', { kind: 'done' });

    const { runAgent } = await import('../core/agent-loop/agent');
    (runAgent as unknown as { mockClear: () => void }).mockClear();

    // Host abort signal — flips true before the first rung runs.
    let aborted = true;
    const pipeline = makePipeline();
    const result = await pipeline.run({ task: 'do the thing', isAborted: () => aborted });

    // Chain hard-aborted: success is false; no rungs were even consulted
    // because the ladder loop's `isAborted()` short-circuited before
    // executing blind.
    expect(result.success).toBe(false);
    expect(result.text.toLowerCase()).toContain('abort');

    // Sanity: the ladder didn't keep climbing past the user_abort.
    const calls = (runAgent as unknown as { mock: { calls: any[][] } }).mock.calls;
    expect(calls.length).toBe(0);
    // Silence unused-var warning — `aborted` is meaningful as the signal
    // source even though we never flip it after construction here.
    expect(aborted).toBe(true);
  });

  it('Test 4: vision throws LLMError → graceful failure; verdict reports error class, not "aborted"', async () => {
    // All three rungs hit LLM errors. With the fix, the ladder climbs all
    // the way to vision; vision also fails; the result reports failure
    // (not success) but the failure label is the rung's actual error
    // (`llm_error`), NOT the chain-abort gate's `'aborted'` masking.
    agentOutcomeByMode.clear();
    agentOutcomeByMode.set('blind', { kind: 'llm_error', message: 'timeout' });
    agentOutcomeByMode.set('hybrid', { kind: 'llm_error', message: 'timeout' });
    agentOutcomeByMode.set('vision', { kind: 'llm_error', message: 'timeout' });

    const { runAgent } = await import('../core/agent-loop/agent');
    (runAgent as unknown as { mockClear: () => void }).mockClear();

    const pipeline = makePipeline();
    const result = await pipeline.run({ task: 'open paint and draw a stickman' });

    const calls = (runAgent as unknown as { mock: { calls: any[][] } }).mock.calls;
    const modesCalled = calls.map(c => c[0].mode);
    // The ladder climbed past every timeout — vision was tried.
    expect(modesCalled).toContain('blind');
    expect(modesCalled).toContain('hybrid');
    expect(modesCalled).toContain('vision');

    // Final verdict is a failure (no rung succeeded) but the user-visible
    // text reflects the actual LLM error, not a manufactured "aborted".
    expect(result.success).toBe(false);
    expect(result.text.toLowerCase()).toContain('llm');
    expect(result.text.toLowerCase()).not.toMatch(/^aborted$/);
  });
});

// ─── Pure unit tests for the category mapper ───────────────────────

describe('categorizeFailureReason — the single source of truth for the gate', () => {
  it('user-initiated abort → user_abort', () => {
    expect(categorizeFailureReason('aborted')).toBe('user_abort');
  });

  it('rung-internal LLM errors (timeout, transport, parse) → rung_llm_error', () => {
    expect(categorizeFailureReason('llm_error')).toBe('rung_llm_error');
    expect(categorizeFailureReason('parse_error')).toBe('rung_llm_error');
  });

  it('agent self-stop signals → agent_gave_up', () => {
    expect(categorizeFailureReason('max_turns')).toBe('agent_gave_up');
    expect(categorizeFailureReason('stagnation')).toBe('agent_gave_up');
    expect(categorizeFailureReason('give_up')).toBe('agent_gave_up');
    expect(categorizeFailureReason('cannot_read')).toBe('agent_gave_up');
  });

  it('verifier demotion → verifier_rejected', () => {
    expect(categorizeFailureReason('verifier_rejected')).toBe('verifier_rejected');
  });

  it('config / not-applicable rung → config_missing', () => {
    expect(categorizeFailureReason('no_text_model')).toBe('config_missing');
    expect(categorizeFailureReason('no_llm')).toBe('config_missing');
    expect(categorizeFailureReason('vision_disabled')).toBe('config_missing');
    expect(categorizeFailureReason('router_miss')).toBe('config_missing');
    expect(categorizeFailureReason('playbook_miss')).toBe('config_missing');
    expect(categorizeFailureReason('no_ladder')).toBe('config_missing');
  });

  it('anti-pattern → anti_pattern (hard-abort)', () => {
    expect(categorizeFailureReason('anti_pattern')).toBe('anti_pattern');
  });

  it('unknown / undefined → infra_error (conservative, hard-abort)', () => {
    expect(categorizeFailureReason(undefined)).toBe('infra_error');
    expect(categorizeFailureReason('something_new')).toBe('infra_error');
    expect(categorizeFailureReason('error')).toBe('infra_error');
  });
});
