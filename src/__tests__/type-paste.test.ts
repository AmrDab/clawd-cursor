/**
 * The agent `type` tool must paste via the clipboard (fast) instead of
 * per-character typing (slow, "letter by letter") — restoring the legacy
 * smart_type speed. It also restores the prior clipboard so a pending copy
 * isn't clobbered. Falls back to typeText if clipboard/paste fails.
 */
import { describe, it, expect, vi } from 'vitest';
import { buildUnifiedTools } from '../core/agent-loop/tools';
import type { AgentToolContext } from '../core/agent-loop/types';

function ctxWith(platform: any): AgentToolContext {
  return {
    platform, task: 't', mode: 'blind',
    screen: { logicalWidth: 1280, logicalHeight: 720, physicalWidth: 1280, physicalHeight: 720, dpiRatio: 1 },
    screenshotsCaptured: { n: 0 },
  };
}
const typeTool = () => buildUnifiedTools('blind').find(t => t.name === 'type')!;

describe('type tool — clipboard paste fast path', () => {
  it('pastes via clipboard (write + mod+v), NOT per-character typeText', async () => {
    const calls: string[] = [];
    const platform = {
      readClipboard: vi.fn(async () => 'PRIOR'),
      writeClipboard: vi.fn(async (s: string) => { calls.push(`write:${s}`); }),
      keyPress: vi.fn(async (c: string) => { calls.push(`key:${c}`); }),
      typeText: vi.fn(async () => { calls.push('typeText'); }),
    };
    const r = await typeTool().execute({ text: 'adele songs' }, ctxWith(platform));
    expect(r.success).toBe(true);
    expect(platform.typeText).not.toHaveBeenCalled();          // NOT char-by-char
    expect(calls).toContain('write:adele songs');               // wrote the text
    expect(calls).toContain('key:mod+v');                       // pasted
    expect(r.text).toMatch(/paste/);
  });

  it('restores the prior clipboard after pasting (no clobber of a pending copy)', async () => {
    const writes: string[] = [];
    const platform = {
      readClipboard: vi.fn(async () => 'COPIED SENTENCE'),
      writeClipboard: vi.fn(async (s: string) => { writes.push(s); }),
      keyPress: vi.fn(async () => {}),
      typeText: vi.fn(async () => {}),
    };
    await typeTool().execute({ text: 'a filename' }, ctxWith(platform));
    // write the text to paste, then restore the prior clipboard
    expect(writes[0]).toBe('a filename');
    expect(writes[writes.length - 1]).toBe('COPIED SENTENCE');
  });

  it('falls back to per-character typeText when clipboard is unavailable', async () => {
    const platform = {
      readClipboard: vi.fn(async () => { throw new Error('no clipboard'); }),
      writeClipboard: vi.fn(async () => { throw new Error('no clipboard'); }),
      keyPress: vi.fn(async () => {}),
      typeText: vi.fn(async () => {}),
    };
    const r = await typeTool().execute({ text: 'hello' }, ctxWith(platform));
    expect(r.success).toBe(true);
    expect(platform.typeText).toHaveBeenCalledWith('hello');
  });
});
