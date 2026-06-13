/**
 * P2 (2026-06-13): open_file no longer reports a false "Opened" for a folder.
 * It used to route through launchApp and return "Opened: <path>"
 * unconditionally — even when launchApp's Start-Menu fallback typed
 * "explorer" and opened File Explorer at **Home** instead of the folder
 * (live bug). Now: directory opens are VERIFIED by the leaf-folder window
 * title, with no Start-Menu fallback, and return isError when unconfirmed.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getExtraTools } from '../tools/extras';
import type { ToolContext } from '../tools/types';

const openFile = getExtraTools().find(t => t.name === 'open_file')!;

const dir = join(tmpdir(), `clawd-of-${process.pid}`);
beforeAll(async () => { await fs.mkdir(dir, { recursive: true }); });
afterAll(async () => { await fs.rm(dir, { recursive: true, force: true }); });

function ctx(launchApp: any): ToolContext {
  return {
    ensureInitialized: async () => {},
    platform: { platform: 'win32', launchApp: vi.fn(launchApp) },
  } as unknown as ToolContext;
}

describe('open_file — directory open is verified, not assumed (Windows)', () => {
  const leaf = dir.split(/[\\/]/).pop()!;

  it('reports success when the matching folder window surfaces', async () => {
    const r = await openFile.handler({ path: dir }, ctx(async () => ({ title: `${leaf} - File Explorer`, pid: 5 })));
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(new RegExp(`Opened folder "${leaf}"`));
  });

  it('returns isError when Explorer landed on Home (false-success guard)', async () => {
    const r = await openFile.handler({ path: dir }, ctx(async () => ({ title: 'Home - File Explorer', pid: 5 })));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/could NOT confirm the folder/);
  });

  it('returns isError when no window surfaced at all (no Start-Menu fallback)', async () => {
    const r = await openFile.handler({ path: dir }, ctx(async () => ({}))); // launchApp returned {} (fallback skipped)
    expect(r.isError).toBe(true);
  });

  it('passes noStartMenuFallback to launchApp for the directory path', async () => {
    const spy = vi.fn(async () => ({ title: `${leaf} - File Explorer` }));
    await openFile.handler({ path: dir }, ctx(spy));
    expect(spy).toHaveBeenCalledWith('explorer.exe', expect.objectContaining({ url: dir, noStartMenuFallback: true }));
  });
});
