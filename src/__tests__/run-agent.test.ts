/**
 * Direct unit tests for `runAgent` — the canonical agent loop.
 *
 * This file targets the loop itself, not the pipeline. Prior to v0.9.0
 * `runAgent` (728 LOC, the single most important function in the
 * codebase) had ZERO direct test coverage — exercised only incidentally
 * via pipeline integration tests. This file covers the three exits
 * that drive ladder escalation:
 *
 *   - happy path: model returns one tool call, then `done`
 *   - stagnation: a stale a11y fingerprint NUDGES, never aborts (v1.0.0
 *                 removed the rung it used to escalate to)
 *   - no-tool-call loop: NO_TOOL_CALL_LIMIT consecutive turns where the
 *                        model produces text but no parseable tool
 *                        call → `exit: 'give_up'`
 *
 * Strategy: mock `callLLMWithTools` so we control exactly what the
 * model "returns" each turn. Adapter is a minimal stub — the loop's
 * tool-call dispatch is what we're testing, not adapter behavior.
 *
 * OS/model/app-agnostic by construction: nothing here references a
 * specific platform, provider, or application.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PlatformAdapter, WindowInfo, ScreenshotResult } from '../platform/types';
import type { ToolUseResult, LLMAssistantBlock } from '../llm/client';

// Mock callLLMWithTools BEFORE importing runAgent so the loop binds to
// the mock. Each test pushes turn-by-turn behavior into `llmTurnQueue`.
const llmTurnQueue: ToolUseResult[] = [];
const capturedLlmCalls: any[] = [];
vi.mock('../llm/client', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../llm/client')>();
  return {
    ...orig,
    callLLMWithTools: vi.fn(async (opts?: any): Promise<ToolUseResult> => {
      capturedLlmCalls.push(opts);
      const next = llmTurnQueue.shift();
      // A queued Error simulates an LLM-call failure for that turn (used to
      // test transient-error retry vs fatal-error abort).
      if (next instanceof Error) throw next;
      if (!next) {
        // Defensive: a runaway test would otherwise loop forever. Returning
        // an empty turn here lets the loop's NO_TOOL_CALL_LIMIT trip
        // naturally so the test fails loudly instead of hanging.
        return { text: '', toolCalls: [], stopReason: 'end_turn', raw: [] };
      }
      return next;
    }),
  };
});

import { runAgent } from '../core/agent-loop/agent';

// ─── Helpers ────────────────────────────────────────────────────────

const emptyShot = (): ScreenshotResult => ({
  buffer: Buffer.alloc(0),
  width: 1920,
  height: 1080,
  scaleFactor: 1,
});

/**
 * Adapter stub that returns deterministic, stable values turn over turn.
 * Same fingerprint inputs (windows + active window + focused element)
 * each call → fingerprint never changes → stagnation fires naturally
 * after STAGNATION_WINDOW turns of "no tool that changed the screen."
 */
function makeAdapter(): PlatformAdapter {
  return {
    platform: 'win32',
    init: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    checkPermissions: vi.fn(async () => ({ input: true, accessibility: true, screenRecording: true })),
    requestPermissions: vi.fn(async () => ({ input: true, accessibility: true, screenRecording: true })),
    getScreenSize: vi.fn(async () => ({
      logicalWidth: 1920, logicalHeight: 1080,
      physicalWidth: 1920, physicalHeight: 1080,
      dpiRatio: 1,
    })),
    screenshot: vi.fn(async () => emptyShot()),
    screenshotRegion: vi.fn(async () => emptyShot()),
    listWindows: vi.fn(async (): Promise<WindowInfo[]> => [
      { processId: 100, processName: 'notepad', title: 'Untitled - Notepad', bounds: { x: 0, y: 0, width: 800, height: 600 }, isMinimized: false },
    ]),
    getActiveWindow: vi.fn(async () => ({
      processId: 100, processName: 'notepad', title: 'Untitled - Notepad',
      bounds: { x: 0, y: 0, width: 800, height: 600 }, isMinimized: false,
    })),
    focusWindow: vi.fn(async () => true),
    maximizeWindow: vi.fn(async () => {}),
    minimizeWindow: vi.fn(async () => {}),
    restoreWindow: vi.fn(async () => {}),
    closeWindow: vi.fn(async () => {}),
    resizeWindow: vi.fn(async () => {}),
    listDisplays: vi.fn(async () => [{ id: 0, primary: true, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }]),
    getUiTree: vi.fn(async () => []),
    findElements: vi.fn(async () => []),
    getFocusedElement: vi.fn(async () => null),
    invokeElement: vi.fn(async () => ({ success: true })),
    mouseClick: vi.fn(async () => {}),
    mouseMove: vi.fn(async () => {}),
    mouseDrag: vi.fn(async () => {}),
    mouseScroll: vi.fn(async () => {}),
    typeText: vi.fn(async () => {}),
    keyPress: vi.fn(async () => {}),
    readClipboard: vi.fn(async () => ''),
    writeClipboard: vi.fn(async () => {}),
    openApp: vi.fn(async () => ({})),
    launchApp: vi.fn(async () => ({})),
    cdpDriver: undefined,
  } as unknown as PlatformAdapter;
}

/** Convenience: build an LLM turn that requests a single tool call. */
function turnCall(name: string, args: Record<string, unknown> = {}): ToolUseResult {
  const id = `c_${Math.random().toString(36).slice(2, 8)}`;
  const raw: LLMAssistantBlock[] = [
    { type: 'tool_use', id, name, input: args },
  ];
  return {
    text: '',
    toolCalls: [{ id, name, args }],
    stopReason: 'tool_use',
    raw,
  };
}

/** Convenience: build an LLM turn that produces text but NO tool call. */
function turnNoCall(text = 'thinking...'): ToolUseResult {
  return {
    text,
    toolCalls: [],
    stopReason: 'end_turn',
    raw: [{ type: 'text', text }],
  };
}

const LLM_CONFIG = {
  text: { baseUrl: 'http://stub', model: 'stub-text', apiKey: 'k', isAnthropic: false },
};

// Vision mode requires a vision config; reuse the same stub for both.
const VISION_CONFIG = {
  text: { baseUrl: 'http://stub', model: 'stub-text', apiKey: 'k', isAnthropic: false },
  vision: { baseUrl: 'http://stub', model: 'stub-vision', apiKey: 'k', isAnthropic: false },
};

// ─── Tests ──────────────────────────────────────────────────────────

describe('runAgent — happy path', () => {
  beforeEach(() => {
    llmTurnQueue.length = 0;
  });

  it('completes a task with one action and a done() call → exit:"done", success:true', async () => {
    // Turn 1: read the screen (a real tool in the blind catalog).
    // Turn 2: declare done with evidence.
    llmTurnQueue.push(turnCall('read_screen'));
    llmTurnQueue.push(turnCall('done', { evidence: 'screen shows the expected content' }));

    const result = await runAgent(
      { task: 'orient and finish', maxTurns: 10 },
      { adapter: makeAdapter(), llm: LLM_CONFIG },
    );

    expect(result.exit).toBe('done');
    expect(result.success).toBe(true);
    expect(result.steps.length).toBe(2);
    expect(result.steps[1].toolName).toBe('done');
    expect(result.llmCalls).toBe(2);
  });
});

describe('runAgent — stagnation is a nudge, not an abort', () => {
  beforeEach(() => {
    llmTurnQueue.length = 0;
  });

  it('does NOT abort when the a11y fingerprint stays stale across many turns (v1.0.0 removed the rung to escalate to)', async () => {
    // Every turn: key_press with a UNIQUE key value. Two properties matter:
    //   1. Unique args each turn keeps the runaway guard (which counts
    //      identical-args repeats in the last 6 turns) below threshold.
    //   2. key_press is `changesScreen:true` so the loop re-snapshots
    //      post-action. The adapter stub returns IDENTICAL screen state every
    //      call, so the a11y fingerprint never moves and `isStagnant` keeps
    //      firing well past STAGNATION_HARD_LIMIT (5).
    //
    // Pre-v1.0.0 this hard-aborted with exit:'stagnation' to climb the
    // pipeline ladder — but v1.0.0 deleted the ladder, and the a11y
    // fingerprint is blind to sparse-a11y form apps (new Outlook) that are
    // really progressing, so the abort killed winnable runs. Post-fix:
    // stagnation only NUDGES; the agent keeps every turn and reaches done().
    const keys = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10'];
    for (const key of keys) llmTurnQueue.push(turnCall('key', { key }));
    llmTurnQueue.push(turnCall('done', { evidence: 'completed the sequence' }));

    const result = await runAgent(
      { task: 'long stagnant-but-progressing sequence', maxTurns: 20 },
      { adapter: makeAdapter(), llm: LLM_CONFIG },
    );

    // 10 stale-fingerprint turns (2× the old hard-abort limit) must NOT abort.
    expect(result.exit).toBe('done');
    expect(result.success).toBe(true);
    expect(result.steps.length).toBeGreaterThan(5);
  });

  it('does NOT count pure-compute tools (build_uri, list_windows) toward stagnation', async () => {
    // Regression test for the Outlook send-email run: the agent had
    // called build_uri to construct a mailto URI and was one turn away
    // from dispatching it via open_uri when the stagnation hard-abort
    // fired. build_uri is changesScreen:false — it's a pure encoder —
    // and shouldn't count as a stale-screen turn.
    //
    // Mix: changesScreen:false tools (build_uri, list_windows) sprinkled
    // between changesScreen:true ones that keep the fingerprint stable.
    // Without the fix, the false tools also count toward the stagnation
    // counter and the hard-abort fires after 5. With the fix, only the
    // changesScreen:true tools count, so we can have many more turns
    // before tripping the limit.
    const sequence: Array<{ name: string; args: Record<string, unknown> }> = [
      { name: 'build_uri',    args: { scheme: 'mailto', path: 'a@b.com' } },
      { name: 'list_windows', args: {} },
      { name: 'build_uri',    args: { scheme: 'mailto', path: 'c@d.com' } },
      { name: 'list_windows', args: {} },
      { name: 'build_uri',    args: { scheme: 'mailto', path: 'e@f.com' } },
      { name: 'list_windows', args: {} },
      { name: 'done',         args: { evidence: 'computed the URIs we needed' } },
    ];
    for (const t of sequence) llmTurnQueue.push(turnCall(t.name, t.args));

    const result = await runAgent(
      { task: 'use compute tools', maxTurns: 20 },
      { adapter: makeAdapter(), llm: LLM_CONFIG },
    );

    // The previous behavior would have aborted with exit:'stagnation'
    // after STAGNATION_HARD_LIMIT (5) of those pure-compute turns. With
    // the fix the agent reaches the done() call cleanly.
    expect(result.exit).toBe('done');
    expect(result.success).toBe(true);
  });
});

describe('runAgent — vision/canvas guards must not misfire (live-test regression 2026-05-28)', () => {
  beforeEach(() => {
    llmTurnQueue.length = 0;
  });

  it('does NOT trip the runaway guard on repeated screenshots (perception is how vision sees)', async () => {
    // A vision agent on a canvas (empty a11y) must re-screenshot to perceive
    // each new state. screenshot is changesScreen:false — repeating it is not
    // a runaway loop. Pre-fix: 3 screenshots in 6 turns → give_up. Post-fix:
    // perception tools are exempt, so the agent reaches done().
    llmTurnQueue.push(turnCall('screenshot'));
    llmTurnQueue.push(turnCall('screenshot'));
    llmTurnQueue.push(turnCall('screenshot'));
    llmTurnQueue.push(turnCall('screenshot'));
    llmTurnQueue.push(turnCall('done', { evidence: 'the event log shows the exam advanced' }));

    const result = await runAgent(
      { task: 'drive a canvas exam by vision', maxTurns: 20 },
      { adapter: makeAdapter(), llm: VISION_CONFIG },
    );

    expect(result.exit).toBe('done');
    expect(result.success).toBe(true);
  });

  it('does NOT runaway-abort on repeated identical scrolls (long-list traversal)', async () => {
    // Traversing a long list repeats the SAME scroll many times — forward
    // progress, not a loop. Pre-fix: 3 identical scrolls → runaway give_up,
    // killing the run mid-list (observed live on the 60-row scroll challenge).
    for (let i = 0; i < 6; i++) {
      llmTurnQueue.push(turnCall('mouse', { action: 'scroll', x: 630, y: 380, direction: 'down', amount: 25 }));
    }
    llmTurnQueue.push(turnCall('done', { evidence: 'the target row is now visible and selected' }));

    const result = await runAgent(
      { task: 'scroll a long list to the target', maxTurns: 20 },
      { adapter: makeAdapter(), llm: VISION_CONFIG },
    );

    expect(result.exit).toBe('done');
    expect(result.success).toBe(true);
  });

  it('does NOT stagnation-abort in vision mode when a11y is empty but the agent keeps acting (canvas progress)', async () => {
    // Empty a11y (canvas) → the a11y fingerprint never moves, but the SCREEN
    // is advancing each challenge. Clicks are changesScreen:true with DIFFERENT
    // coords (so the runaway guard stays quiet). Pre-fix: a11y-fingerprint
    // stagnation hard-aborts after 5 → exit:'stagnation' before done. Post-fix:
    // a11y stagnation is suppressed for vision+empty-a11y, so done() is reached.
    for (let i = 0; i < 8; i++) {
      llmTurnQueue.push(turnCall('mouse', { action: 'click', x: 100 + i * 30, y: 200 + i * 17 }));
    }
    llmTurnQueue.push(turnCall('done', { evidence: 'reached the results page' }));

    const result = await runAgent(
      { task: 'click through canvas challenges', maxTurns: 30 },
      { adapter: makeAdapter(), llm: VISION_CONFIG },
    );

    expect(result.exit).toBe('done');
    expect(result.success).toBe(true);
  });
});

describe('runAgent — transient LLM-error resilience (live-test regression 2026-05-28)', () => {
  beforeEach(() => {
    llmTurnQueue.length = 0;
  });

  it('retries a transient LLM error instead of throwing away the run', async () => {
    // A 10-of-14 live run died at turn 45 to ONE transient API error. A blip
    // must not abort a long run: retry, then continue to done().
    llmTurnQueue.push(new Error('Overloaded: upstream returned 529') as unknown as ToolUseResult);
    llmTurnQueue.push(turnCall('done', { evidence: 'screen shows the expected content' }));

    const result = await runAgent(
      { task: 'survive an API blip', maxTurns: 10 },
      { adapter: makeAdapter(), llm: LLM_CONFIG },
    );

    expect(result.exit).toBe('done');
    expect(result.success).toBe(true);
  });

  it('fails fast (no retry) on a non-transient LLM error', async () => {
    // A 400 bad-request will never succeed on retry — give up immediately.
    llmTurnQueue.push(new Error('400 invalid_request_error: bad tool schema') as unknown as ToolUseResult);
    llmTurnQueue.push(turnCall('done', { evidence: 'unreached' }));

    const result = await runAgent(
      { task: 'fatal request', maxTurns: 10 },
      { adapter: makeAdapter(), llm: LLM_CONFIG },
    );

    expect(result.exit).toBe('llm_error');
    expect(result.success).toBe(false);
  });
});

describe('runAgent — cross-rung handoff (text↔vision communication)', () => {
  beforeEach(() => {
    llmTurnQueue.length = 0;
    capturedLlmCalls.length = 0;
  });

  it('task text appears in the initial context', async () => {
    // The task description must be visible to the model in the initial message.
    llmTurnQueue.push(turnCall('done', { evidence: 'task completed' }));
    const task = 'finish sending the message via email';

    await runAgent(
      { task, maxTurns: 5 },
      { adapter: makeAdapter(), llm: VISION_CONFIG },
    );

    const firstCallMessages = JSON.stringify(capturedLlmCalls[0]?.messages ?? []);
    expect(firstCallMessages).toContain('finish sending the message');
  });

  it('task text is present without handoff prefix (no priorHandoff field any more)', async () => {
    llmTurnQueue.push(turnCall('done', { evidence: 'fresh start' }));
    await runAgent(
      { task: 'do a thing', maxTurns: 5 },
      { adapter: makeAdapter(), llm: LLM_CONFIG },
    );
    const firstCallMessages = JSON.stringify(capturedLlmCalls[0]?.messages ?? []);
    expect(firstCallMessages).not.toContain('PRIOR ATTEMPT');
  });
});

describe('runAgent — no-tool-call loop exit', () => {
  beforeEach(() => {
    llmTurnQueue.length = 0;
  });

  it('aborts with exit:"give_up" when the model emits NO_TOOL_CALL_LIMIT consecutive turns of text-only output', async () => {
    // 3 in a row should trip NO_TOOL_CALL_LIMIT and exit give_up.
    // Queue 8 to prove early termination — if the loop ran past
    // NO_TOOL_CALL_LIMIT we'd burn through all of them.
    for (let i = 0; i < 8; i++) llmTurnQueue.push(turnNoCall(`turn ${i} thinking`));

    const result = await runAgent(
      { task: 'degenerate model', maxTurns: 20 },
      { adapter: makeAdapter(), llm: LLM_CONFIG },
    );

    expect(result.exit).toBe('give_up');
    expect(result.success).toBe(false);
    // Should have stopped at NO_TOOL_CALL_LIMIT (3), well under maxTurns
    // and well under the 8 queued empty turns.
    expect(result.steps.length).toBeLessThan(8);
  });
});
