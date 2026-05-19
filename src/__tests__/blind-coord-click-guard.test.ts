/**
 * Tests for the blind-mode raw-coordinate-click guardrail (BUG-D).
 *
 * Failure mode: in blind mode (a11y-only, no screenshots) the LLM sometimes
 * can't find a target in the a11y snapshot — and instead of emitting
 * `cannot_read`, it starts random-clicking at guessed coordinates
 * (`click(1280,800)`, `click(1280,600)`, etc). In a live test run, this
 * advanced an exam-test UI from the landing screen to test #7
 * ("double-click") before timing out — actual user-visible state damage.
 *
 * The fix: in blind mode, `click(x, y)` is refused unless an a11y-aware
 * selector tool (invoke_element / set_field_value / focus_element /
 * a11y_*) SUCCEEDED in the last 2 step entries. The refusal consumes one
 * turn but is surfaced as an ERROR tool_result so the verifier never reads
 * it as evidence of progress, and the runaway-guard caps retries.
 *
 * Mode-gated: hybrid mode is unchanged (it can call screenshot to verify),
 * and `cannot_read` remains the explicit graceful give-up path.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PlatformAdapter, WindowInfo, ScreenshotResult } from '../platform/types';
import type { ToolUseResult, LLMAssistantBlock } from '../llm/client';

// Mock callLLMWithTools BEFORE importing runAgent so the loop binds to
// the mock. Each test pushes turn-by-turn behavior into `llmTurnQueue`.
const llmTurnQueue: ToolUseResult[] = [];
vi.mock('../llm/client', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../llm/client')>();
  return {
    ...orig,
    callLLMWithTools: vi.fn(async (): Promise<ToolUseResult> => {
      const next = llmTurnQueue.shift();
      if (!next) {
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

/** Adapter stub — deterministic state, never changes the fingerprint. */
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

/** Convenience: LLM turn requesting a single tool call. */
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

const LLM_CONFIG = {
  text: { baseUrl: 'http://stub', model: 'stub-text', apiKey: 'k', isAnthropic: false },
};

// ─── Tests ──────────────────────────────────────────────────────────

describe('blind-mode raw-coordinate-click guardrail', () => {
  beforeEach(() => {
    llmTurnQueue.length = 0;
  });

  // T1: blind mode + click(100,200) with no prior a11y selection → refused,
  // next turn still allowed (refusal consumes one turn, doesn't terminate).
  it('T1: refuses click(x,y) in blind mode when no a11y element was recently selected', async () => {
    // Turn 1: agent guesses a coordinate click with no prior a11y resolution.
    llmTurnQueue.push(turnCall('click', { x: 100, y: 200 }));
    // Turn 2: agent recovers by calling cannot_read (the prompted escape).
    llmTurnQueue.push(turnCall('cannot_read', { reason: 'a11y snapshot has nothing matching' }));

    const adapter = makeAdapter();
    const result = await runAgent(
      { task: 'click the button', mode: 'blind', maxTurns: 10 },
      { adapter, llm: LLM_CONFIG },
    );

    // The refused click consumed a turn (logged as step).
    expect(result.steps.length).toBeGreaterThanOrEqual(2);
    const refusedStep = result.steps[0];
    expect(refusedStep.toolName).toBe('click');
    expect(refusedStep.result.success).toBe(false);
    expect(refusedStep.result.text).toMatch(/blind.?mode coord.?click refused|coordinate click rejected/i);

    // CRITICAL: the underlying platform mouseClick was NEVER called — the
    // bug was that guessed coordinates reached the OS and damaged screen state.
    expect((adapter.mouseClick as any).mock.calls.length).toBe(0);

    // The agent's next turn was allowed (the guard doesn't terminate the rung).
    expect(result.steps[1].toolName).toBe('cannot_read');
    expect(result.exit).toBe('cannot_read');
  });

  // T2: blind mode + a11y-aware click on turn N, then click(x,y) on turn N+1
  // → ALLOWED (recent a11y selection covers the coord-click fallback).
  it('T2: allows click(x,y) in blind mode when an a11y selector succeeded recently', async () => {
    // Turn 1: invoke_element succeeds (adapter stub returns success:true).
    llmTurnQueue.push(turnCall('invoke_element', { name: 'Begin Exam' }));
    // Turn 2: coord-click fallback (e.g. a11y action didn't visibly fire).
    llmTurnQueue.push(turnCall('click', { x: 100, y: 200 }));
    // Turn 3: declare done.
    llmTurnQueue.push(turnCall('done', { evidence: 'exam landing screen replaced by test 1 prompt' }));

    const adapter = makeAdapter();
    const result = await runAgent(
      { task: 'start the exam', mode: 'blind', maxTurns: 10 },
      { adapter, llm: LLM_CONFIG },
    );

    // The click went through to the platform — proves the guard did NOT fire.
    expect((adapter.mouseClick as any).mock.calls.length).toBe(1);
    expect((adapter.mouseClick as any).mock.calls[0][0]).toBe(100);
    expect((adapter.mouseClick as any).mock.calls[0][1]).toBe(200);

    expect(result.steps[0].toolName).toBe('invoke_element');
    expect(result.steps[0].result.success).toBe(true);
    expect(result.steps[1].toolName).toBe('click');
    expect(result.steps[1].result.success).toBe(true);
    expect(result.exit).toBe('done');
  });

  // T3: hybrid mode + click(x,y) with no a11y selection → ALLOWED. The
  // guard is mode-gated; hybrid mode has screenshot as the escape hatch.
  it('T3: does NOT fire in hybrid mode', async () => {
    llmTurnQueue.push(turnCall('click', { x: 100, y: 200 }));
    llmTurnQueue.push(turnCall('done', { evidence: 'screen advanced to expected next view' }));

    const adapter = makeAdapter();
    const result = await runAgent(
      { task: 'click the button', mode: 'hybrid', maxTurns: 10 },
      { adapter, llm: LLM_CONFIG },
    );

    // In hybrid the click reaches the platform — the guard is blind-mode-only.
    expect((adapter.mouseClick as any).mock.calls.length).toBe(1);
    expect(result.steps[0].toolName).toBe('click');
    expect(result.steps[0].result.success).toBe(true);
    expect(result.exit).toBe('done');
  });

  // T4: blind mode + cannot_read → ALLOWED, marked as graceful give-up.
  // Confirms the documented escape path still works after the guard ships.
  it('T4: allows cannot_read as the graceful blind-mode give-up', async () => {
    llmTurnQueue.push(turnCall('cannot_read', { reason: 'a11y snapshot is empty' }));

    const adapter = makeAdapter();
    const result = await runAgent(
      { task: 'find and click the button', mode: 'blind', maxTurns: 10 },
      { adapter, llm: LLM_CONFIG },
    );

    expect(result.steps.length).toBe(1);
    expect(result.steps[0].toolName).toBe('cannot_read');
    expect(result.exit).toBe('cannot_read');
    // cannot_read is a terminal that does NOT call mouseClick.
    expect((adapter.mouseClick as any).mock.calls.length).toBe(0);
  });
});
