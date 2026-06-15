#!/usr/bin/env node
/**
 * Back-compat entry point — DO NOT add logic here.
 *
 * v0.x published the CLI at `dist/index.js`. v1.0 moved the real entry to
 * `dist/surface/cli.js` (see package.json "bin"). Some users had hard-pinned
 * `node <pkg>/dist/index.js <args>` into an MCP host config — e.g. Claude
 * Code's `.claude.json` — and a routine `npm i -g clawdcursor` upgrade then
 * silently broke their launch, because the file they pointed at no longer
 * existed. The MCP server simply failed to start with no obvious cause.
 *
 * This shim re-runs the real CLI so those pinned paths keep working across the
 * move. `surface/cli` calls `program.parse()` on load, so importing it here is
 * enough — the original `process.argv` flows straight through.
 *
 * New configs should launch the `clawdcursor` bin directly
 * (`"command": "clawdcursor", "args": ["mcp", "--compact"]`) or install the
 * Claude Code plugin, both of which resolve through npm and never pin a deep
 * dist path. See README.md / SKILL.md.
 */
import './surface/cli';
