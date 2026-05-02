import { describe, expect, it } from 'vitest';
import { getCompactSurface, getTool } from '../tools';
import { evaluateToolCall } from '../tools/safety-gate';

describe('direct tool safety gate', () => {
  it('allows read-only tools', () => {
    const tool = getTool('read_screen');
    expect(tool).toBeTruthy();
    expect(evaluateToolCall(tool!, {})).toBeNull();
  });

  it('blocks dangerous key combos before handler execution', () => {
    const tool = getTool('key_press');
    const result = evaluateToolCall(tool!, { key: 'alt+f4' });
    expect(result?.isError).toBe(true);
    expect(result?.text).toContain('safety block');
  });

  it('fails closed for confirm-tier direct REST/MCP actions', () => {
    const tool = getTool('close_window');
    const result = evaluateToolCall(tool!, {});
    expect(result?.isError).toBe(true);
    expect(result?.text).toContain('safety confirm');
  });

  it('maps compact actions to their granular safety tier', () => {
    const tool = getCompactSurface().find(t => t.name === 'browser');
    const result = evaluateToolCall(tool!, { action: 'evaluate', javascript: 'document.cookie' });
    expect(result?.isError).toBe(true);
    expect(result?.text).toContain('requires user confirmation');
  });
});
