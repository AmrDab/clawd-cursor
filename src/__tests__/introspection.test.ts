/**
 * Introspection tool — get_system_prompt exercises.
 *
 * The full 4-tool surface (get_app_guide, detect_app, classify_task) has been
 * removed with the pipeline cluster. Only get_system_prompt remains.
 */

import { describe, it, expect } from 'vitest';
import { getIntrospectionTools } from '../tools/introspection';
import type { ToolContext } from '../tools/types';

function findTool(name: string) {
  const t = getIntrospectionTools().find(t => t.name === name);
  if (!t) throw new Error('tool not found: ' + name);
  return t;
}

function makeCtx(): ToolContext {
  return {
    desktop: null, a11y: null, cdp: null,
    getMouseScaleFactor: () => 1,
    getScreenshotScaleFactor: () => 1,
    ensureInitialized: async () => {},
  } as unknown as ToolContext;
}

describe('introspection — tool surface', () => {
  it('exposes exactly get_system_prompt in the system compound at tier 0', () => {
    const tools = getIntrospectionTools();
    expect(tools.map(t => t.name).sort()).toEqual(['get_system_prompt']);
    for (const t of tools) {
      expect(t.compactGroup).toBe('system');
      expect(t.safetyTier).toBe(0);
      expect(t.category).toBe('orchestration');
    }
  });
});

describe('get_system_prompt', () => {
  it('returns a populated prompt for the default (hybrid) mode', async () => {
    const r = await findTool('get_system_prompt').handler({}, makeCtx());
    const out = JSON.parse(r.text);
    expect(out.mode).toBe('hybrid');
    expect(typeof out.prompt).toBe('string');
    expect(out.prompt.length).toBeGreaterThan(500);
    // Should contain the v0.9 web-service policy section.
    expect(out.prompt).toMatch(/WEB-SERVICE POLICY/i);
  });

  it('switches phrasing for vision mode', async () => {
    const hybrid = JSON.parse((await findTool('get_system_prompt').handler({ mode: 'hybrid' }, makeCtx())).text).prompt;
    const vision = JSON.parse((await findTool('get_system_prompt').handler({ mode: 'vision' }, makeCtx())).text).prompt;
    expect(hybrid).not.toBe(vision);
    expect(vision).toMatch(/initial screenshot/i);
  });

  it('returns blind mode when requested', async () => {
    const r = await findTool('get_system_prompt').handler({ mode: 'blind' }, makeCtx());
    const out = JSON.parse(r.text);
    expect(out.mode).toBe('blind');
    expect(out.prompt).toMatch(/BLIND/i);
  });

  it('coerces unknown mode to hybrid', async () => {
    const r = await findTool('get_system_prompt').handler({ mode: 'bogus' }, makeCtx());
    expect(JSON.parse(r.text).mode).toBe('hybrid');
  });
});
