/**
 * Cross-rung handoff summarizer — generic, deterministic, task-agnostic.
 */
import { describe, it, expect } from 'vitest';
import { summarizeForHandoff } from '../core/agent-loop/handoff';
import type { AgentResult, AgentStep } from '../core/agent-loop/types';

function step(p: Partial<AgentStep>): AgentStep {
  return {
    turn: p.turn ?? 1,
    thought: p.thought,
    toolName: p.toolName ?? 'noop',
    toolArgs: p.toolArgs ?? {},
    result: p.result ?? { success: true, text: 'ok' },
    durationMs: 0,
    fingerprintChanged: p.fingerprintChanged ?? false,
  };
}

function result(p: Partial<AgentResult>): AgentResult {
  return {
    success: p.success ?? false,
    exit: p.exit ?? 'give_up',
    text: p.text ?? '',
    steps: p.steps ?? [],
    llmCalls: 0,
    screenshotsCaptured: 0,
    durationMs: 0,
  };
}

describe('summarizeForHandoff', () => {
  it('reports what the prior agent accomplished and why it handed off', () => {
    const r = result({
      exit: 'cannot_read',
      steps: [
        step({ toolName: 'invoke_element', toolArgs: { name: 'Compose' }, result: { success: true, text: 'Invoked "Compose"' }, thought: 'opening a new mail' }),
        step({ toolName: 'set_value', toolArgs: { name: 'To', value: 'a@b.com' }, result: { success: true, text: 'set To' } }),
        step({ toolName: 'invoke_element', toolArgs: { name: 'Send' }, result: { success: false, text: 'blocked: needs confirm' }, thought: 'Send is safety-gated; I cannot click it via a11y' }),
      ],
    });
    const note = summarizeForHandoff(r, 'blind')!;
    expect(note).toContain('blind agent');
    expect(note).toContain('exited: cannot_read');
    // accomplished successful, non-perception actions
    expect(note).toContain('Compose');
    expect(note).toContain('To');
    // does NOT credit the failed Send click as an accomplished action
    expect(note).not.toContain('invoke_element(name=Send)');
    // carries the blocking reasoning + escalation guidance
    expect(note).toContain('safety-gated');
    expect(note.toLowerCase()).toContain('screenshot'); // cannot_read → drive by screenshot
  });

  it('is task-agnostic — contains no app or task keywords of its own', () => {
    const r = result({
      exit: 'give_up',
      steps: [step({ toolName: 'click', toolArgs: { x: 100, y: 200 }, result: { success: true, text: 'Clicked' }, thought: 'trying a spot' })],
    });
    const note = summarizeForHandoff(r, 'hybrid')!;
    // no hardcoded exam/email/calculator/app names baked into the summarizer
    expect(note.toLowerCase()).not.toMatch(/exam|wikipedia|calculator|outlook|notepad/);
  });

  it('returns undefined when the prior agent did nothing useful', () => {
    const r = result({ exit: 'give_up', steps: [step({ toolName: 'screenshot', result: { success: true, text: 'Captured' } })] });
    expect(summarizeForHandoff(r, 'vision')).toBeUndefined();
  });

  it('works in both directions (vision → text too)', () => {
    const r = result({
      exit: 'max_turns',
      steps: [step({ toolName: 'mouse', toolArgs: { action: 'click', x: 50, y: 60 }, result: { success: true, text: 'Clicked left at (50, 60)' }, thought: 'clicked Send, inbox should refresh' })],
    });
    const note = summarizeForHandoff(r, 'vision')!;
    expect(note).toContain('vision agent');
    expect(note.toLowerCase()).toContain('continue'); // tells the next (text) agent to continue
  });
});
