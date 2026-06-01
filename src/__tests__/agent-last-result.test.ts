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

import { Agent } from '../core/agent';

/**
 * Build a minimal Agent stub with a pre-loaded pipelineUnified mock.
 * Sidesteps the heavy NativeDesktop / AccessibilityBridge / OcrEngine
 * construction by reusing Agent.prototype directly. Sufficient for testing
 * the executeTask -> state.lastResult contract.
 */
function makeAgentWithPipeline(pipelineResult: {
  success: boolean;
  text?: string;
  trace?: any[];
  path?: string;
}) {
  const agent: any = Object.create(Agent.prototype);
  agent.state = { status: 'idle', stepsCompleted: 0, stepsTotal: 0 };
  agent.aborted = false;
  agent.taskExecutionLocked = false;
  agent.resolvedConfig = null;
  agent.pipelineUnified = {
    run: vi.fn(async () => ({
      success: pipelineResult.success,
      text: pipelineResult.text ?? '',
      trace: pipelineResult.trace ?? [],
      path: pipelineResult.path ?? 'unified',
    })),
  };
  return agent as Agent;
}

describe('Agent.executeTask populates state.lastResult', () => {
  it('sets state.lastResult on success so pollers can read it', async () => {
    const agent: any = makeAgentWithPipeline({ success: true, text: 'task complete' });

    const returnedResult = await agent.executeTask('open notepad');

    const state = agent.getState();
    expect(state.status).toBe('idle');
    expect(state.lastResult).toBeDefined();
    expect(state.lastResult.success).toBe(true);
    // The lastResult on state must be the same shape that was returned
    // to the direct caller — that's the whole point of the snapshot.
    expect(state.lastResult).toEqual(returnedResult);
  });

  it('sets state.lastResult on failure (success=false)', async () => {
    const agent: any = makeAgentWithPipeline({ success: false, text: 'task failed' });

    await agent.executeTask('open something that does not exist');

    const state = agent.getState();
    expect(state.status).toBe('idle');
    expect(state.lastResult).toBeDefined();
    expect(state.lastResult.success).toBe(false);
  });

  it('exposes lastResult on a fresh getState() snapshot (not a reference)', async () => {
    const agent: any = makeAgentWithPipeline({ success: true });
    await agent.executeTask('task');

    const snapA = agent.getState();
    const snapB = agent.getState();
    // getState returns a shallow copy; lastResult itself is shared by ref
    // (that's fine — TaskResult is treated as immutable by readers).
    expect(snapA).not.toBe(snapB);
    expect(snapA.lastResult).toEqual(snapB.lastResult);
  });

  it('clears lastResult at start of next task (no stale read while in flight)', async () => {
    const agent: any = makeAgentWithPipeline({ success: true });
    await agent.executeTask('first task');
    expect(agent.getState().lastResult).toBeDefined();

    // Swap pipelineUnified.run to a deferred promise so we can observe
    // state mid-task and confirm lastResult was cleared at the start.
    let resolvePipeline: (v: any) => void = () => {};
    const deferred = new Promise(r => { resolvePipeline = r; });
    agent.pipelineUnified.run = vi.fn(() => deferred);

    const secondTask = agent.executeTask('second task');
    // Yield once so the state-clear at the top of _executeTaskUnified runs.
    await new Promise(r => setImmediate(r));

    expect(agent.getState().status).toBe('thinking');
    expect(agent.getState().lastResult).toBeUndefined();

    resolvePipeline({ success: true, text: '', trace: [], path: 'unified' });
    await secondTask;
    expect(agent.getState().lastResult).toBeDefined();
  });
});
