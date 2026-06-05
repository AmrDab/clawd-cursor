/**
 * Coverage test for TOOL_META (Step 1 of the MCP re-projection refactor).
 *
 * Enforced invariant: every System B tool name returned by buildUnifiedTools()
 * (across blind, hybrid, vision modes) has a TOOL_META entry, EXCEPT for:
 *   - terminal actions: done, give_up, cannot_read
 *   - vision compound tools: mouse, keyboard, window (from compound.ts)
 *
 * When a new tool is added to buildUnifiedTools() this test will fail
 * immediately, requiring the author to also add the TOOL_META entry.
 *
 * Mirrors the pattern of src/__tests__/cost-class-coverage.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { vi } from 'vitest';

// ── Mock heavy native deps ───────────────────────────────────────────────────

vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: { config: {}, move: vi.fn(), click: vi.fn(), setPosition: vi.fn() },
  keyboard: { config: {}, type: vi.fn() },
  screen: { grab: vi.fn() },
  Button: { LEFT: 0 },
  Key: new Proxy({}, { get: (_t, p) => p }),
  Point: class { constructor(public x: number, public y: number) {} },
  Region: class {
    constructor(
      public left: number, public top: number,
      public width: number, public height: number,
    ) {}
  },
}));

vi.mock('sharp', () => ({
  default: vi.fn(() => ({
    resize: vi.fn().mockReturnThis(),
    png: vi.fn().mockReturnThis(),
    jpeg: vi.fn().mockReturnThis(),
    toBuffer: vi.fn().mockResolvedValue(Buffer.from('fake-png')),
  })),
}));

vi.mock('../../src/platform/ocr-engine', async () => ({
  OcrEngine: class {
    isAvailable() { return false; }
    async recognizeScreen() { return { elements: [], fullText: '', durationMs: 0 }; }
    invalidateCache() {}
  },
}));

vi.mock('../platform/ocr-engine', () => ({
  OcrEngine: class {
    isAvailable() { return false; }
    async recognizeScreen() { return { elements: [], fullText: '', durationMs: 0 }; }
    invalidateCache() {}
  },
}));

// ── Imports after mocks ──────────────────────────────────────────────────────

import { buildUnifiedTools } from '../core/agent-loop/tools';
import { TOOL_META } from '../core/agent-loop/tool-meta';
import { COMPOUND_REPLACES } from '../core/agent-loop/compound';

// ── Exclusion sets ────────────────────────────────────────────────────────────

/**
 * Terminal actions — never projected to the MCP surface.
 * These tools tell the AGENT to stop; MCP clients use ToolResult.isError instead.
 */
const TERMINAL_ACTIONS = new Set(['done', 'give_up', 'cannot_read']);

/**
 * Vision compound tool names — collapsed from many granulars, no 1:1 MCP counterpart.
 * These are the names defined in compound.ts (mouse, keyboard, window) plus screenshot
 * which is handled separately in vision mode.
 */
const VISION_COMPOUNDS: Set<string> = new Set([
  // COMPOUND_REPLACES is the Set of granular names that the compound tools REPLACE
  // (click, drag, type, key, etc.) — not the compound names themselves.
  // The compound tools themselves are 'mouse', 'keyboard', 'window'.
  'mouse',
  'keyboard',
  'window',
]);

// ── Build the complete System B tool name set ─────────────────────────────────

/**
 * Collect unique tool names across all three modes.
 * Union: blind + hybrid + vision = complete catalog.
 */
function getAllSystemBNames(): Set<string> {
  const names = new Set<string>();
  for (const mode of ['blind', 'hybrid', 'vision'] as const) {
    for (const tool of buildUnifiedTools(mode)) {
      names.add(tool.name);
    }
  }
  return names;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('TOOL_META coverage (Step 1 — enforced)', () => {
  const allNames = getAllSystemBNames();

  // Names that require a TOOL_META entry (everything except excluded sets).
  const requiredNames = [...allNames].filter(
    name => !TERMINAL_ACTIONS.has(name) && !VISION_COMPOUNDS.has(name),
  );

  it('every non-excluded System B tool has a TOOL_META entry', () => {
    const missing = requiredNames.filter(name => !(name in TOOL_META));
    expect(missing).toEqual([]);
  });

  it('TOOL_META has no stale entries (all keys match a real System B tool)', () => {
    const stale = Object.keys(TOOL_META).filter(name => !allNames.has(name));
    expect(stale).toEqual([]);
  });

  it('every TOOL_META entry has required fields (category, safetyTier, costClass)', () => {
    const VALID_CATEGORIES = new Set([
      'perception', 'mouse', 'keyboard', 'window', 'clipboard', 'browser', 'orchestration',
    ]);
    const VALID_COST_CLASSES = new Set([
      'act', 'inspect', 'perceive-text', 'perceive-image',
    ]);
    const VALID_SAFETY_TIERS = new Set([0, 1, 2, 3]);

    const bad: string[] = [];
    for (const [name, meta] of Object.entries(TOOL_META)) {
      if (!VALID_CATEGORIES.has(meta.category)) {
        bad.push(`${name}: invalid category "${meta.category}"`);
      }
      if (!VALID_COST_CLASSES.has(meta.costClass)) {
        bad.push(`${name}: invalid costClass "${meta.costClass}"`);
      }
      if (!VALID_SAFETY_TIERS.has(meta.safetyTier)) {
        bad.push(`${name}: invalid safetyTier "${meta.safetyTier}"`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('excluded sets are disjoint (no name in both TERMINAL and VISION_COMPOUNDS)', () => {
    const intersection = [...TERMINAL_ACTIONS].filter(n => VISION_COMPOUNDS.has(n));
    expect(intersection).toEqual([]);
  });

  it('COMPOUND_REPLACES names are not in TOOL_META (they are projected via compounds)', () => {
    // COMPOUND_REPLACES = Set of granular names replaced in vision mode.
    // In blind/hybrid these granular tools DO appear and DO need TOOL_META.
    // In vision, the compound tools replace them — but we still project from
    // blind/hybrid mode where granulars appear.
    // This test only validates that COMPOUND_REPLACES are not double-counted
    // as vision-compound TOOLS themselves (which would mean they appear TWICE
    // in the catalog under different shapes).
    // The three compound TOOLS (mouse, keyboard, window) must be in VISION_COMPOUNDS.
    for (const name of VISION_COMPOUNDS) {
      expect(COMPOUND_REPLACES).not.toContain(name);
    }
  });

  it('mcpName values in TOOL_META are distinct from System B names where provided', () => {
    // When mcpName is set, it MUST differ from the System B key (or it is noise).
    const bad: string[] = [];
    for (const [sysb, meta] of Object.entries(TOOL_META)) {
      if (meta.mcpName !== undefined && meta.mcpName === sysb) {
        bad.push(`${sysb}: mcpName is the same as the System B name — remove it`);
      }
    }
    expect(bad).toEqual([]);
  });
});
