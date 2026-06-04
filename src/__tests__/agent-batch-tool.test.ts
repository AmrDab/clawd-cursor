/**
 * The autonomous loop's `batch` tool (src/core/agent-loop/batch-tool.ts).
 * buildUnifiedTools + the loop safety are mocked so we test the executor's
 * orchestration over the agent-loop machinery in isolation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const unified: Record<string, any> = {};
let safetyFn: (a: any) => any = () => ({ decision: 'allow', tier: 'input' });

vi.mock('../core/agent-loop/tools', () => ({
  buildUnifiedTools: () => Object.values(unified),
}));
vi.mock('../core/safety', () => ({
  evaluate: (a: any) => safetyFn(a),
  isAllowed: (d: any) => d.decision === 'allow',
}));

import { buildBatchTool } from '../core/agent-loop/batch-tool';

const uTool = (name: string, fn?: any) => ({ name, execute: fn ?? vi.fn(async () => ({ success: true, text: `${name} ok` })) });
const ctx = { mode: 'blind', task: 'do the thing', activeApp: 'notepad' } as any;
const run = (steps: any, args: any = {}) => buildBatchTool().execute({ steps: JSON.stringify(steps), ...args }, ctx);

beforeEach(() => {
  for (const k of Object.keys(unified)) delete unified[k];
  safetyFn = () => ({ decision: 'allow', tier: 'input' });
  // read_screen used by guards — default: empty tree
  unified.read_screen = uTool('read_screen', vi.fn(async () => ({ success: true, text: '(empty a11y tree)' })));
});

describe('agent batch — happy path', () => {
  it('runs all steps and reports success', async () => {
    unified.open_app = uTool('open_app');
    unified.type = uTool('type');
    const r = await run([{ name: 'open_app', args: { name: 'notepad' } }, { name: 'type', args: { text: 'hi' } }]);
    expect(r.success).toBe(true);
    expect(r.text).toMatch(/all 2 steps completed/);
    expect(unified.type.execute).toHaveBeenCalled();
  });
});

describe('agent batch — halting', () => {
  it('halts on a failed step and skips the rest', async () => {
    unified.open_app = uTool('open_app');
    unified.type = uTool('type', vi.fn(async () => ({ success: false, text: 'no focus' })));
    unified.key = uTool('key');
    const r = await run([{ name: 'open_app' }, { name: 'type' }, { name: 'key' }]);
    expect(r.success).toBe(false);
    expect(r.text).toMatch(/halted at step 1/);
    expect(unified.key.execute).not.toHaveBeenCalled();
  });

  it('halts on unknown tool', async () => {
    unified.open_app = uTool('open_app');
    const r = await run([{ name: 'open_app' }, { name: 'nope' }]);
    expect(r.success).toBe(false);
    expect(r.text).toMatch(/not available/);
  });

  it('never resolves the batch tool itself (no recursion)', async () => {
    unified.batch = uTool('batch'); // present in catalog but must be filtered out
    const r = await run([{ name: 'batch', args: { steps: '[]' } }]);
    expect(r.success).toBe(false);
    expect(r.text).toMatch(/not available/);
  });
});

describe('agent batch — guards (re-perceive)', () => {
  it('halts when the expected window is not focused', async () => {
    unified.read_screen = uTool('read_screen', vi.fn(async () => ({ success: true, text: 'WINDOWS [msedge] "YouTube"' })));
    unified.type = uTool('type');
    const r = await run([{ name: 'type', args: { text: 'x' }, expect: { window: 'notepad' } }]);
    expect(r.success).toBe(false);
    expect(r.text).toMatch(/window "notepad" not focused/);
    expect(unified.type.execute).not.toHaveBeenCalled();
  });

  it('proceeds when the expected window is present in the tree', async () => {
    unified.read_screen = uTool('read_screen', vi.fn(async () => ({ success: true, text: 'WINDOWS [Notepad] "Untitled - Notepad"' })));
    unified.type = uTool('type');
    const r = await run([{ name: 'type', args: { text: 'x' }, expect: { window: 'notepad' } }]);
    expect(r.success).toBe(true);
    expect(unified.type.execute).toHaveBeenCalled();
  });
});

describe('agent batch — safety + cap + parsing', () => {
  it('halts at a step the loop safety blocks', async () => {
    unified.invoke_element = uTool('invoke_element');
    safetyFn = (a) => a.tool === 'invoke_element' ? { decision: 'confirm', tier: 'destructive', reason: 'Send' } : { decision: 'allow', tier: 'input' };
    const r = await run([{ name: 'invoke_element', args: { name: 'Send' } }]);
    expect(r.success).toBe(false);
    expect(r.text).toMatch(/safety confirm/);
    expect(unified.invoke_element.execute).not.toHaveBeenCalled();
  });

  it('caps at 10 steps', async () => {
    unified.t = uTool('t');
    const r = await run(Array.from({ length: 12 }, () => ({ name: 't' })));
    expect(r.success).toBe(false);
    expect(r.text).toMatch(/capped at 10/);
  });

  it('accepts steps as a real array too, and rejects malformed', async () => {
    unified.t = uTool('t');
    const direct = await buildBatchTool().execute({ steps: [{ name: 't' }] } as any, ctx);
    expect(direct.success).toBe(true);
    const bad = await buildBatchTool().execute({ steps: 'not json' } as any, ctx);
    expect(bad.success).toBe(false);
  });
});
