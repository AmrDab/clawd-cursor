/**
 * agent-tools tests — exercises the MCP tools that wrap the autonomous
 * Agent (submit_task, abort_task, agent_status, screenshot_full,
 * task_logs_*, learn_app, submit_report, logs_recent, favorites_*).
 *
 * These tools are the v0.9 PR7.2 replacements for the legacy REST routes;
 * they share the same shape with REST so dashboard rewires are mechanical.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock heavy native deps ───────────────────────────────────────────────
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
    toBuffer: vi.fn().mockResolvedValue(Buffer.from('fake-png')),
  })),
}));

import { getAgentTools } from '../tools/agent';
import { getFavoritesTools } from '../tools/favorites';
import { getExtraTools } from '../tools/extras';
import type { ToolContext } from '../tools/registry';

// Minimal in-memory favorites store for the tests.
let favStore: string[] = [];
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: (p: string) => {
      if (typeof p === 'string' && p.includes('favorites')) return favStore.length > 0;
      return actual.existsSync(p);
    },
    readFileSync: ((p: any, enc?: any) => {
      if (typeof p === 'string' && p.includes('favorites')) {
        return JSON.stringify(favStore);
      }
      return (actual.readFileSync as any)(p, enc);
    }) as any,
    writeFileSync: ((p: any, data: any, ..._rest: any[]) => {
      if (typeof p === 'string' && p.includes('favorites')) {
        favStore = JSON.parse(String(data));
        return;
      }
      return (actual.writeFileSync as any)(p, data, ..._rest);
    }) as any,
  };
});

// ── Helpers ──────────────────────────────────────────────────────────────

function findTool(tools: any[], name: string) {
  const t = tools.find(x => x.name === name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t;
}

function makeFakeAgent(overrides: any = {}): any {
  return {
    getState: vi.fn(() => ({ status: 'idle', stepsCompleted: 0, stepsTotal: 0 })),
    executeTask: vi.fn(async () => ({ success: true, steps: [], duration: 0 })),
    abort: vi.fn(),
    ...overrides,
  };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    desktop: {
      captureForLLM: vi.fn(async () => ({
        buffer: Buffer.from('JPEG_BYTES'),
        scaleFactor: 1,
        llmWidth: 1280,
        llmHeight: 720,
        // Real captureForLLM returns the configured capture format
        // ('jpeg' by default; 'png' when CLAWD_SCREENSHOT_FORMAT=png).
        // Include it in the mock so screenshot_full's mimeType / meta.format
        // assertions match the real shape.
        format: 'jpeg',
      })),
    } as any,
    a11y: {} as any,
    cdp: {} as any,
    platform: undefined,
    getMouseScaleFactor: () => 1,
    getScreenshotScaleFactor: () => 1,
    ensureInitialized: async () => {},
    ...overrides,
  };
}

// ── submit_task ──────────────────────────────────────────────────────────

describe('agent tools — submit_task', () => {
  const tools = getAgentTools();

  it('rejects when no agent is attached (stdio MCP)', async () => {
    const tool = findTool(tools, 'submit_task');
    const result = await tool.handler({ task: 'open notepad' }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/no autonomous agent/i);
  });

  it('rejects empty tasks', async () => {
    const tool = findTool(tools, 'submit_task');
    const ctx = makeCtx({ agent: makeFakeAgent() });
    const result = await tool.handler({ task: '' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/non-empty/);
  });

  it('rejects when agent is busy', async () => {
    const tool = findTool(tools, 'submit_task');
    const agent = makeFakeAgent({
      getState: vi.fn(() => ({ status: 'thinking', stepsCompleted: 0, stepsTotal: 0 })),
    });
    const ctx = makeCtx({ agent });
    const result = await tool.handler({ task: 'open notepad' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/busy/);
    expect(agent.executeTask).not.toHaveBeenCalled();
  });

  it('accepts a valid task and fires executeTask', async () => {
    const tool = findTool(tools, 'submit_task');
    const agent = makeFakeAgent();
    const ctx = makeCtx({ agent });
    const result = await tool.handler({ task: 'open notepad' }, ctx);
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.text);
    expect(parsed.accepted).toBe(true);
    expect(parsed.task).toBe('open notepad');
    expect(agent.executeTask).toHaveBeenCalledWith('open notepad');
  });
});

// ── abort_task & agent_status ────────────────────────────────────────────

describe('agent tools — abort_task / agent_status', () => {
  const tools = getAgentTools();

  it('abort_task signals the agent', async () => {
    const tool = findTool(tools, 'abort_task');
    const agent = makeFakeAgent();
    const result = await tool.handler({}, makeCtx({ agent }));
    expect(JSON.parse(result.text).aborted).toBe(true);
    expect(agent.abort).toHaveBeenCalled();
  });

  it('abort_task with no agent returns isError', async () => {
    const tool = findTool(tools, 'abort_task');
    const result = await tool.handler({}, makeCtx());
    expect(result.isError).toBe(true);
  });

  it('agent_status returns daemon state', async () => {
    const tool = findTool(tools, 'agent_status');
    const agent = makeFakeAgent({
      getState: () => ({ status: 'thinking', stepsCompleted: 2, stepsTotal: 5 }),
    });
    const result = await tool.handler({}, makeCtx({ agent }));
    expect(JSON.parse(result.text).status).toBe('thinking');
    expect(JSON.parse(result.text).stepsCompleted).toBe(2);
  });

  it('agent_status without agent returns no_agent sentinel', async () => {
    const tool = findTool(tools, 'agent_status');
    const result = await tool.handler({}, makeCtx());
    expect(JSON.parse(result.text).status).toBe('no_agent');
  });
});

// ── screenshot_full ──────────────────────────────────────────────────────

describe('agent tools — screenshot_full', () => {
  const tools = getAgentTools();

  it('captures the primary display and returns base64 image with matching mimeType', async () => {
    const tool = findTool(tools, 'screenshot_full');
    const ctx = makeCtx();
    const result = await tool.handler({}, ctx);
    expect(result.isError).toBeFalsy();
    // mimeType now follows the captured frame's format (jpeg default, png if
    // configured). The previous test asserted a hardcoded 'image/png' which
    // lied for the JPEG path; assert mimeType matches the meta `format`
    // field so the test stays correct regardless of capture config.
    expect(result.image?.mimeType).toMatch(/^image\/(png|jpeg)$/);
    expect(result.image?.data).toBeTruthy();
    const meta = JSON.parse(result.text);
    expect(meta.scaleFactor).toBe(1);
    expect(meta.llmWidth).toBe(1280);
    expect(meta.format).toMatch(/^(png|jpeg)$/);
    expect(result.image?.mimeType).toBe(`image/${meta.format}`);
  });
});

// ── task_logs_list / current ─────────────────────────────────────────────

describe('agent tools — task_logs_*', () => {
  const tools = getAgentTools();

  it('task_logs_list with no agent returns []', async () => {
    const result = await findTool(tools, 'task_logs_list').handler({}, makeCtx());
    expect(result.text).toBe('[]');
  });

  it('task_logs_current with no agent returns isError', async () => {
    const result = await findTool(tools, 'task_logs_current').handler({}, makeCtx());
    expect(result.isError).toBe(true);
  });
});

// ── favorites tools ──────────────────────────────────────────────────────

describe('favorites tools', () => {
  beforeEach(() => { favStore = []; });
  const tools = getFavoritesTools();

  it('favorites_list returns [] initially', async () => {
    const result = await findTool(tools, 'favorites_list').handler({}, makeCtx());
    expect(result.text).toBe('[]');
  });

  it('favorites_add inserts a starred task', async () => {
    const result = await findTool(tools, 'favorites_add').handler({ task: 'open chrome' }, makeCtx());
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.text);
    expect(parsed.ok).toBe(true);
    expect(parsed.favorites).toContain('open chrome');
  });

  it('favorites_add does not duplicate', async () => {
    favStore = ['open chrome'];
    const result = await findTool(tools, 'favorites_add').handler({ task: 'open chrome' }, makeCtx());
    const parsed = JSON.parse(result.text);
    expect(parsed.favorites.filter((s: string) => s === 'open chrome')).toHaveLength(1);
  });

  it('favorites_remove removes a starred task', async () => {
    favStore = ['open chrome', 'open notepad'];
    const result = await findTool(tools, 'favorites_remove').handler({ task: 'open chrome' }, makeCtx());
    const parsed = JSON.parse(result.text);
    expect(parsed.favorites).not.toContain('open chrome');
    expect(parsed.favorites).toContain('open notepad');
  });

  it('favorites_remove returns isError when missing', async () => {
    favStore = [];
    const result = await findTool(tools, 'favorites_remove').handler({ task: 'nope' }, makeCtx());
    expect(result.isError).toBe(true);
  });
});

// ── logs_recent / submit_report / learn_app ─────────────────────────────

describe('extras — daemon diagnostics', () => {
  const tools = getExtraTools();

  it('logs_recent returns [] when no log buffer is attached', async () => {
    const result = await findTool(tools, 'logs_recent').handler({}, makeCtx());
    expect(result.text).toBe('[]');
  });

  it('logs_recent returns the buffer when attached', async () => {
    const buf = [
      { timestamp: 1, level: 'info', message: 'hi' },
      { timestamp: 2, level: 'error', message: 'oops' },
    ];
    const result = await findTool(tools, 'logs_recent').handler({}, makeCtx({ getLogBuffer: () => buf }));
    expect(JSON.parse(result.text)).toHaveLength(2);
  });

  it('logs_recent honors limit', async () => {
    const buf = Array.from({ length: 50 }, (_, i) => ({
      timestamp: i, level: 'info', message: `msg-${i}`,
    }));
    const result = await findTool(tools, 'logs_recent').handler({ limit: 10 }, makeCtx({ getLogBuffer: () => buf }));
    expect(JSON.parse(result.text)).toHaveLength(10);
  });

});
