/**
 * Tests for the unified pipeline's ground-truth verifier integration.
 *
 * The pipeline used to trust `agentResult.success` directly — the agent
 * could call `done(evidence: "should have been sent")` and the pipeline
 * would return success. After the v0.8.12 wiring, every agent rung is
 * post-checked against actual screen state via a `Verifier`, and a
 * rejected verdict demotes the rung so the strategy ladder climbs.
 *
 * These tests pin that behavior down without needing a live LLM:
 *   - A mock `Verifier` injected via `PipelineDeps.verifier` controls
 *     pass / fail / throw on demand.
 *   - A mock `PlatformAdapter` + a stubbed agent loop simulate rungs
 *     without bringing up the real one.
 *
 * What we're verifying (no pun intended):
 *   1. Agent success + verifier pass     → pipeline reports success.
 *   2. Agent success + verifier reject   → ladder climbs, next rung runs.
 *   3. Verifier throws                   → adopt agent claim (no false
 *                                         negatives from infra hiccups).
 *   4. `disableVerifier: true`           → behavior matches pre-v0.8.12.
 *   5. Router-only rung                  → verifier NOT invoked
 *                                         (router has its own diff).
 */

import { describe, it, expect, vi } from 'vitest';
import { Pipeline } from '../core/pipeline';
import type { PlatformAdapter, WindowInfo, ScreenshotResult } from '../platform/types';
import type { Verifier, VerifyOptions, VerifyResult, StateSnapshot, ReflectionFeedback } from '../core/verifier-types';

// ─── Mock helpers ───────────────────────────────────────────────────

function emptyShot(): ScreenshotResult {
  return { buffer: Buffer.alloc(0), width: 0, height: 0, scaleFactor: 1 };
}

function emptyState(): StateSnapshot {
  return {
    timestamp: Date.now(),
    screenshot: emptyShot(),
    windows: [],
    activeWindow: null,
    focusedElement: null,
    ocrText: '',
    clipboard: '',
  };
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

/** Mock verifier whose verdict you control via `setVerdict`. */
function makeMockVerifier(initial: 'pass' | 'reject' | 'throw' = 'pass') {
  let verdict: 'pass' | 'reject' | 'throw' = initial;
  const verify = vi.fn(async (_opts: VerifyOptions): Promise<VerifyResult> => {
    if (verdict === 'throw') throw new Error('verifier infra hiccup');
    if (verdict === 'pass') {
      return {
        pass: true, confidence: 0.9, reason: 'Verified: pixel_diff, window_change',
        signals: [],
      };
    }
    return {
      pass: false, confidence: 0.2, reason: 'Failed: task_assertions ([send_email] compose_closed=✗ in_inbox_or_sent=✗ (0/2))',
      signals: [],
    };
  });
  const verifyWithFeedback = vi.fn(async (_opts: VerifyOptions): Promise<ReflectionFeedback> => {
    if (verdict === 'throw') throw new Error('verifier infra hiccup');
    if (verdict === 'pass') {
      return { pass: true, confidence: 0.9, causes: [], hint: 'Verification passed.' };
    }
    return {
      pass: false,
      confidence: 0.2,
      causes: [{ kind: 'no_pixel_change' }],
      hint: 'No pixel change after click — target may not have been hit.',
    };
  });
  const captureState = vi.fn(async (_ocr: string) => emptyState());
  const verifier: Verifier = { verify, verifyWithFeedback, captureState };
  return {
    verifier,
    verify,
    verifyWithFeedback,
    captureState,
    setVerdict: (v: 'pass' | 'reject' | 'throw') => { verdict = v; },
  };
}

// ─── Stub the agent loop ────────────────────────────────────────────
//
// The real `runAgent` brings up an LLM. For these tests we want to drive
// the rung's outcome directly. `vi.mock` replaces the import in the
// pipeline module's binding.

const agentResultByRung = new Map<string, { success: boolean; exit: string }>();

vi.mock('../core/agent-loop/agent', async () => {
  return {
    runAgent: vi.fn(async (input: { task: string; mode: string }) => {
      const o = agentResultByRung.get(input.mode) ?? { success: false, exit: 'give_up' };
      return {
        success: o.success,
        text: o.success ? `done: ${input.mode} claims success` : `${o.exit}: ${input.mode}`,
        exit: o.exit,
        steps: [],
        screenshotsCaptured: 0,
        durationMs: 5,
      };
    }),
  };
});

// Force every task into the blind→hybrid→vision ladder, no router pattern match.
vi.mock('../core/preprocessor/preprocessor', async () => {
  return {
    preprocess: () => ({
      strategy: 'blind' as const,
      subtasks: [],
      hints: { reason: 'test', appKey: undefined, capability: undefined, guide: undefined },
    }),
  };
});

// ─── Tests ──────────────────────────────────────────────────────────

describe('Pipeline ground-truth verifier wiring', () => {
  it('agent success + verifier PASS → pipeline reports success', async () => {
    agentResultByRung.clear();
    agentResultByRung.set('blind', { success: true, exit: 'done' });
    const m = makeMockVerifier('pass');

    const pipeline = new Pipeline({
      adapter: makeAdapter(),
      llm: { text: { baseUrl: 'x', model: 'm', apiKey: 'k', isAnthropic: false } },
      verifier: m.verifier,
    });

    const result = await pipeline.run({ task: 'test task' });
    expect(result.success).toBe(true);
    expect(m.verifyWithFeedback).toHaveBeenCalledTimes(1);
    expect(m.captureState).toHaveBeenCalledTimes(2); // before + after
  });

  it('NON-IDEMPOTENT task + verifier REJECT → ladder does NOT retry (no duplicate send)', async () => {
    // Live bug: a "send email" task sent multiple emails because the verifier
    // false-rejected the first send and the ladder re-composed on each climb.
    // For a one-shot action the ladder must STOP after the first attempt.
    agentResultByRung.clear();
    agentResultByRung.set('blind', { success: true, exit: 'done' });   // "sends", claims done
    agentResultByRung.set('hybrid', { success: true, exit: 'done' });  // would re-send IF reached
    agentResultByRung.set('vision', { success: true, exit: 'done' });
    const m = makeMockVerifier('reject');  // verifier can't confirm the send

    const { runAgent } = await import('../core/agent-loop/agent');
    (runAgent as any).mockClear();

    const pipeline = new Pipeline({
      adapter: makeAdapter(),
      llm: {
        text: { baseUrl: 'x', model: 'm', apiKey: 'k', isAnthropic: false },
        vision: { baseUrl: 'x', model: 'v', apiKey: 'k', isAnthropic: false },
      },
      verifier: m.verifier,
    });

    const result = await pipeline.run({ task: 'open outlook and send an email to a@b.com' });

    // The send was attempted ONCE (blind) and NOT retried — hybrid/vision must
    // not run. (Contrast: the idempotent 'test task' above climbs to hybrid.)
    // This is THE fix: no re-attempt → no duplicate send.
    expect((runAgent as any).mock.calls.length).toBe(1);
    // The user is told it was attempted but unverified — so they can check
    // (rather than the pipeline silently sending again).
    expect(result.text ?? '').toMatch(/not retrying|one-shot|verify the result/i);
    // HONEST REPORTING: an unverified one-shot action must NOT report clean
    // success — the user is told to check, not shown "✅ done".
    expect(result.success).toBe(false);
    expect(result.text ?? '').toMatch(/unverified|could not be verified|please (check|verify)/i);
  });

  it('CONTINUITY: subtask 2 receives subtask 1 outcome as priorHandoff', async () => {
    agentResultByRung.clear();
    agentResultByRung.set('blind', { success: true, exit: 'done' });
    const m = makeMockVerifier('pass');
    const { runAgent } = await import('../core/agent-loop/agent');
    (runAgent as any).mockClear();

    const pipeline = new Pipeline({
      adapter: makeAdapter(),
      llm: { text: { baseUrl: 'x', model: 'm', apiKey: 'k', isAnthropic: false } },
      verifier: m.verifier,
      // Force a 2-subtask decomposition.
      decomposer: async () => ['navigate to docs.google.com', 'type a sentence about dogs'],
    });

    await pipeline.run({ task: 'open google docs and type a sentence about dogs' });

    const calls = (runAgent as any).mock.calls;
    // Subtask 1's agent gets no prior-subtask breadcrumb; subtask 2's does.
    const sub1Input = calls[0][0];
    const sub2Input = calls[calls.length - 1][0];
    expect(sub1Input.priorHandoff ?? '').not.toMatch(/PRIOR STEP/);
    // Subtask 2's agent is told what subtask 1 accomplished + to continue there.
    expect(sub2Input.priorHandoff ?? '').toMatch(/PRIOR STEP/);
    expect(sub2Input.priorHandoff ?? '').toMatch(/claims success/);
    expect(sub2Input.priorHandoff ?? '').toMatch(/Continue from that state/);
  });

  it('agent success + verifier REJECT → ladder climbs to hybrid', async () => {
    agentResultByRung.clear();
    // Blind claims done, but the verifier will reject it.
    agentResultByRung.set('blind', { success: true, exit: 'done' });
    // Hybrid also claims done, and we'll let it pass.
    agentResultByRung.set('hybrid', { success: true, exit: 'done' });
    const m = makeMockVerifier('reject');

    const pipeline = new Pipeline({
      adapter: makeAdapter(),
      llm: {
        text: { baseUrl: 'x', model: 'm', apiKey: 'k', isAnthropic: false },
        vision: { baseUrl: 'x', model: 'v', apiKey: 'k', isAnthropic: false },
      },
      verifier: m.verifier,
    });

    // First two verifyWithFeedback() calls reject. Third one pass.
    let calls = 0;
    m.verifyWithFeedback.mockImplementation(async () => {
      calls += 1;
      if (calls < 3) {
        return {
          pass: false, confidence: 0.2,
          causes: [{ kind: 'no_pixel_change' }],
          hint: 'No pixel change after click — target may not have been hit.',
        };
      }
      return { pass: true, confidence: 0.9, causes: [], hint: 'Verification passed.' };
    });

    // Set hybrid → vision both successful in the agent stub.
    agentResultByRung.set('vision', { success: true, exit: 'done' });

    const result = await pipeline.run({ task: 'test task' });
    expect(result.success).toBe(true);
    // Verifier was called 3 times (blind reject, hybrid reject, vision pass).
    expect(m.verifyWithFeedback).toHaveBeenCalledTimes(3);
  });

  it('verifier THROWS → pipeline adopts the agent claim (no false negative)', async () => {
    agentResultByRung.clear();
    agentResultByRung.set('blind', { success: true, exit: 'done' });
    const m = makeMockVerifier('throw');

    const pipeline = new Pipeline({
      adapter: makeAdapter(),
      llm: { text: { baseUrl: 'x', model: 'm', apiKey: 'k', isAnthropic: false } },
      verifier: m.verifier,
    });

    const result = await pipeline.run({ task: 'test task' });
    // Verifier threw → we adopt the agent's claim, pipeline succeeds.
    expect(result.success).toBe(true);
    expect(m.verifyWithFeedback).toHaveBeenCalled();
  });

  it('disableVerifier: true → verifier NOT consulted (pre-0.8.12 behavior)', async () => {
    agentResultByRung.clear();
    agentResultByRung.set('blind', { success: true, exit: 'done' });
    const m = makeMockVerifier('reject'); // would reject if asked

    const pipeline = new Pipeline({
      adapter: makeAdapter(),
      llm: { text: { baseUrl: 'x', model: 'm', apiKey: 'k', isAnthropic: false } },
      verifier: m.verifier,
      disableVerifier: true,
    });

    const result = await pipeline.run({ task: 'test task' });
    // Agent claimed done; verifier was never consulted.
    expect(result.success).toBe(true);
    expect(m.verifyWithFeedback).not.toHaveBeenCalled();
    expect(m.captureState).not.toHaveBeenCalled();
  });

  it('all rungs verifier-rejected at LOW confidence → soft-fail, chain continues, single-subtask completes "successfully"', async () => {
    // The mock returns confidence=0.2 for rejects, which is below the
    // hard-abort threshold (< 0.8). Per the v0.9 soft-fail policy, anything
    // short of a high-confidence (≥0.8) verifier rejection is treated as a
    // warning, not a chain-killer — false-negatives on idempotent operations
    // ("create new canvas in Paint" right after Paint launched) are common
    // and shouldn't take down the whole chain. The verifier still ran on
    // every rung; the chain just doesn't abort.
    agentResultByRung.clear();
    agentResultByRung.set('blind', { success: true, exit: 'done' });
    agentResultByRung.set('hybrid', { success: true, exit: 'done' });
    agentResultByRung.set('vision', { success: true, exit: 'done' });
    const m = makeMockVerifier('reject');

    const pipeline = new Pipeline({
      adapter: makeAdapter(),
      llm: {
        text: { baseUrl: 'x', model: 'm', apiKey: 'k', isAnthropic: false },
        vision: { baseUrl: 'x', model: 'v', apiKey: 'k', isAnthropic: false },
      },
      verifier: m.verifier,
    });

    const result = await pipeline.run({ task: 'test task' });
    // Three rungs, three verifier calls — we still climb the ladder.
    expect(m.verifyWithFeedback).toHaveBeenCalledTimes(3);
    // Soft-fail policy: low-confidence reject doesn't kill the chain.
    expect(result.success).toBe(true);
  });

  it('high-confidence verifier rejection (≥ 0.8) DOES abort the chain', async () => {
    // Override the mock to return a high-confidence rejection (0.85)
    // above the v0.9 hard-abort threshold (≥ 0.8). At this confidence
    // the verifier is essentially certain the task failed, so the chain
    // is allowed to die early instead of dragging through more rungs.
    agentResultByRung.clear();
    agentResultByRung.set('blind', { success: true, exit: 'done' });
    agentResultByRung.set('hybrid', { success: true, exit: 'done' });
    agentResultByRung.set('vision', { success: true, exit: 'done' });

    const verifyWithFeedback = vi.fn(async (): Promise<ReflectionFeedback> => ({
      pass: false,
      confidence: 0.85, // strong, structural rejection
      causes: [{ kind: 'wrong_window_focused', actual: 'OtherApp' }],
      hint: 'Wrong window focused (high confidence)',
    }));
    const verifier: Verifier = {
      verify: vi.fn(async () => ({
        pass: false, confidence: 0.85, reason: 'Failed: wrong window', signals: [],
      })),
      verifyWithFeedback,
      captureState: vi.fn(async () => emptyState()),
    };

    const pipeline = new Pipeline({
      adapter: makeAdapter(),
      llm: {
        text: { baseUrl: 'x', model: 'm', apiKey: 'k', isAnthropic: false },
        vision: { baseUrl: 'x', model: 'v', apiKey: 'k', isAnthropic: false },
      },
      verifier,
    });

    const result = await pipeline.run({ task: 'test task' });
    expect(result.success).toBe(false);
    expect(verifyWithFeedback).toHaveBeenCalledTimes(3);
    expect(result.text.toLowerCase()).toContain('verifier');
  });

  it('mid-confidence verifier rejection (0.6) is now SOFT-FAIL after v0.9 threshold change', async () => {
    // Boundary test: 0.6 was a hard-abort under the old <0.5 soft-fail
    // rule. Under v0.9, the hard-abort threshold moved up to ≥0.8, so a
    // 0.6-confidence rejection now soft-fails and the chain continues.
    // This is the contract restoration: v0.8.0 had no chain to abort,
    // and the user's lived experience was "the agent ran, the agent
    // reported, the caller decides what to do." 0.6 is the verifier
    // saying "I'm leaning towards failure" — not strong enough to nuke
    // the chain on its own.
    agentResultByRung.clear();
    agentResultByRung.set('blind', { success: true, exit: 'done' });
    agentResultByRung.set('hybrid', { success: true, exit: 'done' });
    agentResultByRung.set('vision', { success: true, exit: 'done' });

    const verifyWithFeedback = vi.fn(async (): Promise<ReflectionFeedback> => ({
      pass: false,
      confidence: 0.6,
      causes: [{ kind: 'no_pixel_change' }],
      hint: 'Mild signal — verifier not certain',
    }));
    const verifier: Verifier = {
      verify: vi.fn(async () => ({
        pass: false, confidence: 0.6, reason: 'Mid-confidence reject', signals: [],
      })),
      verifyWithFeedback,
      captureState: vi.fn(async () => emptyState()),
    };

    const pipeline = new Pipeline({
      adapter: makeAdapter(),
      llm: {
        text: { baseUrl: 'x', model: 'm', apiKey: 'k', isAnthropic: false },
        vision: { baseUrl: 'x', model: 'v', apiKey: 'k', isAnthropic: false },
      },
      verifier,
    });

    const result = await pipeline.run({ task: 'test task' });
    // Three rungs climbed; verifier consulted each time.
    expect(verifyWithFeedback).toHaveBeenCalledTimes(3);
    // Chain did NOT abort — 0.6 < 0.8, so soft-fail policy kicked in.
    expect(result.success).toBe(true);
  });
});
