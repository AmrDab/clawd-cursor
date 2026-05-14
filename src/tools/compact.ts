/**
 * Compact MCP surface — 6 compound tools covering every granular
 * primitive, Anthropic-Computer-Use-style.
 *
 * Why this exists:
 *   An agent driving clawdcursor via MCP otherwise sees 93 granular
 *   tool schemas (~18,000 tokens of tool catalog). Most models
 *   over-think the choice, pick near-duplicates, and burn context.
 *   This file collapses the granular tools into 6 action-discriminated
 *   compound tools — the same "1 tool with N sub-actions" shape that
 *   Anthropic uses for computer_20250124.
 *
 *   Net effect: the LLM sees ~1,500 tokens of tool catalog, picks a
 *   COMPOUND first (which primitive SPACE do I want?), then an
 *   ACTION (which specific operation?), then fills in the args.
 *   Decision trees shrink, accuracy rises.
 *
 * The 6 compounds cover EXACTLY the granular tool set — no new
 * capability, no removed capability. Every compact action maps to
 * exactly one granular tool via the delegation table. The granular
 * surface stays available (same repo, same schemas); agents simply
 * pick which shape to consume.
 *
 * Selection:
 *   `clawdcursor mcp`             → 93 granular tools (back-compat)
 *   `clawdcursor mcp --compact`   → 6 compound tools (this file)
 *   GET /tools?mode=compact      → REST gets the same compact schemas
 *
 * Extending:
 *   Add a new granular tool → map it in the `ACTION_MAP` below under
 *   its owning compound. No other wiring needed; dispatcher picks it
 *   up automatically.
 */

import { getTool } from './registry';
import type { ToolDefinition, ToolContext, ToolResult } from './types';

// ─── Action → granular-tool delegation table ────────────────────────

/**
 * One row per compact sub-action.
 *
 *   compound:   which compound tool the LLM calls (computer/accessibility/…)
 *   action:     the enum value for that compound's `action` arg
 *   delegate:   the granular tool name to dispatch to
 *   argRemap:   optional — rename fields before handing off (e.g. the
 *               compound's `combo` → granular `key_press`'s `key`).
 */
interface ActionRoute {
  action: string;
  delegate: string;
  argRemap?: Record<string, string>;
}

const COMPUTER_ACTIONS: ActionRoute[] = [
  // Perception
  { action: 'screenshot', delegate: 'desktop_screenshot' },
  { action: 'screenshot_region', delegate: 'desktop_screenshot_region' },
  // Mouse
  { action: 'click',         delegate: 'mouse_click' },
  { action: 'double_click',  delegate: 'mouse_double_click' },
  { action: 'right_click',   delegate: 'mouse_right_click' },
  { action: 'middle_click',  delegate: 'mouse_middle_click' },
  { action: 'triple_click',  delegate: 'mouse_triple_click' },
  { action: 'hover',         delegate: 'mouse_hover' },
  { action: 'move',          delegate: 'mouse_hover' },       // alias
  { action: 'move_relative', delegate: 'mouse_move_relative' },
  { action: 'scroll',        delegate: 'mouse_scroll' },
  { action: 'scroll_horizontal', delegate: 'mouse_scroll_horizontal' },
  { action: 'drag',          delegate: 'mouse_drag' },
  { action: 'drag_path',     delegate: 'mouse_drag_stepped', argRemap: { path: 'path' } },
  { action: 'mouse_down',    delegate: 'mouse_down' },
  { action: 'mouse_up',      delegate: 'mouse_up' },
  // Keyboard — `combo` is the natural compound name for a key chord;
  // it remaps to the granular `key_press`'s `key` parameter (see argRemap
  // doc-comment above).
  { action: 'type',      delegate: 'type_text' },
  { action: 'key',       delegate: 'key_press', argRemap: { combo: 'key' } },
  { action: 'key_press', delegate: 'key_press', argRemap: { combo: 'key' } },
  { action: 'key_down',  delegate: 'key_down',  argRemap: { combo: 'key' } },
  { action: 'key_up',    delegate: 'key_up',    argRemap: { combo: 'key' } },
  // Flow
  { action: 'wait',      delegate: 'wait' },
];

const ACCESSIBILITY_ACTIONS: ActionRoute[] = [
  { action: 'read_tree',      delegate: 'read_screen' },
  { action: 'find',           delegate: 'find_element' },
  { action: 'get_element',    delegate: 'a11y_get_element' },
  { action: 'focused',        delegate: 'get_focused_element' },
  { action: 'invoke',         delegate: 'invoke_element' },
  { action: 'focus',          delegate: 'focus_element' },
  { action: 'set_value',      delegate: 'set_field_value' },
  { action: 'get_value',      delegate: 'a11y_get_value' },
  { action: 'expand',         delegate: 'a11y_expand' },
  { action: 'collapse',       delegate: 'a11y_collapse' },
  { action: 'toggle',         delegate: 'a11y_toggle' },
  { action: 'select',         delegate: 'a11y_select' },
  { action: 'state',          delegate: 'get_element_state' },
  { action: 'list_children',  delegate: 'a11y_list_children', argRemap: { name: 'parentName' } },
  { action: 'wait_for',       delegate: 'wait_for_element' },
];

const WINDOW_ACTIONS: ActionRoute[] = [
  { action: 'list',          delegate: 'get_windows' },
  { action: 'active',        delegate: 'get_active_window' },
  { action: 'focus',         delegate: 'focus_window' },
  { action: 'maximize',      delegate: 'maximize_window' },
  { action: 'minimize',      delegate: 'minimize_window_to_taskbar' },
  { action: 'restore',       delegate: 'restore_window' },
  { action: 'close',         delegate: 'close_window' },
  { action: 'resize',        delegate: 'resize_window' },
  { action: 'list_displays', delegate: 'list_displays' },
  { action: 'screen_size',   delegate: 'get_screen_size' },
  { action: 'open_app',      delegate: 'open_app' },
  { action: 'open_file',     delegate: 'open_file' },
  { action: 'open_url',      delegate: 'open_url' },
  { action: 'switch_tab',    delegate: 'switch_tab_os' },
  { action: 'navigate',      delegate: 'navigate_browser' },
];

const SYSTEM_ACTIONS: ActionRoute[] = [
  { action: 'clipboard_read',  delegate: 'read_clipboard' },
  { action: 'clipboard_write', delegate: 'write_clipboard' },
  { action: 'system_time',     delegate: 'get_system_time' },
  { action: 'ocr',             delegate: 'ocr_read_screen' },
  { action: 'undo',            delegate: 'undo_last' },
  { action: 'shortcuts_list',  delegate: 'shortcuts_list' },
  { action: 'shortcuts_run',   delegate: 'shortcuts_execute' },
  { action: 'delegate',        delegate: 'delegate_to_agent' },
  // v0.8.2 — Electron/WebView2 bridge
  { action: 'detect_webview',  delegate: 'detect_webview_apps' },
  { action: 'relaunch_with_cdp', delegate: 'relaunch_with_cdp' },
];

const BROWSER_ACTIONS: ActionRoute[] = [
  { action: 'connect',        delegate: 'cdp_connect' },
  { action: 'page_context',   delegate: 'cdp_page_context' },
  { action: 'read_text',      delegate: 'cdp_read_text' },
  { action: 'click',          delegate: 'cdp_click' },
  { action: 'type',           delegate: 'cdp_type' },
  { action: 'select_option',  delegate: 'cdp_select_option' },
  { action: 'evaluate',       delegate: 'cdp_evaluate' },
  { action: 'wait_for',       delegate: 'cdp_wait_for_selector' },
  { action: 'list_tabs',      delegate: 'cdp_list_tabs' },
  { action: 'switch_tab',     delegate: 'cdp_switch_tab' },
  { action: 'scroll',         delegate: 'cdp_scroll' },
];

/**
 * Build the flat set of arg properties a compound exposes, merging
 * every delegate's parameter spec. `action` is always first and
 * required; everything else is optional (each sub-action enforces
 * its own required fields via the granular tool's validator).
 */
function buildCompoundSchema(
  routes: ActionRoute[],
): Record<string, import('./types').ParameterDef> {
  const schema: Record<string, import('./types').ParameterDef> = {
    action: {
      type: 'string',
      description: 'Which sub-action to perform. See this tool\'s description for the enum of valid values.',
      required: true,
      enum: routes.map(r => r.action),
    },
  };

  for (const route of routes) {
    const granular = getTool(route.delegate);
    if (!granular) continue; // Defensive: unknown delegate (shouldn't happen).
    for (const [pname, pdef] of Object.entries(granular.parameters)) {
      // Apply arg remapping — the compound exposes the REMAPPED name,
      // dispatcher un-maps back to the granular name at runtime.
      const remappedFrom = route.argRemap
        ? Object.entries(route.argRemap).find(([, v]) => v === pname)?.[0]
        : undefined;
      const targetName = remappedFrom ?? pname;
      if (targetName in schema) continue; // First delegate to declare a name wins.
      schema[targetName] = {
        ...pdef,
        required: false, // Every arg is optional on the compound — sub-actions enforce their own.
        description: pdef.description,
      };
    }
  }

  return schema;
}

/** Human-readable one-line list of actions for the tool description. */
function actionCatalog(routes: ActionRoute[]): string {
  return routes.map(r => r.action).join(', ');
}

// ─── Compound dispatcher ───────────────────────────────────────────

/**
 * Shared runtime: look up the granular tool for a compact (compound,
 * action) pair, optionally remap args, then hand off. Surfacing the
 * same ToolResult contract the granular tool returns.
 */
async function dispatchCompound(
  compoundName: string,
  routes: ActionRoute[],
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const actionName = String(args.action ?? '');
  if (!actionName) {
    return {
      text: `${compoundName}: "action" is required. Valid: ${actionCatalog(routes)}`,
      isError: true,
    };
  }
  const route = routes.find(r => r.action === actionName);
  if (!route) {
    return {
      text: `${compoundName}: unknown action "${actionName}". Valid: ${actionCatalog(routes)}`,
      isError: true,
    };
  }
  const granular = getTool(route.delegate);
  if (!granular) {
    return { text: `${compoundName}: delegate "${route.delegate}" not registered`, isError: true };
  }

  // Strip the `action` key + apply any remapping before forwarding.
  const { action: _a, ...rest } = args;
  const forwarded: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) {
    const mapped = route.argRemap?.[k] ?? k;
    forwarded[mapped] = v;
  }

  return granular.handler(forwarded, ctx);
}

// ─── Tool definitions ──────────────────────────────────────────────

export function getCompactTools(): ToolDefinition[] {
  return [
    {
      name: 'computer',
      description:
        'Direct mouse/keyboard/screenshot control (Anthropic Computer-Use style). ' +
        `Pick an action: ${actionCatalog(COMPUTER_ACTIONS)}. ` +
        'Coordinates are image-space pixels from the most recent screenshot. ' +
        'Prefer `accessibility` for named targets; use `computer` only when you need pixel-level control.',
      parameters: buildCompoundSchema(COMPUTER_ACTIONS),
      category: 'orchestration',
      safetyTier: 1,
      handler: (args, ctx) => dispatchCompound('computer', COMPUTER_ACTIONS, args, ctx),
    },

    {
      name: 'accessibility',
      description:
        'Interact with the OS accessibility tree — read element names, find by name/role, invoke, toggle, expand/collapse, set value, query state. ' +
        `Pick an action: ${actionCatalog(ACCESSIBILITY_ACTIONS)}. ` +
        'Always preferred over `computer.click(x,y)` when the target has a name — more reliable across DPI, window resize, layout shifts.',
      parameters: buildCompoundSchema(ACCESSIBILITY_ACTIONS),
      category: 'perception',
      safetyTier: 0,
      handler: (args, ctx) => dispatchCompound('accessibility', ACCESSIBILITY_ACTIONS, args, ctx),
    },

    {
      name: 'window',
      description:
        'Window, app, and display management. Open/focus/maximize/minimize/restore/close/resize windows; enumerate displays; switch browser tabs at the OS level; open apps/files/URLs. ' +
        `Pick an action: ${actionCatalog(WINDOW_ACTIONS)}.`,
      parameters: buildCompoundSchema(WINDOW_ACTIONS),
      category: 'window',
      safetyTier: 1,
      handler: (args, ctx) => dispatchCompound('window', WINDOW_ACTIONS, args, ctx),
    },

    {
      name: 'system',
      description:
        'System integration — clipboard read/write, system time, OCR screen-reading, undo shortcut, named shortcuts registry, delegate to a sub-agent. ' +
        `Pick an action: ${actionCatalog(SYSTEM_ACTIONS)}.`,
      parameters: buildCompoundSchema(SYSTEM_ACTIONS),
      category: 'orchestration',
      safetyTier: 1,
      handler: (args, ctx) => dispatchCompound('system', SYSTEM_ACTIONS, args, ctx),
    },

    {
      name: 'browser',
      description:
        'Chrome DevTools Protocol control — operates on DOM elements by CSS selector rather than screen pixels. Requires Chrome/Edge launched with remote debugging (see `cdp_connect`). Much more reliable than `computer` for web automation. ' +
        `Pick an action: ${actionCatalog(BROWSER_ACTIONS)}.`,
      parameters: buildCompoundSchema(BROWSER_ACTIONS),
      category: 'browser',
      safetyTier: 1,
      handler: (args, ctx) => dispatchCompound('browser', BROWSER_ACTIONS, args, ctx),
    },

    {
      name: 'task',
      description:
        'Hand clawdcursor a WHOLE natural-language task and let its internal pipeline decide how to execute it (router → blind agent → hybrid → vision fallback). ' +
        'Use this when you don\'t want to micromanage every primitive — clawdcursor decomposes the task, picks the cheapest execution path, and returns a trace. ' +
        'The `computer`/`accessibility`/`window`/`system`/`browser` compounds are for when you want step-level control yourself.',
      parameters: {
        instruction: {
          type: 'string',
          description: 'Natural-language task description, e.g. "open Notepad and type hello", "go to github.com", "send email in Outlook".',
          required: true,
        },
      },
      category: 'orchestration',
      safetyTier: 1,
      handler: (args, ctx) => dispatchCompound('task', [
        { action: '__task__', delegate: 'delegate_to_agent', argRemap: { instruction: 'task' } },
      ], { action: '__task__', ...args }, ctx),
    },
  ];
}

/** Names of all compact tools (for tier + doc lookups). */
export const COMPACT_TOOL_NAMES = ['computer', 'accessibility', 'window', 'system', 'browser', 'task'] as const;
