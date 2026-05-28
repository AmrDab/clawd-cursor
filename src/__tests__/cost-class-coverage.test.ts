/**
 * Coverage test for `ToolDefinition.costClass`.
 *
 * Phase A introduces `costClass` as an OPTIONAL field on tool definitions
 * so the rollout can land in batches. This test runs in WARN mode today:
 * it never fails, it just emits a console line listing tools that still
 * lack a `costClass`. Once every tool is annotated, flip the bottom
 * `expect(missing.length).toBe(0)` block from `it.skip` to `it` and the
 * coverage becomes enforced.
 *
 * Compound dispatcher tools (compactGroup-as-tool: `computer`,
 * `accessibility`, `window`, `system`, `browser`, `task`) are exempt —
 * their cost varies per-action and they intentionally leave costClass
 * undefined. The exemption list is below; if a compound tool is added,
 * extend it.
 */
import { describe, it, expect } from 'vitest';
import { getAllTools } from '../tools/registry';
import type { ToolCostClass } from '../tools/types';

const COMPOUND_EXEMPTIONS = new Set([
  'computer', 'accessibility', 'window', 'system', 'browser', 'task',
]);

const VALID_CLASSES: ToolCostClass[] = ['act', 'inspect', 'perceive-text', 'perceive-image'];

describe('costClass coverage (Phase A — warn mode)', () => {
  const tools = getAllTools();

  it('every assigned costClass is one of the valid string literals', () => {
    const invalid = tools
      .filter(t => t.costClass !== undefined)
      .filter(t => !VALID_CLASSES.includes(t.costClass as ToolCostClass));
    expect(invalid.map(t => `${t.name} -> ${t.costClass}`)).toEqual([]);
  });

  it('every cheaperAlternatives entry references an existing tool', () => {
    const knownNames = new Set(tools.map(t => t.name));
    const bad: string[] = [];
    for (const t of tools) {
      for (const alt of t.cheaperAlternatives ?? []) {
        if (!knownNames.has(alt)) bad.push(`${t.name}.cheaperAlternatives -> "${alt}" (unknown)`);
      }
    }
    expect(bad).toEqual([]);
  });

  // Warn-mode: report progress, never fail. Flip to `it(...)` and the
  // toBe(0) assertion below to enforce.
  it('reports missing costClass coverage', () => {
    const missing = tools
      .filter(t => !COMPOUND_EXEMPTIONS.has(t.name))
      .filter(t => t.costClass === undefined)
      .map(t => t.name);
    const total = tools.length - COMPOUND_EXEMPTIONS.size;
    const covered = total - missing.length;
    // Surface progress on every test run without failing CI.
    // eslint-disable-next-line no-console
    console.log(`[cost-class-coverage] ${covered}/${total} tools annotated. ${missing.length === 0 ? 'COMPLETE — flip the assertion below to enforce.' : `Missing: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ` (+${missing.length - 10} more)` : ''}`}`);
    // Phase-A guarantee only — once back-fill is complete, swap to .toBe(0).
    expect(missing.length).toBeGreaterThanOrEqual(0);
  });
});
