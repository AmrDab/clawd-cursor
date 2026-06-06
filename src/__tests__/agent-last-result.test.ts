/**
 * Agent.executeTask must snapshot its TaskResult onto state.lastResult
 * before resolving, so external pollers (delegate_to_agent compact tool)
 * can read the outcome via agent_status after observing status === 'idle'.
 *
 * Pre-fix bug: the agent only stored {status, currentTask, stepsCompleted,
 * stepsTotal} on state and returned the TaskResult to the caller. The
 * compact `task` action polls agent_status → reads data.lastResult →
 * undefined → reports `{success: false}` even on real success.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: { config: {}, move: vi.fn(), click: vi.fn(), setPosition: vi.fn() },
  keyboard: { config: {}, type: vi.fn() },
  screen: { grab: vi.fn() },
  Button: { LEFT: 0 },
  Key: new Proxy({}, { get: (_t, p) => p }),
  Point: class { constructor(public x: number, public y: number) {} },
  Region: class { constructor(public left: number, public top: number, public width: number, public height: number) {} },
}));

vi.mock('sharp', () => ({
  default: vi.fn(() => ({
    resize: vi.fn().mockReturnThis(),
    png: vi.fn().mockReturnThis(),
    jpeg: vi.fn().mockReturnThis(),
    toBuffer: vi.fn().mockResolvedValue(Buffer.from('fake')),
  })),
}));

// Mock runAgent so tests don't need real platform/LLM.
// The thin Agent._executeTask calls runAgent directly.
const mockRunAgent = vi.fn();
vi.mock('../core/agent-loop/agent', () => ({
  runAgent: (...args: any[]) => mockRunAgent(...args),
}));

// Mock getPlatform so no real platform is initialised.
vi.mock('../platform', () => ({
  getPlatform: vi.fn(async () => ({
    platform: 'windows' as const,
    getActiveWindow: vi.fn(async () => null),
    getScreenSize: vi.fn(async () => ({ logicalWidth: 1920, logicalHeight: 1080, physicalWidth: 1920, physicalHeight: 1080, dpiRatio: 1 })),
    getUiTree: vi.fn(async () => []),
    listWindows: vi.fn(async () => []),
    screenshot: vi.fn(async () => ({ buffer: Buffer.from(''), width: 1280, height: 720 })),
    mouseClick: vi.fn(async () => {}),
    mouseMove: vi.fn(async () => {}),
    mouseDown: vi.fn(async () => {}),
    mouseUp: vi.fn(async () => {}),
    mouseDrag: vi.fn(async () => {}),
    mouseScroll: vi.fn(async () => {}),
    keyPress: vi.fn(async () => {}),
    typeText: vi.fn(async () => {}),
    readClipboard: vi.fn(async () => ''),
    writeClipboard: vi.fn(async () => {}),
    focusWindow: vi.fn(async () => ({ success: false })),
    invokeElement: vi.fn(async () => ({ success: false })),
    openApp: vi.fn(async () => ({ success: false })),
    openUrl: vi.fn(async () => {}),
    launchApp: vi.fn(async () => ({ success: false })),
  })),
}));

// Mock loadPipelineConfig so no disk config is needed.
vi.mock('../surface/doctor', () => ({
  loadPipelineConfig: vi.fn(() => null),
}));

import { Agent } from '../core/agent';

function makeDefaultAgentResult(success: boolean, text = '') {
  return {
    success,
    exit: success ? 'done' : 'give_up' as const,
    text,
    steps: [],
    llmCalls: 0,
    screenshotsCaptured: 0,
    durationMs: 10,
  };
}

function makeAgent(): Agent {
  const agent = new Agent({
    ai: { apiKey: '', visionApiKey: '' },
    server: { port: 3847 },
    safety: { requireConfirm: false, blockDestructive: false },
  } as any);
  return agent;
}

describe('Agent.executeTask populates state.lastResult', () => {
  it('sets state.lastResult on success so pollers can read it', async () => {
    mockRunAgent.mockResolvedValue(makeDefaultAgentResult(true, 'task complete'));
    const agent = makeAgent();

    const returnedResult = await agent.executeTask('open notepad');

    const state = agent.getState();
    expect(state.status).toBe('idle');
    expect(state.lastResult).toBeDefined();
    expect(state.lastResult!.success).toBe(true);
    // The lastResult on state must be the same shape that was returned
    // to the direct caller — that's the whole point of the snapshot.
    expect(state.lastResult).toEqual(returnedResult);
  });

  it('sets state.lastResult on failure (success=false)', async () => {
    mockRunAgent.mockResolvedValue(makeDefaultAgentResult(false, 'task failed'));
    const agent = makeAgent();

    await agent.executeTask('open something that does not exist');

    const state = agent.getState();
    expect(state.status).toBe('idle');
    expect(state.lastResult).toBeDefined();
    expect(state.lastResult!.success).toBe(false);
  });

  it('exposes lastResult on a fresh getState() snapshot (not a reference)', async () => {
    mockRunAgent.mockResolvedValue(makeDefaultAgentResult(true));
    const agent = makeAgent();
    await agent.executeTask('task');

    const snapA = agent.getState();
    const snapB = agent.getState();
    // getState returns a shallow copy; lastResult itself is shared by ref
    // (that's fine — TaskResult is treated as immutable by readers).
    expect(snapA).not.toBe(snapB);
    expect(snapA.lastResult).toEqual(snapB.lastResult);
  });

  it('clears lastResult at start of next task (no stale read while in flight)', async () => {
    mockRunAgent.mockResolvedValue(makeDefaultAgentResult(true));
    const agent = makeAgent();
    await agent.executeTask('first task');
    expect(agent.getState().lastResult).toBeDefined();

    // Swap runAgent to a deferred promise so we can observe state mid-task
    // and confirm lastResult was cleared at the start.
    let resolvePipeline: (v: any) => void = () => {};
    const deferred = new Promise(r => { resolvePipeline = r; });
    mockRunAgent.mockReturnValue(deferred);

    const secondTask = agent.executeTask('second task');
    // Yield once so the state-clear at the top of _executeTask runs.
    await new Promise(r => setImmediate(r));

    expect(agent.getState().status).toBe('thinking');
    expect(agent.getState().lastResult).toBeUndefined();

    resolvePipeline(makeDefaultAgentResult(true));
    await secondTask;
    expect(agent.getState().lastResult).toBeDefined();
  });
});
