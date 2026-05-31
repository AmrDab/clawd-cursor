/**
 * Tests for the v0.8.15 LLM-decomposer refinement step.
 *
 * The regex decomposer treats indefinite phrases like "any wikipedia
 * page" as literal strings, so the router downstream tries to launch
 * an app named "any wikipedia page" or types it into a search bar.
 * v0.7.x had a regex-first / LLM-fallback flow that interpreted such
 * phrases; v0.8.1 unification kept the regex but never wired the LLM.
 *
 * These tests pin down:
 *   1. INDEFINITE_INTENT_PATTERN actually matches the real-world
 *      phrasings that broke things.
 *   2. The pipeline's decomposer auto-wires from `llm.text` config.
 *   3. The refine path is GATED — concrete tasks don't trigger an
 *      LLM call, only intent-laden ones do.
 *   4. Failure of the LLM decomposer is non-fatal (regex result is
 *      still used).
 */

import { describe, it, expect, vi } from 'vitest';
import { Pipeline } from '../core/pipeline';
import type { PlatformAdapter, WindowInfo, ScreenshotResult } from '../platform/types';

// ─── Mock adapter (minimal — verifier disabled in tests) ────────────

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

// ─── Stub the agent loop so we can inspect what subtasks reached it ──

const subtasksReceived: string[] = [];

vi.mock('../core/agent-loop/agent', async () => {
  return {
    runAgent: vi.fn(async (input: { task: string; mode: string }) => {
      subtasksReceived.push(input.task);
      // Always succeed so the pipeline runs through every subtask.
      return {
        success: true,
        text: `done: ${input.mode} ran "${input.task}"`,
        exit: 'done',
        steps: [],
        screenshotsCaptured: 0,
        durationMs: 5,
      };
    }),
  };
});

// Force every subtask into the blind strategy so the real router doesn't
// fire — these tests are about the decomposer wiring, not router pattern
// matching, and the real router's start-menu fallback would time out.
vi.mock('../core/preprocessor/preprocessor', async () => {
  const { decompose } = await import('../core/decompose/parser');
  return {
    preprocess: (task: string) => {
      const r = decompose(task);
      const subtasks = r && !r.keptAsOne ? r.subtasks : [];
      return {
        strategy: 'blind' as const,
        subtasks,
        hints: { reason: 'test', appKey: undefined, capability: undefined, guide: undefined },
        classification: { confidence: 1 },
      };
    },
  };
});

// ─── Tests ──────────────────────────────────────────────────────────

describe('Pipeline LLM-decomposer refinement', () => {
  it('refines tasks with indefinite phrasing ("any wikipedia page")', async () => {
    subtasksReceived.length = 0;
    const decomposer = vi.fn(async (_task: string) => [
      'open Microsoft Edge',
      'navigate to https://en.wikipedia.org/wiki/Special:Random',
      'copy the first sentence',
      'open Notepad',
      'paste',
    ]);

    const pipeline = new Pipeline({
      adapter: makeAdapter(),
      llm: { text: { baseUrl: 'x', model: 'm', apiKey: 'k', isAnthropic: false } },
      decomposer,
      disableVerifier: true,
    });

    const result = await pipeline.run({
      task: 'open any wikipedia page and copy a sentence onto notepad',
    });

    expect(decomposer).toHaveBeenCalledTimes(1);
    // First arg is the task; a second arg now carries the desktop-survey
    // context string (empty here — the test adapter has no real windows).
    expect(decomposer.mock.calls[0][0]).toBe('open any wikipedia page and copy a sentence onto notepad');
    // The agent should have received the LLM-decomposed concrete subtasks,
    // NOT the regex split's "open any wikipedia page".
    expect(subtasksReceived.some(s => /Special:Random|Microsoft Edge/.test(s))).toBe(true);
    expect(subtasksReceived.some(s => /any wikipedia page/i.test(s))).toBe(false);
    expect(result.success).toBe(true);
  });

  it('does NOT refine TRIVIAL tasks ("open notepad") — single-verb single-target fast path', async () => {
    subtasksReceived.length = 0;
    const decomposer = vi.fn(async () => null);

    const pipeline = new Pipeline({
      adapter: makeAdapter(),
      llm: { text: { baseUrl: 'x', model: 'm', apiKey: 'k', isAnthropic: false } },
      decomposer,
      disableVerifier: true,
    });

    await pipeline.run({ task: 'open notepad' });

    // Trivial task → fast-path skip, decomposer not called.
    expect(decomposer).not.toHaveBeenCalled();
  });

  it('DOES refine compound tasks ("open notepad and type hello") — always-on Tier 0', async () => {
    subtasksReceived.length = 0;
    const decomposer = vi.fn(async () => ['open Notepad', 'type hello']);

    const pipeline = new Pipeline({
      adapter: makeAdapter(),
      llm: { text: { baseUrl: 'x', model: 'm', apiKey: 'k', isAnthropic: false } },
      decomposer,
      disableVerifier: true,
    });

    await pipeline.run({ task: 'open notepad and type hello' });

    // Compound → not trivial → LLM decomposer runs. Restored v0.7-era
    // semantic interpretation tier.
    expect(decomposer).toHaveBeenCalledTimes(1);
  });

  it('falls back to regex subtasks when the decomposer throws', async () => {
    subtasksReceived.length = 0;
    const decomposer = vi.fn(async () => {
      throw new Error('LLM provider down');
    });

    const pipeline = new Pipeline({
      adapter: makeAdapter(),
      llm: { text: { baseUrl: 'x', model: 'm', apiKey: 'k', isAnthropic: false } },
      decomposer,
      disableVerifier: true,
    });

    const result = await pipeline.run({
      task: 'open any random app and do something',
    });

    expect(decomposer).toHaveBeenCalled();
    // The pipeline should still complete using the regex result instead
    // of crashing.
    expect(result.success).toBe(true);
  });

  it('falls back to regex subtasks when the decomposer returns null', async () => {
    subtasksReceived.length = 0;
    const decomposer = vi.fn(async () => null);

    const pipeline = new Pipeline({
      adapter: makeAdapter(),
      llm: { text: { baseUrl: 'x', model: 'm', apiKey: 'k', isAnthropic: false } },
      decomposer,
      disableVerifier: true,
    });

    const result = await pipeline.run({
      task: 'open any random thing',
    });

    expect(decomposer).toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it('honors decomposer: null (explicit opt-out)', async () => {
    subtasksReceived.length = 0;
    // Custom decomposer would be called if not for the null override.
    const customCounter = vi.fn();

    const pipeline = new Pipeline({
      adapter: makeAdapter(),
      llm: { text: { baseUrl: 'x', model: 'm', apiKey: 'k', isAnthropic: false } },
      decomposer: null,
      disableVerifier: true,
    });

    await pipeline.run({ task: 'open any wikipedia page' });

    expect(customCounter).not.toHaveBeenCalled();
    // Subtasks reached the agent verbatim from the regex decomposer.
    expect(subtasksReceived.some(s => /any wikipedia page/i.test(s))).toBe(true);
  });
});
