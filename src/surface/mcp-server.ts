/**
 * MCP Server — the single point of construction for clawdcursor's MCP
 * surface. Used by both the stdio transport (editor integrations like
 * Claude Code, Cursor, Windsurf) and the streamable-HTTP transport
 * (the long-running `clawdcursor agent` daemon).
 *
 * Why this module exists
 * ----------------------
 * Up to v0.8.x clawdcursor had two transports:
 *   - REST API in src/server.ts   (the daemon's /task /favorites /etc)
 *   - MCP stdio    in src/index.ts (the `mcp` subcommand, inline-built)
 *
 * v0.9 PR7 collapses those into a single MCP server with two transport
 * flavors. createMcpServer() is the registry-to-MCP adapter; the
 * transports are independent and either or both can be active.
 *
 * The HTTP transport is mounted on the existing Express app at /mcp,
 * with the same Bearer-token requireAuth middleware the REST routes used.
 * That keeps localhost-only auth invariants identical across transports.
 */

import type express from 'express';
import { VERSION } from './version';
import type { ToolContext, ToolDefinition } from '../tools/registry';
import { getAllTools, getCompactSurface } from '../tools/registry';
import { evaluateToolCall } from '../tools/safety-gate';

/** Options for createMcpServer. */
export interface CreateMcpServerOptions {
  /** When true, expose the 6-compound surface instead of granular. */
  compact?: boolean;
  /** Subsystem context every tool handler receives. */
  ctx: ToolContext;
}

/** A constructed MCP server with its registered tool count. */
export interface McpServerHandle {
  /** The configured McpServer instance — connect a transport via .connect(). */
  server: any;
  /** Number of tools registered (mirrors the surface size). */
  toolCount: number;
  /** Snapshot of the tools that were registered (in registration order). */
  tools: ToolDefinition[];
}

/**
 * Build a configured McpServer with all clawdcursor tools registered.
 *
 * The caller is responsible for connecting a transport via `server.connect(...)`.
 * Use `startMcpStdio` for editor integrations and `startMcpHttp` for the daemon.
 */
export async function createMcpServer(options: CreateMcpServerOptions): Promise<McpServerHandle> {
  const { compact, ctx } = options;
  // Dynamic import: the SDK is ESM and our build is CJS.
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js' as any);
  const { z } = await import('zod');

  // MCP `instructions` — sent once at the initialize handshake and injected
  // into the connecting agent's context. This is the only channel to tell an
  // integrating agent (Claude Code, Cursor, Windsurf, Zed, OpenClaw) HOW to
  // use clawdcursor cheaply. Without it, agents drive the raw GUI tools with
  // their own premium model — the expensive path — and never discover the
  // local fallback pipeline. The guidance differs by mode: only the daemon
  // (HTTP) context has a live agent, so only it can offer `task`.
  const instructions = ctx.agent
    ? // Daemon / HTTP MCP — the cheap local pipeline is available.
      'clawdcursor is a local desktop-automation execution layer. PREFER the ' +
      '`task` tool: it runs the full perceive→act→verify loop locally on a ' +
      'cheap model, so you spend almost no tokens driving the GUI yourself. ' +
      'Fall back to the granular tools only when you need fine-grained control. ' +
      'Every tool name carries a token-cost class — order of preference is ' +
      '[act] < [inspect] < [perceive-text] < [perceive-image]: act and read the ' +
      'accessibility tree before you reach for a screenshot.'
    : // Stdio MCP (editor integration) — no pipeline; you drive the tools.
      'clawdcursor is a local desktop-automation tool layer. You drive the tools ' +
      'yourself. To minimize tokens, follow the cost-class prefix on each tool — ' +
      '[act] < [inspect] < [perceive-text] < [perceive-image]: prefer direct ' +
      'actions and accessibility reads; capture a screenshot ([perceive-image]) ' +
      'only when the accessibility tree is empty. For fully autonomous, ' +
      'low-cost execution, start the daemon (`clawdcursor agent`) and use the ' +
      '`task` tool — it runs a local cheap-model pipeline instead of your model.';

  const server = new McpServer({ name: 'clawdcursor', version: VERSION }, { instructions });
  const tools = compact ? getCompactSurface() : getAllTools();

  for (const tool of tools) {
    // Convert parameter defs to a Zod schema map. The MCP SDK uses zod
    // shape objects (Record<string, ZodType>) — not full ZodObjects.
    const zodParams: Record<string, any> = {};
    for (const [key, def] of Object.entries(tool.parameters)) {
      let schema: any;
      if (def.type === 'number') schema = z.number();
      else if (def.type === 'boolean') schema = z.boolean();
      else schema = z.string();
      if (def.enum) schema = z.enum(def.enum as [string, ...string[]]);
      schema = schema.describe(def.description);
      if (def.required === false) schema = schema.optional();
      zodParams[key] = schema;
    }

    // MCP SDK 1.29 arg parsing breaks if schema is undefined (shifts callback
    // position). Always pass a schema — use empty object for parameterless tools.
    const hasParams = Object.keys(zodParams).length > 0;
    // Phase A: surface the token-cost class to the tool-picking LLM. The
    // high-level SDK `server.tool()` API has no slot for a vendor metadata
    // field, so a `[costClass]` description prefix is the reliable
    // LLM-readable channel in tools/list. `costClass` in source stays the
    // single source of truth; the prefix is rendered only at this projection.
    const description = tool.costClass
      ? `[${tool.costClass}] ${tool.description}`
      : tool.description;
    server.tool(
      tool.name,
      description,
      hasParams ? zodParams : {},
      async (params: any) => {
        const safetyError = evaluateToolCall(tool, params ?? {});
        if (safetyError) {
          return { content: [{ type: 'text', text: safetyError.text }], isError: true };
        }
        const result = await tool.handler(params, ctx);
        const content: any[] = [];
        if (result.image) {
          content.push({ type: 'image', data: result.image.data, mimeType: result.image.mimeType });
        }
        content.push({ type: 'text', text: result.text });
        return { content, isError: result.isError };
      },
    );
  }

  return { server, toolCount: tools.length, tools };
}

/**
 * Start the stdio MCP transport. Used by `clawdcursor mcp` for editor
 * integrations (Claude Code, Cursor, Windsurf, Zed). Stdout becomes the
 * protocol channel; logs must already be redirected to stderr by the
 * caller.
 */
export async function startMcpStdio(server: any): Promise<void> {
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js' as any);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/**
 * Mount the streamable HTTP MCP transport on an Express app at /mcp.
 *
 * Mounts both POST (JSON-RPC requests) and GET (SSE notifications), plus
 * DELETE for session termination. Returns the underlying transport so the
 * caller can close it on shutdown.
 *
 * Auth — the caller must apply Bearer-token middleware before this route
 * (mirrors the REST surface's requireAuth). We don't apply auth here so
 * tests and agent-mode can share the same mount with their own gate.
 */
export async function startMcpHttp(
  server: any,
  app: express.Express,
  mountPath: string = '/mcp',
): Promise<{ close: () => Promise<void> }> {
  const { StreamableHTTPServerTransport } = await import(
    '@modelcontextprotocol/sdk/server/streamableHttp.js' as any
  );

  // Stateless mode: each POST is independent — no session init handshake
  // required. This makes the dashboard, `clawdcursor task` CLI, and
  // delegate_to_agent tool work as one-shot JSON-RPC clients without
  // needing to initialize and track an Mcp-Session-Id per call.
  //
  // CRITICAL: in stateless mode the SDK requires a FRESH transport per
  // HTTP request — a single shared transport accumulates per-request
  // state (response writers, in-flight message correlation) and
  // returns 500 on every call after the first. The pattern we use
  // here matches the MCP SDK's stateless example:
  //   for each request:
  //     1) construct a new transport
  //     2) server.connect(transport)
  //     3) transport.handleRequest(req, res, req.body)
  //     4) on response close → transport.close()
  //
  // This is per-request boilerplate, not per-connection — there's
  // still one McpServer (and one tool registry) for the whole daemon.
  // `enableJsonResponse: true` makes the SDK serialize tools/call results as
  // plain JSON-RPC instead of SSE (`event: message\ndata: {...}`). Without
  // this, MCP clients that expect a single JSON body (Claude Code's MCP
  // client among them) blow up with `Unexpected token 'e', "event: mes"...`
  // because the SDK defaults to text/event-stream for everything. We don't
  // need streaming progress here — `submit_task` is the only long-running
  // call, and even there a single final JSON response is the cleaner
  // contract for callers. Editor hosts that DO want streaming use stdio
  // MCP which has its own framing.
  const newTransport = () => new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  const handle = async (req: any, res: any, body?: unknown) => {
    const transport = newTransport();
    res.on('close', () => {
      // Best-effort cleanup whenever the response ends, errors out, or the
      // client disconnects mid-stream.
      try { void transport.close(); } catch { /* swallow */ }
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({ error: `MCP transport error: ${(err as Error).message}` });
      }
    }
  };

  // POST /mcp — JSON-RPC requests. Express has already parsed the body
  // via express.json(); pass it through so the SDK doesn't re-read req.
  app.post(mountPath, (req, res) => { void handle(req, res, req.body); });

  // GET /mcp — SSE channel for server-initiated notifications.
  app.get(mountPath, (req, res) => { void handle(req, res); });

  // DELETE /mcp — explicit session termination (no-op in stateless).
  app.delete(mountPath, (req, res) => { void handle(req, res); });

  return {
    close: async () => {
      // Per-request transports clean themselves up on response close;
      // nothing global to tear down.
    },
  };
}
