/**
 * Tool Registry — central registry of all clawdcursor tools.
 *
 * Import this to get all 40 tools in a transport-agnostic format.
 * Adapters (HTTP, MCP) consume this registry.
 */

import { getDesktopTools } from './desktop';
import { getA11yTools } from './a11y';
import { getCdpTools } from './cdp';
import { getOrchestrationTools } from './orchestration';
import { getShortcutTools } from './shortcuts';
import { getOcrTools } from './ocr';
import { getSmartTools } from './smart';
import { getExtraTools } from './extras';
import { getA11yDepthTools } from './a11y_depth';
import { getElectronBridgeTools } from './electron_bridge';
import { getCompactTools } from './compact';
import type { ToolDefinition, ToolContext, ToolResult } from './types';
import { toOpenAiFunctions, toJsonSchema } from './types';

export type { ToolDefinition, ToolContext, ToolResult };
export { toOpenAiFunctions, toJsonSchema };
export { getCompactTools };

/** Get all registered GRANULAR tools (the 74-tool surface). */
export function getAllTools(): ToolDefinition[] {
  return [
    ...getDesktopTools(),
    ...getA11yTools(),
    ...getCdpTools(),
    ...getOrchestrationTools(),
    ...getShortcutTools(),
    ...getOcrTools(),
    ...getSmartTools(),
    ...getExtraTools(),
    ...getA11yDepthTools(),
    ...getElectronBridgeTools(),
  ];
}

/**
 * Get the COMPACT surface — 6 compound tools covering every granular
 * primitive. Equivalent semantics; ~1/12th the catalog tokens. Use via
 * `clawdcursor mcp --compact` or `GET /tools?mode=compact`.
 */
export function getCompactSurface(): ToolDefinition[] {
  return getCompactTools();
}

/** Get tools by category */
export function getToolsByCategory(category: string): ToolDefinition[] {
  return getAllTools().filter(t => t.category === category);
}

/** Get a tool by name */
export function getTool(name: string): ToolDefinition | undefined {
  return getAllTools().find(t => t.name === name);
}
