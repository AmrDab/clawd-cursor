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
import { getAgentTools } from './agent';
import { getFavoritesTools } from './favorites';
import { getSchedulerTools } from './scheduler';
import { getIntrospectionTools } from './introspection';
import type { ToolDefinition, ToolContext, ToolResult, CompactGroup } from './types';
import { toOpenAiFunctions, toJsonSchema } from './types';

export type { ToolDefinition, ToolContext, ToolResult };
export { toOpenAiFunctions, toJsonSchema };
export { getCompactTools };

/** Options for the unified getTools() accessor. */
export interface GetToolsOptions {
  /**
   * Which surface to return.
   *   'granular' — the full set of granular primitives (default)
   *   'compact'  — the 6 compound tools (same as getCompactSurface())
   */
  palette?: 'granular' | 'compact';
  /**
   * Filter granular tools by their compactGroup.
   * Only meaningful when palette === 'granular' (or omitted).
   */
  compactGroup?: CompactGroup;
}

/**
 * Unified tool accessor. Replaces the ad-hoc getAllTools() /
 * getCompactSurface() pair — those remain as thin back-compat wrappers.
 *
 * Examples:
 *   getTools()                                  → all granular tools
 *   getTools({ palette: 'compact' })            → 6 compact compound tools
 *   getTools({ compactGroup: 'computer' })      → granular tools owned by computer
 *   getTools({ palette: 'granular', compactGroup: 'accessibility' })
 */
// The granular tool definitions are static (built from module-level
// get*Tools() functions, no runtime registration), so assemble the array
// once and reuse it. Before this, every getTool()/getTools() call rebuilt
// the whole 14-source array — and getTool() is on the hot dispatch path.
let _granularCache: ToolDefinition[] | null = null;
function granularTools(): ToolDefinition[] {
  if (_granularCache === null) {
    _granularCache = [
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
      ...getAgentTools(),
      ...getFavoritesTools(),
      ...getSchedulerTools(),
      ...getIntrospectionTools(),
    ];
  }
  return _granularCache;
}

export function getTools(options?: GetToolsOptions): ToolDefinition[] {
  const palette = options?.palette ?? 'granular';

  if (palette === 'compact') {
    return getCompactTools();
  }

  const all = granularTools();

  if (options?.compactGroup) {
    return all.filter(t => t.compactGroup === options.compactGroup);
  }

  // Return a shallow copy so callers can't mutate the cached array.
  return all.slice();
}

/** Get all registered GRANULAR tools (the full primitive surface). Back-compat wrapper around getTools(). */
export function getAllTools(): ToolDefinition[] {
  return getTools();
}

/**
 * Get the COMPACT surface — 6 compound tools covering every granular
 * primitive. Equivalent semantics; ~1/12th the catalog tokens. Use via
 * `clawdcursor mcp --compact` or `GET /tools?mode=compact`.
 * Back-compat wrapper around getTools({ palette: 'compact' }).
 */
export function getCompactSurface(): ToolDefinition[] {
  return getTools({ palette: 'compact' });
}

/** Get tools by category */
export function getToolsByCategory(category: string): ToolDefinition[] {
  return getAllTools().filter(t => t.category === category);
}

/** Get a tool by name */
export function getTool(name: string): ToolDefinition | undefined {
  // Search the cached array directly — no copy, no rebuild (hot path).
  return granularTools().find(t => t.name === name);
}
