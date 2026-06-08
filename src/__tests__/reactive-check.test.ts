import { describe, it, expect, vi } from 'vitest';
import { reactiveCheck } from '../core/sense/reactive-check';
import type { PlatformAdapter } from '../platform/types';

function adapter(over: Partial<Record<string, unknown>> = {}): PlatformAdapter {
  return {
    listWindows: vi.fn(async () => [{ processId: 9, processName: 'notepad', title: 'Untitled - Notepad', bounds: { x: 0, y: 0, width: 800, height: 600 }, isMinimized: false }]),
    findElements: vi.fn(async () => []),
    invokeElement: vi.fn(async () => ({ success: true, data: { value: 'amr@x.com' } })),
    readClipboard: vi.fn(async () => ''),
    ...over,
  } as unknown as PlatformAdapter;
}

const base = { toolText: 'Pressed a', toolSuccess: true, changesScreen: true, observedChange: false };

describe('reactiveCheck', () => {
  it('passing expect → success preserved, "verified" note', async () => {
    const r = await reactiveCheck({ ...base, expect: [{ type: 'app_running', name: 'notepad' }], adapter: adapter() });
    expect(r).not.toBeNull();
    expect(r!.success).toBe(true);
    expect(r!.text).toMatch(/verified/i);
  });

  it('failing expect → DEVIATION, success:false', async () => {
    const r = await reactiveCheck({ ...base, expect: [{ type: 'app_running', name: 'photoshop' }], adapter: adapter() });
    expect(r!.success).toBe(false);
    expect(r!.text).toContain('DEVIATION');
    expect(r!.text).toContain('adapt');
  });

  it('malformed expect → rejected (not a crash), success:false', async () => {
    const r = await reactiveCheck({ ...base, expect: [{ type: 'not_a_real_type' }], adapter: adapter() });
    expect(r!.success).toBe(false);
    expect(r!.text.toLowerCase()).toContain('expect rejected');
  });

  it('no expect + consequential + no observable change → soft note, success stays true', async () => {
    const r = await reactiveCheck({ ...base, expect: undefined, observedChange: false, adapter: adapter() });
    expect(r!.success).toBe(true);
    expect(r!.text).toContain('no observable change');
  });

  it('no expect + observable change → null (no modification)', async () => {
    const r = await reactiveCheck({ ...base, expect: undefined, observedChange: true, adapter: adapter() });
    expect(r).toBeNull();
  });

  it('no expect + NOT consequential → null', async () => {
    const r = await reactiveCheck({ ...base, expect: undefined, changesScreen: false, observedChange: false, adapter: adapter() });
    expect(r).toBeNull();
  });

  it('does not add a soft note to an already-failed action', async () => {
    const r = await reactiveCheck({ ...base, expect: undefined, toolSuccess: false, observedChange: false, adapter: adapter() });
    expect(r).toBeNull();
  });

  it('chip-safe: an outcome assertion (element_exists) passes regardless of typed text', async () => {
    const a = adapter({ findElements: vi.fn(async () => [{ name: 'Amr Dabbas', controlType: 'Text', bounds: { x: 1, y: 1, width: 10, height: 10 } }]) });
    const r = await reactiveCheck({ ...base, toolText: 'Typed amr@x.com', expect: [{ type: 'element_exists', name: 'Amr Dabbas' }], adapter: a });
    expect(r!.success).toBe(true);
  });
});
