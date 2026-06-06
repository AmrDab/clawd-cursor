/**
 * Unified-agent tool catalog.
 *
 * ONE tool vocabulary across blind / hybrid / vision modes. The only
 * difference between modes: in `blind`, the `screenshot` tool is removed
 * from the catalog before the LLM sees it.
 *
 * Design rules:
 *   - Every mutation goes through PlatformAdapter (OS-agnostic).
 *   - NO ctx.platform call happens outside a tool's `execute()` — the agent
 *     loop never touches the adapter directly.
 *   - Terminal actions (`done` / `give_up` / `cannot_read`) just return
 *     `stop: true` with a terminalExit tag; the agent loop decides the
 *     AgentResult.
 *   - a11y-first wording. `invoke_element` and `set_field_value` are the
 *     preferred targeting tools; coord clicks are the fallback.
 *
 * Zero app-specific rules. A new LOB app works because a11y roles + the
 * rank-before-truncate sense layer surface its buttons.
 */

import type { UnifiedTool, UnifiedToolResult, AgentToolContext } from './types';
import { buildBatchTool } from './batch-tool';
import { imageScale, scaleCoord } from './coord-scale';
import { ensureTargetForeground } from './focus-guard';
import { resolveAlias } from '../router/aliases';
import { resolveSchemeHandlerExecutable, launchHandlerAndVerify } from '../../platform/uri-handler';
import { OcrEngine, type OcrElement } from '../../platform/ocr-engine';
import { getEdgePaths, getChromePaths } from '../../llm/browser-config';

/** Lazy OCR singleton for the agent-loop perception tools (read_text, smart_click).
 *  Mirrors the pattern in src/tools/smart.ts. Construction never throws; the real
 *  availability check happens in isAvailable(). */
let _agentOcr: OcrEngine | null = null;
function getAgentOcr(): OcrEngine {
  if (!_agentOcr) _agentOcr = new OcrEngine();
  return _agentOcr;
}

/**
 * Hedging-language phrases that indicate the agent is GUESSING about
 * the task outcome instead of observing the actual screen state. Used
 * by the `done` tool to reject speculative evidence claims like
 * "the email should have been sent" — a real symptom from a Kimi run
 * where the agent typed in a stale window and never noticed.
 *
 * Patterns are word-boundary anchored where possible so we don't
 * false-positive on substrings (e.g., "shoulder" must not match
 * "should"). Multi-word phrases match contiguous whitespace.
 *
 * The list is short on purpose — only the unambiguous "I'm guessing"
 * phrases. Words like "looks", "shown", "displayed" are LEGITIMATE
 * concrete-observation language and stay allowed.
 */
const HEDGING_PATTERN = new RegExp(
  [
    // Modal verbs of uncertainty
    '\\bshould\\s+(?:have|be|now)\\b',
    '\\bshould\\s+(?:have\\s+been|be|now)\\b',
    '\\bshould\\b(?=\\s+\\w)',
    '\\bmight\\s+(?:have|be)\\b',
    '\\bmay\\s+have\\b',
    '\\bcould\\s+have\\b',
    '\\bprobably\\b',
    '\\blikely\\s+(?:has|have|is|was)\\b',
    // Speaker-uncertainty phrasings
    '\\bI\\s+think\\b',
    '\\bI\\s+believe\\b',
    '\\bI\\s+assume\\b',
    '\\bassuming\\b',
    '\\bif\\s+(?:successful|it\\s+worked|the\\s+\\w+\\s+worked)\\b',
    // Approximate observation
    '\\bappears?\\s+to\\b',
    '\\bseems?\\s+to\\b',
    '\\bpresumably\\b',
  ].join('|'),
  'i',
);

/**
 * Build the unified tool catalog per mode + capability.
 *
 * Modes:
 *   - 'blind'  → text-LLM; no `screenshot` tool in catalog
 *   - 'hybrid' → text-LLM; `screenshot` tool available on demand
 *   - 'vision' → vision-LLM; COMPOUND TOOL FORM (mouse/keyboard/window
 *                as action-discriminated schemas à la Anthropic
 *                computer_20250124) + perception + a11y + terminals
 *
 * Capability (text modes only):
 *   - When supplied and non-'general', filter to the scoped palette
 *     defined in `palettes.ts`. Typical palette ≈ 6–10 tools.
 *   - 'general' / undefined → full text-agent catalog (back-compat).
 *
 * Terminal actions (`done`, `give_up`, `cannot_read`) are always
 * present regardless of mode/capability — the agent must always have
 * an exit door.
 */
export function buildUnifiedTools(): UnifiedTool[] {
  const tools: UnifiedTool[] = [
    // ─── PERCEPTION ─────────────────────────────────────────────
    {
      name: 'read_screen',
      description: 'START HERE — cheapest perception. Read the accessibility tree of the focused window: buttons, inputs, text elements with coordinates. The snapshot is auto-attached each turn; call this again only when you expect the screen changed since the last turn. If the tree is empty, escalate to read_text (OCR) next, then screenshot only as a last resort.',
      inputSchema: {
        type: 'object',
        properties: {
          processId: { type: 'number', description: 'Optional: limit to a specific process' },
        },
        additionalProperties: false,
      },
      changesScreen: false,
      async execute(args, ctx) {
        const pid = typeof args.processId === 'number' ? args.processId : undefined;
        const tree = await ctx.platform.getUiTree(pid);
        if (tree.length === 0) {
          return { success: true, text: '(empty a11y tree — app may be custom-canvas)' };
        }
        const lines = tree.slice(0, 60).map(el =>
          `[${el.controlType || 'Element'}] "${el.name || ''}" @${el.bounds.x},${el.bounds.y} ${el.bounds.width}×${el.bounds.height}${el.value ? ` value="${el.value.slice(0, 40)}"` : ''}${el.focused ? ' [FOCUSED]' : ''}`,
        );
        const more = tree.length > 60 ? `\n… +${tree.length - 60} more` : '';
        return { success: true, text: `Fresh a11y (${tree.length} els):\n${lines.join('\n')}${more}` };
      },
    },

    {
      name: 'list_windows',
      description: 'List visible top-level windows with title, process, and bounds. Useful when the active window is wrong or missing.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      changesScreen: false,
      async execute(_args, ctx) {
        const windows = await ctx.platform.listWindows();
        const active = await ctx.platform.getActiveWindow();
        const lines = windows.slice(0, 20).map(w => {
          const isActive = active && w.processId === active.processId && w.title === active.title;
          return `${isActive ? '→' : ' '} [${w.processName}] "${w.title}" pid=${w.processId} ${w.bounds.width}×${w.bounds.height}`;
        });
        const more = windows.length > 20 ? `\n… +${windows.length - 20} more windows` : '';
        return { success: true, text: `Windows (${windows.length}):\n${lines.join('\n')}${more}` };
      },
    },

    // ─── A11Y ACTIONS (preferred) ───────────────────────────────
    {
      name: 'invoke_element',
      description: 'Click/activate a UI element by its accessibility name. MORE RELIABLE than coord clicks — use this when the snapshot shows a named target.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Accessibility name of the element' },
          automationId: { type: 'string', description: 'Element automation ID (more precise than name)' },
          controlType: { type: 'string', description: 'Optional role filter (Button, MenuItem, Tab, etc.)' },
          processId: { type: 'number', description: 'Optional: limit to a specific process' },
          action: {
            type: 'string',
            enum: ['click', 'set-value', 'get-value', 'focus', 'expand', 'collapse'],
            description: 'Action to perform (default: "click")',
          },
          value: { type: 'string', description: 'Value for set-value action' },
        },
        // `name` OR `automationId` must be supplied; neither is required at
        // the JSON-schema level — the execute() body guards the total absence.
        additionalProperties: false,
      },
      changesScreen: true,
      async execute(args, ctx) {
        // `automationId` is accepted for MCP backward-compat but the PlatformAdapter
        // invokeElement interface does not expose automationId filtering — it is used
        // only as a name alias when name is absent.
        const rawName = typeof args.name === 'string' ? args.name : '';
        const automationId = typeof args.automationId === 'string' ? args.automationId : undefined;
        const name = rawName || automationId || '';
        if (!name) {
          return { success: false, text: 'invoke_element: "name" or "automationId" is required (the accessibility name of the element to invoke).' };
        }
        const controlType = typeof args.controlType === 'string' ? args.controlType : undefined;
        const processId = typeof args.processId === 'number' ? args.processId : undefined;
        const VALID_ACTIONS = ['click', 'set-value', 'get-value', 'focus', 'expand', 'collapse'] as const;
        type PermittedAction = typeof VALID_ACTIONS[number];
        const rawAction = typeof args.action === 'string' ? args.action : 'click';
        const action: PermittedAction = (VALID_ACTIONS as readonly string[]).includes(rawAction)
          ? rawAction as PermittedAction
          : 'click';
        const value = typeof args.value === 'string' ? args.value : undefined;
        const res = await ctx.platform.invokeElement({ name, controlType, processId, action, value });
        await sleep(150);
        return {
          success: res.success,
          text: res.success
            ? (res.data && 'value' in (res.data as object) ? `Invoked "${name}" (${action}) → value: "${(res.data as any).value}"` : `Invoked "${name}" via a11y.`)
            : `a11y invoke "${name}" missed — element not found.`,
          targetLabel: name,
        };
      },
    },

    {
      name: 'set_field_value',
      description: 'Set an editable field\'s value directly via accessibility (more reliable than click+type for forms).',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Accessibility name of the field' },
          value: { type: 'string' },
          controlType: { type: 'string', description: 'Optional role filter (e.g. "Edit")' },
          processId: { type: 'number' },
        },
        required: ['name', 'value'],
        additionalProperties: false,
      },
      changesScreen: true,
      async execute(args, ctx) {
        const name = String(args.name ?? '');
        const value = String(args.value ?? '');
        const controlType = typeof args.controlType === 'string' ? args.controlType : undefined;
        const processId = typeof args.processId === 'number' ? args.processId : undefined;
        const res = await ctx.platform.invokeElement({ name, controlType, processId, action: 'set-value', value });
        await sleep(150);
        return {
          success: res.success,
          text: res.success ? `Set "${name}" = ${value.length} chars` : `Set "${name}" failed.`,
          targetLabel: name,
        };
      },
    },

    // ─── A11Y DEPTH (Tranche 2) ────────────────────────────────
    {
      name: 'a11y_expand',
      description: 'Expand a tree node / combo / disclosure by a11y name (UIA ExpandCollapsePattern, AX AXExpanded).',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          controlType: { type: 'string' },
          processId: { type: 'number' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      changesScreen: true,
      async execute(args, ctx) {
        const name = String(args.name ?? '');
        const res = await ctx.platform.invokeElement({
          name,
          controlType: typeof args.controlType === 'string' ? args.controlType : undefined,
          processId: await resolveAgentPid(args, ctx),
          action: 'expand',
        });
        return {
          success: res.success,
          text: res.success ? `Expanded "${name}".` : `Could not expand "${name}".`,
          targetLabel: name,
        };
      },
    },

    {
      name: 'a11y_collapse',
      description: 'Collapse a tree node / combo / disclosure by a11y name.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          controlType: { type: 'string' },
          processId: { type: 'number' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      changesScreen: true,
      async execute(args, ctx) {
        const name = String(args.name ?? '');
        const res = await ctx.platform.invokeElement({
          name,
          controlType: typeof args.controlType === 'string' ? args.controlType : undefined,
          processId: await resolveAgentPid(args, ctx),
          action: 'collapse',
        });
        return {
          success: res.success,
          text: res.success ? `Collapsed "${name}".` : `Could not collapse "${name}".`,
          targetLabel: name,
        };
      },
    },

    {
      name: 'a11y_toggle',
      description: 'Toggle a checkbox / switch / toggle-button by a11y name. Returns new state (On/Off/Indeterminate).',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          controlType: { type: 'string' },
          processId: { type: 'number' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      changesScreen: true,
      async execute(args, ctx) {
        const name = String(args.name ?? '');
        const res = await ctx.platform.invokeElement({
          name,
          controlType: typeof args.controlType === 'string' ? args.controlType : undefined,
          processId: await resolveAgentPid(args, ctx),
          action: 'toggle',
        });
        if (!res.success) return { success: false, text: `Could not toggle "${name}".`, targetLabel: name };
        const state = (res.data as any)?.toggleState ?? 'unknown';
        return { success: true, text: `Toggled "${name}" → ${state}.`, targetLabel: name };
      },
    },

    {
      name: 'a11y_select',
      description: 'Select a list item / tab / radio by a11y name (UIA SelectionItemPattern, AX AXSelected).',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          controlType: { type: 'string' },
          processId: { type: 'number' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      changesScreen: true,
      async execute(args, ctx) {
        const name = String(args.name ?? '');
        const res = await ctx.platform.invokeElement({
          name,
          controlType: typeof args.controlType === 'string' ? args.controlType : undefined,
          processId: await resolveAgentPid(args, ctx),
          action: 'select',
        });
        return {
          success: res.success,
          text: res.success ? `Selected "${name}".` : `Could not select "${name}".`,
          targetLabel: name,
        };
      },
    },

    {
      name: 'a11y_get_value',
      description: 'Read the current value of a named field (UIA ValuePattern / AX AXValue). Useful to verify before typing.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          controlType: { type: 'string' },
          processId: { type: 'number' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      changesScreen: false,
      async execute(args, ctx) {
        const name = String(args.name ?? '');
        const res = await ctx.platform.invokeElement({
          name,
          controlType: typeof args.controlType === 'string' ? args.controlType : undefined,
          processId: await resolveAgentPid(args, ctx),
          action: 'get-value',
        });
        if (!res.success) return { success: false, text: `"${name}" has no readable value.` };
        const value = (res.data as any)?.value ?? '';
        return { success: true, text: `"${name}" = "${truncate(String(value), 120)}"` };
      },
    },

    {
      name: 'get_element_state',
      description: 'Get state flags of a named element (focused/enabled/disabled/selected/busy/offscreen/expandable/expanded).',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          controlType: { type: 'string' },
          processId: { type: 'number' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      changesScreen: false,
      async execute(args, ctx) {
        const name = String(args.name ?? '');
        const hits = await ctx.platform.findElements({
          name,
          controlType: typeof args.controlType === 'string' ? args.controlType : undefined,
          processId: await resolveAgentPid(args, ctx),
        });
        if (hits.length === 0) return { success: false, text: `No element named "${name}".` };
        const el = hits[0];
        return {
          success: true,
          text: JSON.stringify({
            name: el.name,
            controlType: el.controlType,
            focused: el.focused ?? false,
            enabled: el.enabled ?? true,
            disabled: el.disabled ?? false,
            selected: el.selected ?? false,
            busy: el.busy ?? false,
            offscreen: el.offscreen ?? false,
            expandable: el.expandable ?? false,
            expanded: el.expanded ?? false,
          }),
        };
      },
    },

    // ─── INPUT (mouse) ──────────────────────────────────────────
    {
      name: 'click',
      description: 'Click at (x,y). Default coords come from the a11y snapshot (already screen-correct). If you read the target off the SCREENSHOT instead, pass space:"image" so the tool scales it. Prefer invoke_element when the target has an a11y name.',
      inputSchema: {
        type: 'object',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          button: { type: 'string', enum: ['left', 'right'] },
          count: { type: 'number', description: '1=single, 2=double' },
          space: COORD_SPACE_SCHEMA,
        },
        required: ['x', 'y'],
        additionalProperties: false,
      },
      changesScreen: true,
      async execute(args, ctx) {
        const { x: ix, y: iy, warning } = coerceCoord(args.x, args.y);
        if (!Number.isFinite(ix) || !Number.isFinite(iy)) {
          return { success: false, isError: true, text: `click: x/y must be finite numbers, got x=${JSON.stringify(args.x)} y=${JSON.stringify(args.y)}` };
        }
        const button = args.button === 'right' ? 'right' : 'left';
        const count = args.count === 2 ? 2 : 1;
        // SCALE: 'image' coords (read off the 1280-wide screenshot) → physical;
        // 'screen'/default (a11y coords, already physical) → pass through.
        const space = args.space === 'image' ? 'image' : 'screen';
        const scale = space === 'image' ? imageScale(ctx) : 1;
        const x = scaleCoord(ix, scale);
        const y = scaleCoord(iy, scale);
        const fg0 = await ctx.platform.getActiveWindow().catch(() => null);
        const raised = await ensureTargetForeground(ctx, fg0);
        const before = raised ? await ctx.platform.getActiveWindow().catch(() => null) : fg0;
        await ctx.platform.mouseClick(x, y, { button, count });
        await sleep(150);
        const after = await ctx.platform.getActiveWindow().catch(() => null);
        const note = warning ? ` (${warning})` : '';
        return { success: true, text: `Clicked ${button} x${count} at ${coordBreadcrumb(ix, iy, x, y, space, scale, ctx)}${raised}${focusBreadcrumb(before, after)}${note}` };
      },
    },

    {
      name: 'drag',
      description: 'Drag the mouse from (startX,startY) to (endX,endY). Used for selecting text, drawing, resizing.',
      inputSchema: {
        type: 'object',
        properties: {
          startX: { type: 'number' },
          startY: { type: 'number' },
          endX: { type: 'number' },
          endY: { type: 'number' },
          space: COORD_SPACE_SCHEMA,
        },
        required: ['startX', 'startY', 'endX', 'endY'],
        additionalProperties: false,
      },
      changesScreen: true,
      async execute(args, ctx) {
        const start = coerceCoord(args.startX, args.startY);
        const end = coerceCoord(args.endX, args.endY);
        if (![start.x, start.y, end.x, end.y].every(Number.isFinite)) {
          return { success: false, isError: true, text: `drag: startX/startY/endX/endY must be finite numbers, got ${JSON.stringify(args)}` };
        }
        const space = args.space === 'image' ? 'image' : 'screen';
        const scale = space === 'image' ? imageScale(ctx) : 1;
        const sx = scaleCoord(start.x, scale), sy = scaleCoord(start.y, scale);
        const ex = scaleCoord(end.x, scale), ey = scaleCoord(end.y, scale);
        const fg0 = await ctx.platform.getActiveWindow().catch(() => null);
        const raised = await ensureTargetForeground(ctx, fg0);
        const before = raised ? await ctx.platform.getActiveWindow().catch(() => null) : fg0;
        await ctx.platform.mouseDrag(sx, sy, ex, ey);
        await sleep(200);
        const after = await ctx.platform.getActiveWindow().catch(() => null);
        return { success: true, text: `Dragged ${space} (${start.x},${start.y})→(${end.x},${end.y}) → screen (${sx},${sy})→(${ex},${ey}) [×${scale}]${raised}${focusBreadcrumb(before, after)}` };
      },
    },

    {
      name: 'scroll',
      description: 'Scroll at (x,y) in a direction. Omit x,y to scroll at the screen center.',
      inputSchema: {
        type: 'object',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          direction: { type: 'string', enum: ['up', 'down'] },
          amount: { type: 'number', description: 'Wheel ticks (default 3)' },
          space: COORD_SPACE_SCHEMA,
        },
        required: ['direction'],
        additionalProperties: false,
      },
      changesScreen: true,
      async execute(args, ctx) {
        const dir = args.direction === 'up' ? 'up' : 'down';
        const amount = typeof args.amount === 'number' ? args.amount : 3;
        // Default to screen-center when x/y missing; coerce strings via the helper.
        const hasXY = args.x !== undefined || args.y !== undefined;
        const space = args.space === 'image' ? 'image' : 'screen';
        const scale = space === 'image' ? imageScale(ctx) : 1;
        let x = Math.floor(ctx.screen.physicalWidth / 2);
        let y = Math.floor(ctx.screen.physicalHeight / 2);
        if (hasXY) {
          const c = coerceCoord(args.x, args.y);
          if (Number.isFinite(c.x) && Number.isFinite(c.y)) { x = scaleCoord(c.x, scale); y = scaleCoord(c.y, scale); }
        }
        await ctx.platform.mouseScroll(x, y, dir, amount);
        await sleep(150);
        return { success: true, text: `Scrolled ${dir} ${amount} at (${x},${y})` };
      },
    },

    // ─── INPUT (keyboard) ───────────────────────────────────────
    {
      name: 'type',
      description: 'Type text into the currently focused input. Prefer set_field_value when a field has an a11y name.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
      changesScreen: true,
      async execute(args, ctx) {
        const text = String(args.text ?? '');
        if (!text) return { success: true, text: 'Typed 0 chars' };
        // FAST PATH: paste via the clipboard (one Ctrl/Cmd+V — instant) instead
        // of per-keystroke typing, which is visibly slow on anything longer than
        // a few chars (~20ms/char). This is the legacy smart_type mechanism.
        // Save + restore the prior clipboard so a pending copy isn't clobbered
        // (e.g. a copy→paste→type flow). mod+v is portable across OSes.
        // Char-by-char is kept as a fallback for fields that reject paste.
        try {
          const prior = await ctx.platform.readClipboard().catch(() => '');
          await ctx.platform.writeClipboard(text);
          await sleep(40);
          await ctx.platform.keyPress('mod+v');
          await sleep(150);
          await ctx.platform.writeClipboard(prior).catch(() => {});
          return { success: true, text: `Typed ${text.length} chars (paste): "${truncate(text, 60)}"` };
        } catch {
          await ctx.platform.typeText(text);
          await sleep(200);
          return { success: true, text: `Typed ${text.length} chars: "${truncate(text, 60)}"` };
        }
      },
    },

    {
      name: 'key',
      description: 'Press a key or key combo. Use "mod" for Ctrl/Cmd. Use "+" for a chord (e.g. "mod+s", "shift+Tab"). Space-separate for a sequence ("Down Down End"). Examples: "Return", "Tab", "Escape", "F5", "ctrl+a".',
      inputSchema: {
        type: 'object',
        properties: {
          // `combo` is the canonical System B name. `key` is accepted as a
          // backward-compatible alias (matches the MCP surface param name
          // `key_press.key` and the compound surface alias).
          combo: { type: 'string', description: 'Key/combo to press (e.g. "Return", "mod+s"). Space-separate for a sequence.' },
          key: { type: 'string', description: 'Alias for combo — accepted for MCP/compound backward-compatibility.' },
        },
        // Neither is required at the JSON-Schema level so the validator passes
        // when only one is provided; the execute() guard catches a total absence.
        additionalProperties: false,
      },
      changesScreen: true,
      async execute(args, ctx) {
        // (b) Accept `key` as a backward-compatible alias for `combo`.
        const raw = (args.combo ?? args.key);
        // (a) Guard: missing or empty argument → actionable error instead of crash.
        if (raw === undefined || raw === null || String(raw).trim() === '') {
          return {
            success: false,
            isError: true,
            text: 'key: "combo" is required — the key or combo to press, e.g. "Return" or "mod+s". (The MCP surface alias is "key".)',
          };
        }
        const input = String(raw).trim();
        // Dangerous key combos that are blocked (mirrors System A BLOCKED_KEYS).
        const BLOCKED = ['alt+f4', 'ctrl+alt+delete', 'ctrl+alt+del'];
        // (b) "+" joins a chord; whitespace separates combos pressed in sequence.
        const combos = input.split(/\s+/);
        // (c) BLOCKED_KEYS guard — check every combo in the sequence.
        for (const c of combos) {
          const norm = c.toLowerCase().replace(/\s+/g, '');
          if (BLOCKED.some(b => norm === b)) {
            return { success: false, isError: true, text: `BLOCKED: "${c}" is a dangerous key combo.` };
          }
        }
        for (const c of combos) {
          await ctx.platform.keyPress(c);
          if (combos.length > 1) await sleep(50); // brief gap between sequence steps
        }
        await sleep(150);
        return { success: true, text: `Pressed ${input}` };
      },
    },

    // ─── APPS & WINDOWS ─────────────────────────────────────────
    {
      name: 'open_app',
      description: 'Open an application by name (e.g. "Notepad", "TextEdit", "Safari").',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
        additionalProperties: false,
      },
      changesScreen: true,
      async execute(args, ctx) {
        const name = String(args.name ?? '');
        // Alias resolution lives at the agent-tool layer (PR1 of v0.9):
        // the platform adapter is alias-data-agnostic, so we look up the
        // canonical row here and forward the launch hints through
        // `launchApp` opts. Cross-OS name mapping (Windows "Notepad" → mac
        // "TextEdit") and UWP / executable / searchTerm details all flow
        // through this single resolution point.
        const alias = resolveAlias(name);
        const platform = ctx.platform.platform;

        // Pick the right name to hand to the platform launcher per OS.
        // Falls back to the raw `name` when no alias matches.
        let launchName = name;
        if (alias) {
          if (platform === 'darwin') {
            launchName = alias.macOSAppName ?? name;
          } else if (platform === 'win32') {
            launchName = alias.executable ?? name;
          } else {
            // Linux: use the alias's executable but strip any `.exe`
            // suffix that's there for the Windows path.
            launchName = alias.executable?.replace(/\.exe$/i, '') ?? name;
          }
        }

        const res = await ctx.platform.launchApp(launchName, {
          alwaysNewInstance: alias?.alwaysNewInstance,
          uwpAppId: alias?.uwpAppId,
          // Pick the searchTerm that gives the OS native launcher (Start
          // Menu / Spotlight) the best chance of resolving to the right
          // app — alias.searchTerm wins when present, mac falls back to
          // the bundle name.
          searchTerm: alias?.searchTerm
            ?? (platform === 'darwin' ? alias?.macOSAppName : undefined),
        });
        await sleep(800);
        return {
          success: true,
          text: res.title ? `Opened "${name}" (pid=${res.pid}, window="${res.title}")` : `Launched "${name}" (no window surfaced yet)`,
        };
      },
    },

    {
      name: 'focus_window',
      description: 'Bring a window to the foreground. Match by processName, pid, or title substring.',
      inputSchema: {
        type: 'object',
        properties: {
          processName: { type: 'string' },
          processId: { type: 'number' },
          title: { type: 'string' },
        },
        additionalProperties: false,
      },
      changesScreen: true,
      async execute(args, ctx) {
        const q: Record<string, string | number | undefined> = {};
        if (typeof args.processName === 'string') q.processName = args.processName;
        if (typeof args.processId === 'number') q.processId = args.processId;
        if (typeof args.title === 'string') q.title = args.title;
        const ok = await ctx.platform.focusWindow(q as any);
        await sleep(250);
        return { success: ok, text: ok ? 'Focused matching window.' : 'No matching window found.' };
      },
    },

    // ─── WINDOW STATE + BOUNDS (Tranche 1B primitives) ──────────
    {
      name: 'maximize_window',
      description: 'Maximize the foreground window (or a matched window). Polite request; WM may interpret.',
      inputSchema: {
        type: 'object',
        properties: {
          processName: { type: 'string' },
          processId: { type: 'number' },
          title: { type: 'string' },
        },
        additionalProperties: false,
      },
      changesScreen: true,
      async execute(args, ctx) {
        const q = buildWinQuery(args);
        const ok = await ctx.platform.setWindowState('maximize', q);
        return { success: ok, text: ok ? 'Maximized window.' : 'Maximize request ignored.' };
      },
    },

    {
      name: 'minimize_window',
      description: 'Minimize the foreground or matched window to the taskbar / Dock.',
      inputSchema: {
        type: 'object',
        properties: {
          processName: { type: 'string' },
          processId: { type: 'number' },
          title: { type: 'string' },
        },
        additionalProperties: false,
      },
      changesScreen: true,
      async execute(args, ctx) {
        const q = buildWinQuery(args);
        const ok = await ctx.platform.setWindowState('minimize', q);
        return { success: ok, text: ok ? 'Minimized window.' : 'Minimize request failed.' };
      },
    },

    {
      name: 'restore_window',
      description: 'Restore a minimized or maximized window to its previous bounds.',
      inputSchema: {
        type: 'object',
        properties: {
          processName: { type: 'string' },
          processId: { type: 'number' },
          title: { type: 'string' },
        },
        additionalProperties: false,
      },
      changesScreen: true,
      async execute(args, ctx) {
        const q = buildWinQuery(args);
        const ok = await ctx.platform.setWindowState('normal', q);
        return { success: ok, text: ok ? 'Restored window.' : 'Restore request failed.' };
      },
    },

    {
      name: 'close_window',
      description: 'Polite close request (WM_CLOSE / AXCloseAction / _NET_CLOSE_WINDOW). App may prompt.',
      inputSchema: {
        type: 'object',
        properties: {
          processName: { type: 'string' },
          processId: { type: 'number' },
          title: { type: 'string' },
        },
        additionalProperties: false,
      },
      changesScreen: true,
      async execute(args, ctx) {
        const q = buildWinQuery(args);
        const ok = await ctx.platform.setWindowState('close', q);
        return { success: ok, text: ok ? 'Close request posted.' : 'Close request failed.', targetLabel: 'close_window' };
      },
    },

    {
      name: 'resize_window',
      description: 'Set the foreground (or matched) window bounds in logical pixels. Omitted fields preserved.',
      inputSchema: {
        type: 'object',
        properties: {
          x: { type: 'number' }, y: { type: 'number' },
          width: { type: 'number' }, height: { type: 'number' },
          processName: { type: 'string' },
          processId: { type: 'number' },
          title: { type: 'string' },
        },
        additionalProperties: false,
      },
      changesScreen: true,
      async execute(args, ctx) {
        const q = buildWinQuery(args);
        const x = typeof args.x === 'number' ? args.x : undefined;
        const y = typeof args.y === 'number' ? args.y : undefined;
        const width = typeof args.width === 'number' ? args.width : undefined;
        const height = typeof args.height === 'number' ? args.height : undefined;
        const ok = await ctx.platform.setWindowBounds({ x, y, width, height }, q);
        return { success: ok, text: ok ? `Resized window (x=${x ?? '-'}, y=${y ?? '-'}, w=${width ?? '-'}, h=${height ?? '-'}).` : 'Resize failed.' };
      },
    },

    {
      name: 'list_displays',
      description: 'Enumerate connected displays with logical bounds + DPI ratio. Use before display-specific screenshots.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      changesScreen: false,
      async execute(_args, ctx) {
        const displays = await ctx.platform.listDisplays();
        return { success: true, text: JSON.stringify(displays) };
      },
    },

    {
      name: 'switch_tab_os',
      description: 'Cycle next/previous browser tab (mod+Tab / mod+Shift+Tab) or jump to tab N (mod+1..9).',
      inputSchema: {
        type: 'object',
        properties: {
          index: { type: 'number', description: '1-9 for direct tab jump' },
          direction: { type: 'string', enum: ['next', 'previous'] },
        },
        additionalProperties: false,
      },
      changesScreen: true,
      async execute(args, ctx) {
        if (typeof args.index === 'number') {
          const n = Math.max(1, Math.min(9, Math.floor(args.index)));
          await ctx.platform.keyPress(`mod+${n}`);
          return { success: true, text: `Switched to tab ${n}` };
        }
        const dir = args.direction === 'previous' ? 'previous' : 'next';
        await ctx.platform.keyPress(dir === 'next' ? 'mod+Tab' : 'mod+shift+Tab');
        return { success: true, text: `Cycled to ${dir} tab` };
      },
    },

    // ─── ACCESSIBILITY DEPTH (Tranche 1B) ───────────────────────
    {
      name: 'focus_element',
      description: 'Keyboard-focus an element by a11y name. Does NOT raise window — use focus_window first if needed.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          controlType: { type: 'string' },
          processId: { type: 'number' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      changesScreen: true,
      async execute(args, ctx) {
        const name = String(args.name ?? '');
        const result = await ctx.platform.invokeElement({
          name,
          controlType: typeof args.controlType === 'string' ? args.controlType : undefined,
          processId: typeof args.processId === 'number' ? args.processId : undefined,
          action: 'focus',
        });
        return {
          success: result.success,
          text: result.success ? `Focused "${name}" via a11y.` : `Could not focus "${name}".`,
          targetLabel: name,
        };
      },
    },

    {
      name: 'wait_for_element',
      description: 'Poll the a11y tree until an element matching name/controlType appears. Useful after an action spawns a dialog.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          controlType: { type: 'string' },
          processId: { type: 'number' },
          timeoutMs: { type: 'number', description: 'Default 5000', maximum: 30000 },
          intervalMs: { type: 'number', description: 'Default 250' },
        },
        additionalProperties: false,
      },
      changesScreen: false,
      async execute(args, ctx) {
        const timeout = typeof args.timeoutMs === 'number' ? Math.min(30000, args.timeoutMs) : 5000;
        const element = await ctx.platform.waitForElement(
          {
            name: typeof args.name === 'string' ? args.name : undefined,
            controlType: typeof args.controlType === 'string' ? args.controlType : undefined,
            processId: typeof args.processId === 'number' ? args.processId : undefined,
            intervalMs: typeof args.intervalMs === 'number' ? args.intervalMs : 250,
          },
          timeout,
        );
        if (!element) return { success: false, text: `wait_for_element: timed out after ${timeout}ms` };
        return { success: true, text: `Found element: ${element.name} [${element.controlType}] @${element.bounds.x},${element.bounds.y}` };
      },
    },

    // ─── SYSTEM OPEN HELPERS (Tranche 1B) ───────────────────────
    {
      name: 'open_file',
      description: 'Open a file or folder in the OS default app (explorer / open / xdg-open).',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
      changesScreen: true,
      async execute(args, ctx) {
        const p = String(args.path ?? '');
        try {
          if (ctx.platform.platform === 'darwin') await ctx.platform.launchApp('open', { url: p });
          else if (ctx.platform.platform === 'linux') await ctx.platform.launchApp('xdg-open', { url: p });
          else await ctx.platform.launchApp('explorer.exe', { url: p });
          await sleep(500);
          return { success: true, text: `Opened: ${p}` };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { success: false, text: `open_file failed: ${msg}` };
        }
      },
    },

    {
      name: 'open_url',
      description: 'Open a URL in the default browser. Use instead of navigate_browser when you don\'t care which browser.',
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
        additionalProperties: false,
      },
      changesScreen: true,
      async execute(args, ctx) {
        const u = String(args.url ?? '');
        if (!/^https?:\/\//i.test(u)) return { success: false, text: 'open_url: URL must start with http(s)://' };
        try {
          if (ctx.platform.platform === 'darwin') {
            await ctx.platform.launchApp('open', { url: u });
          } else if (ctx.platform.platform === 'linux') {
            await ctx.platform.launchApp('xdg-open', { url: u });
          } else {
            // Windows: launch the REGISTERED https handler directly (e.g.
            // msedge.exe), not `explorer.exe <url>`. explorer drops the URL in a
            // background tab and opens no explorer window, so launchApp's
            // window-find misses and falls back to a Start-menu search that
            // presses Win and types — spurious "searching" that derails the run.
            // The resolved browser exe HAS a findable window, so launchApp
            // foregrounds it cleanly with no fallback.
            const { resolveSchemeHandlerExecutable } = await import('../../platform/uri-handler');
            const exe = await resolveSchemeHandlerExecutable('https').catch(() => null);
            await ctx.platform.launchApp(exe ?? 'explorer.exe', { url: u });
          }
          await sleep(800);
          return { success: true, text: `Opened URL: ${u}` };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { success: false, text: `open_url failed: ${msg}` };
        }
      },
    },

    {
      // open_uri — the general OS protocol-handler escape route.
      //
      // Every OS ships a protocol-handler registry. Windows uses
      // HKCR\\<scheme>\\shell\\open\\command. macOS uses LaunchServices.
      // Linux uses xdg-mime + .desktop files. The user's installed apps
      // register themselves as handlers and the OS routes for us:
      //   mailto:   → default mail client (Outlook, Mail.app, Thunderbird, Spark...)
      //   tel:      → default phone app (Skype, FaceTime, dialer...)
      //   sms:      → default messaging app
      //   webcal:   → default calendar
      //   slack:    → Slack
      //   vscode:   → VS Code
      //   obsidian: → Obsidian
      //   spotify:  → Spotify
      //   zoommtg:  → Zoom
      //   discord:  → Discord
      //   file:     → OS file-association dispatcher
      //   http(s):  → default browser
      //
      // This is THE app-agnostic escape route. ONE tool, every app that
      // registers a protocol handler. Zero vision, zero a11y, zero
      // app-specific code. The agent picks the scheme; we just dispatch.
      name: 'open_uri',
      description: 'Open ANY registered URI scheme via the OS protocol-handler registry. ONE tool replaces dozens of app-specific shortcuts. Examples: mailto:bob@example.com?subject=hi&body=hello (mail), tel:+15551234 (phone), slack://channel?team=T123&id=C456 (Slack), vscode://file/path (VS Code), webcal://server/cal.ics (calendar), spotify:track:ID (Spotify), https://example.com (browser). Must be properly URL-encoded — pair with build_uri when you have semantic fields.',
      inputSchema: {
        type: 'object',
        properties: {
          uri: { type: 'string', description: 'A full URI with scheme (e.g. "mailto:bob@example.com?subject=hi&body=hello").' },
        },
        required: ['uri'],
        additionalProperties: false,
      },
      changesScreen: true,
      async execute(args, ctx) {
        const u = String(args.uri ?? '').trim();
        if (!u) return { success: false, isError: true, text: 'open_uri: uri is required' };
        const schemeMatch = u.match(/^([a-z][a-z0-9+.-]*):/i);
        if (!schemeMatch) {
          return { success: false, isError: true, text: 'open_uri: argument must be a URI with a scheme (e.g. mailto:, tel:, https:, slack:)' };
        }
        const scheme = schemeMatch[1].toLowerCase();
        try {
          if (ctx.platform.platform === 'darwin') {
            await ctx.platform.launchApp('open', { url: u });
            await sleep(1500);
            return {
              success: true,
              text: `Dispatched ${scheme}: URI to the OS default handler. The configured app for ${scheme}: should now be focused. Verify with read_screen / list_windows. To complete (e.g. send a composed mail), use one more keystroke (cmd+enter on macOS).`,
            };
          }
          if (ctx.platform.platform === 'linux') {
            await ctx.platform.launchApp('xdg-open', { url: u });
            await sleep(1500);
            return {
              success: true,
              text: `Dispatched ${scheme}: URI to the OS default handler. The configured app for ${scheme}: should now be focused. Verify with read_screen / list_windows. To complete (e.g. send a composed mail), use one more keystroke (ctrl+enter on Linux).`,
            };
          }
          // Windows: shell-routed dispatch (explorer.exe mailto:, rundll32
          // url.dll, cmd /c start) silently fails for New Outlook and other
          // UWP-packaged handlers — the handler returns without opening a
          // new window. The reliable path is to resolve the registered
          // handler executable and invoke IT directly with the URI, then
          // VERIFY a new visible window appeared. Without verification
          // open_uri returned "success" while nothing actually happened on
          // screen, sending the agent into stagnation loops.
          const exe = await resolveSchemeHandlerExecutable(scheme);
          if (!exe) {
            return {
              success: false,
              isError: true,
              text: `open_uri: no registered Windows handler found for "${scheme}:". Try a different scheme or drive the app's UI directly.`,
            };
          }
          const launchResult = await launchHandlerAndVerify(exe, u, { waitMs: 5000 });
          if (!launchResult.success) {
            return {
              success: false,
              isError: true,
              text: `open_uri: failed to launch handler "${exe}" for ${scheme}: — ${launchResult.error ?? 'unknown error'}`,
            };
          }
          if (!launchResult.windowOpened) {
            return {
              success: false,
              isError: true,
              text: `open_uri: handler "${exe}" was launched with ${scheme}: but no new window appeared within 5s. The handler probably routed the URI into an existing instance silently. Drive the app's UI directly (focus_window + click + type_text) instead of relying on the protocol dispatch.`,
            };
          }
          return {
            success: true,
            text: `Opened ${scheme}: in the registered handler. New window appeared: "${launchResult.hwndLabel ?? '(handle unknown)'}". To complete (e.g. send a composed mail), use one more keystroke (ctrl+enter).`,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { success: false, isError: true, text: `open_uri failed: ${msg}` };
        }
      },
    },

    {
      // build_uri — pure helper that converts semantic fields to an
      // encoded URI. No I/O. Pair with open_uri to dispatch.
      name: 'build_uri',
      description: 'Build a properly-encoded URI from a scheme + path + query JSON. Returns the URI text; pair with open_uri to dispatch. Examples: scheme="mailto" path="bob@example.com" query={"subject":"hi","body":"hello"} → "mailto:bob@example.com?subject=hi&body=hello".',
      inputSchema: {
        type: 'object',
        properties: {
          scheme: { type: 'string', description: 'URI scheme without the colon (mailto, tel, sms, slack, ...).' },
          path:   { type: 'string', description: 'Scheme-specific path. Encoded for you; @ and , are preserved for mailto, + for tel.' },
          query:  { type: 'string', description: 'JSON object of query params, e.g. {"subject":"hi"}. Each value URL-encoded.' },
        },
        required: ['scheme'],
        additionalProperties: false,
      },
      changesScreen: false,
      async execute(args) {
        const s = String(args.scheme ?? '').trim().toLowerCase();
        if (!s || !/^[a-z][a-z0-9+.-]*$/.test(s)) {
          return { success: false, isError: true, text: 'build_uri: scheme must match /^[a-z][a-z0-9+.-]*$/' };
        }
        const safe = (v: string): string =>
          encodeURIComponent(v).replace(/'/g, '%27').replace(/"/g, '%22');
        const encodedPath = args.path
          ? safe(String(args.path))
              .replace(/%40/g, '@')
              .replace(/%2C/g, ',')
              .replace(/%2B/g, '+')
              .replace(/%2F/g, '/')
          : '';
        let queryStr = '';
        if (args.query) {
          let obj: Record<string, unknown>;
          try {
            obj = typeof args.query === 'string' ? JSON.parse(String(args.query)) : (args.query as Record<string, unknown>);
          } catch {
            return { success: false, isError: true, text: 'build_uri: query must be valid JSON' };
          }
          const parts: string[] = [];
          for (const [k, v] of Object.entries(obj)) {
            if (v === undefined || v === null) continue;
            parts.push(`${safe(k)}=${safe(String(v))}`);
          }
          if (parts.length) queryStr = '?' + parts.join('&');
        }
        return { success: true, text: `${s}:${encodedPath}${queryStr}` };
      },
    },

    {
      name: 'get_system_time',
      description: 'Return current system time (ISO, epoch, timezone). Zero I/O.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      changesScreen: false,
      async execute() {
        const now = new Date();
        return {
          success: true,
          text: JSON.stringify({
            iso: now.toISOString(),
            epochMs: now.getTime(),
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          }),
        };
      },
    },

    // ─── MOUSE + KEYBOARD EXTENDED (Tranche 1B) ────────────────
    {
      name: 'mouse_move_relative',
      description: 'Move cursor by a relative offset (dx, dy). Wayland-safe via cursor cache.',
      inputSchema: {
        type: 'object',
        properties: { dx: { type: 'number' }, dy: { type: 'number' } },
        required: ['dx', 'dy'],
        additionalProperties: false,
      },
      changesScreen: false,
      async execute(args, ctx) {
        await ctx.platform.mouseMoveRelative(Number(args.dx ?? 0), Number(args.dy ?? 0));
        return { success: true, text: `Cursor moved by (${args.dx}, ${args.dy})` };
      },
    },

    {
      name: 'mouse_down',
      description: 'Press a mouse button without releasing. Pair with mouse_up. Enables hold-and-drag + modifier clicks.',
      inputSchema: {
        type: 'object',
        properties: { button: { type: 'string', enum: ['left', 'right', 'middle'] } },
        additionalProperties: false,
      },
      changesScreen: true,
      async execute(args, ctx) {
        const b = (args.button as 'left' | 'right' | 'middle') ?? 'left';
        await ctx.platform.mouseDown(b);
        return { success: true, text: `Mouse ${b} down.` };
      },
    },

    {
      name: 'mouse_up',
      description: 'Release a mouse button previously pressed with mouse_down.',
      inputSchema: {
        type: 'object',
        properties: { button: { type: 'string', enum: ['left', 'right', 'middle'] } },
        additionalProperties: false,
      },
      changesScreen: true,
      async execute(args, ctx) {
        const b = (args.button as 'left' | 'right' | 'middle') ?? 'left';
        await ctx.platform.mouseUp(b);
        return { success: true, text: `Mouse ${b} up.` };
      },
    },

    {
      name: 'key_down',
      description: 'Press a key without releasing. Pair with key_up. Use to hold modifiers (shift, ctrl) during clicks.',
      inputSchema: {
        type: 'object',
        properties: { key: { type: 'string' } },
        required: ['key'],
        additionalProperties: false,
      },
      changesScreen: false,
      async execute(args, ctx) {
        await ctx.platform.keyDown(String(args.key ?? ''));
        return { success: true, text: `Key down: ${args.key}` };
      },
    },

    {
      name: 'key_up',
      description: 'Release a key previously pressed with key_down.',
      inputSchema: {
        type: 'object',
        properties: { key: { type: 'string' } },
        required: ['key'],
        additionalProperties: false,
      },
      changesScreen: false,
      async execute(args, ctx) {
        await ctx.platform.keyUp(String(args.key ?? ''));
        return { success: true, text: `Key up: ${args.key}` };
      },
    },

    {
      name: 'undo_last',
      description: 'Send the OS Undo keystroke (mod+Z).',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      changesScreen: true,
      async execute(_args, ctx) {
        await ctx.platform.keyPress('mod+z');
        return { success: true, text: 'Sent undo.' };
      },
    },

    // ─── CLIPBOARD ─────────────────────────────────────────────
    {
      name: 'read_clipboard',
      description: 'Read the OS clipboard.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      changesScreen: false,
      async execute(_args, ctx) {
        const text = await ctx.platform.readClipboard();
        return { success: true, text: `Clipboard (${text.length} chars):\n${truncate(text, 500)}` };
      },
    },

    {
      name: 'write_clipboard',
      description: 'Write text to the OS clipboard.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
      changesScreen: false,
      async execute(args, ctx) {
        const text = String(args.text ?? '');
        await ctx.platform.writeClipboard(text);
        return { success: true, text: `Wrote ${text.length} chars to clipboard.` };
      },
    },

    // ─── FLOW CONTROL ───────────────────────────────────────────
    {
      name: 'wait',
      description: 'Pause for N milliseconds (max 5000). Use after actions that trigger animations or page loads.',
      inputSchema: {
        type: 'object',
        properties: { ms: { type: 'number', maximum: 5000 } },
        required: ['ms'],
        additionalProperties: false,
      },
      changesScreen: false,
      async execute(args) {
        const ms = Math.min(5000, Math.max(0, Number(args.ms ?? 0)));
        await sleep(ms);
        return { success: true, text: `Waited ${ms}ms.` };
      },
    },

    // ─── VISION (hybrid + vision modes only) ────────────────────
    {
      name: 'screenshot',
      description: 'LAST RESORT — expensive: sends image bytes into LLM context. Escalation order: read_screen (a11y tree, free) → read_text (OCR, cheap) → screenshot (this, expensive). Only call this when both a11y and OCR failed to provide what you need (canvas-only app, icon-only UI, pixel-level verification).',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      changesScreen: false,
      async execute(_args, ctx) {
        const shot = await ctx.platform.screenshot({ maxWidth: 1280 });
        ctx.screenshotsCaptured.n += 1;
        return {
          success: true,
          text: `Captured ${shot.width}×${shot.height}.`,
          screenshot: shot,
        };
      },
    },

    // ─── OCR PERCEPTION (webview / canvas, cheap — no vision model) ──────
    // When the a11y tree is empty (browser page, Electron, canvas, game), OCR
    // reads the visible TEXT so the TEXT model can keep driving — no screenshot
    // bytes, no escalation to the vision model. This is the cheap path: it keeps
    // haiku as the brain instead of handing the whole subtask to sonnet.
    {
      name: 'read_text',
      description: 'OCR the screen and return visible text + positions. Use when the a11y snapshot is empty/sparse (webview, canvas, PDF, game) to READ on-screen content. Cheaper than a screenshot (no image bytes). May take 1–3s.',
      inputSchema: {
        type: 'object',
        properties: {
          filter: { type: 'string', description: 'Optional: keep only lines containing this text (case-insensitive).' },
        },
        additionalProperties: false,
      },
      changesScreen: false,
      async execute(args, _ctx) {
        const ocr = getAgentOcr();
        if (!ocr.isAvailable()) return { success: false, text: 'read_text: OCR not available on this platform — fall back to screenshot/vision.' };
        const result = await ocr.recognizeScreen();
        if (result.elements.length === 0) return { success: true, text: '(read_text: OCR found no text — screen may be blank, or OCR unavailable.)' };
        const lineMap = new Map<number, OcrElement[]>();
        for (const el of result.elements) {
          const arr = lineMap.get(el.line) ?? [];
          arr.push(el); lineMap.set(el.line, arr);
        }
        const filter = typeof args.filter === 'string' ? args.filter.toLowerCase() : null;
        const lines: string[] = [];
        for (const [, toks] of [...lineMap.entries()].sort((a, b) => a[0] - b[0])) {
          const sorted = [...toks].sort((a, b) => a.x - b.x);
          const lineText = sorted.map(t => t.text).join(' ');
          if (filter && !lineText.toLowerCase().includes(filter)) continue;
          const minX = Math.min(...sorted.map(t => t.x));
          const minY = Math.min(...sorted.map(t => t.y));
          lines.push(`@${minX},${minY} "${lineText}"`);
        }
        if (lines.length === 0) return { success: true, text: `(read_text: no lines match "${filter}")` };
        return { success: true, text: `OCR (${result.elements.length} words, ${result.durationMs}ms):\n${lines.join('\n')}` };
      },
    },
    {
      name: 'smart_click',
      description: 'OCR-locate visible text on screen and click its center. Use when the a11y tree is empty and invoke_element fails (webview/canvas). Pass the exact visible text (e.g. "Search", a video title, "Sign in").',
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'The visible text to click.' },
          button: { type: 'string', enum: ['left', 'right'] },
        },
        required: ['target'],
        additionalProperties: false,
      },
      changesScreen: true,
      async execute(args, ctx) {
        const target = String(args.target ?? '').trim();
        if (!target) return { success: false, isError: true, text: 'smart_click: target required.' };
        const button = args.button === 'right' ? 'right' : 'left';
        const ocr = getAgentOcr();
        if (!ocr.isAvailable()) return { success: false, text: 'smart_click: OCR not available — escalate to vision.' };
        const result = await ocr.recognizeScreen();
        if (result.elements.length === 0) return { success: false, text: 'smart_click: OCR found no text — escalate to vision.' };
        const hit = locateByOcr(target, result.elements);
        if (!hit) return { success: false, text: `smart_click: no match for "${target}". Call read_text to see visible text, then retry with exact text.` };
        // OCR coords are screen-space — pass straight to mouseClick, same as the
        // `click` tool does with a11y coords (no imageScale; that's image-space only).
        const fg0 = await ctx.platform.getActiveWindow().catch(() => null);
        const raised = await ensureTargetForeground(ctx, fg0);
        await ctx.platform.mouseClick(hit.x, hit.y, { button, count: 1 });
        await sleep(150);
        getAgentOcr().invalidateCache();
        return { success: true, text: `smart_click: clicked "${hit.label}" (score ${hit.score.toFixed(2)}) at (${hit.x},${hit.y})${raised}`, targetLabel: hit.label };
      },
    },

    // ─── BROWSER (CDP / DOM — reliable web automation, no pixels) ────────
    // For web pages, driving the DOM by selector/text is far more reliable
    // than OCR + coordinate clicks: no occlusion, no focus-stealing, no
    // image scaling. These tools operate a DEDICATED, agent-owned browser
    // instance (separate profile + debug port) so they never disturb the
    // user's own windows. They DEGRADE GRACEFULLY: if CDP isn't wired or a
    // browser can't be launched, they say so and the agent falls back to
    // read_text / smart_click. Haiku stays the brain — it reads DOM text and
    // decides; no vision model needed.
    {
      name: 'browser_connect',
      description: 'Open/attach a dedicated browser the agent controls via the DOM (reliable for web pages — no pixels). Call this FIRST for any website task, then use browser_navigate/read/click/type. If it fails, fall back to read_text/smart_click.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      changesScreen: true,
      async execute(_args, ctx) {
        if (!ctx.cdp) return { success: false, text: 'browser_connect: CDP not available in this build — use read_text/smart_click for the page instead.' };
        // CLAWD_AGENT_CDP_OFF=1 → attach-only (never launch a new instance).
        const allowLaunch = !/^(1|true)$/i.test(process.env.CLAWD_AGENT_CDP_OFF ?? '');
        const ok = await ctx.cdp.ensureConnected({ launch: allowLaunch, exePaths: [...getEdgePaths(), ...getChromePaths()] }).catch(() => false);
        if (!ok) return { success: false, text: `browser_connect: could not ${allowLaunch ? 'launch or attach to' : 'attach to'} a CDP browser — fall back to read_text/smart_click.` };
        const url = await ctx.cdp.getUrl().catch(() => null);
        const title = await ctx.cdp.getTitle().catch(() => null);
        return { success: true, text: `browser_connect: connected to "${title ?? '(blank)'}" at ${url ?? 'about:blank'}. Use browser_navigate to open a URL, browser_read to see the page, browser_click/browser_type to interact.` };
      },
    },
    {
      name: 'browser_navigate',
      description: 'Navigate the agent-owned browser to a URL (waits for load). Requires browser_connect first.',
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string', description: 'The URL to open (e.g. https://www.youtube.com).' } },
        required: ['url'],
        additionalProperties: false,
      },
      changesScreen: true,
      async execute(args, ctx) {
        if (!ctx.cdp || !(await ctx.cdp.isConnected())) return { success: false, text: 'browser_navigate: not connected — call browser_connect first.' };
        const url = String(args.url ?? '').trim();
        if (!url) return { success: false, isError: true, text: 'browser_navigate: url required.' };
        const r = await ctx.cdp.navigate(url);
        return r.success ? { success: true, text: `browser_navigate: loaded ${r.value ?? url}` } : { success: false, text: `browser_navigate failed: ${r.error}` };
      },
    },
    {
      name: 'browser_read',
      description: 'Read the current page as structured DOM: interactive elements (links/buttons/inputs with selectors), or text for a CSS selector. Use instead of read_text on web pages. Requires browser_connect first.',
      inputSchema: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'Optional CSS selector to read text from (default: structured interactive-element list for the whole page).' },
        },
        additionalProperties: false,
      },
      changesScreen: false,
      async execute(args, ctx) {
        if (!ctx.cdp || !(await ctx.cdp.isConnected())) return { success: false, text: 'browser_read: not connected — call browser_connect first.' };
        const selector = typeof args.selector === 'string' ? args.selector.trim() : '';
        const text = selector ? await ctx.cdp.readText(selector, 3000) : await ctx.cdp.getPageContext();
        return { success: true, text };
      },
    },
    {
      name: 'browser_click',
      description: 'Click a page element by visible text or CSS selector (DOM click — no coordinates). Requires browser_connect first.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Visible text of the element to click (preferred).' },
          selector: { type: 'string', description: 'CSS selector (alternative to text).' },
        },
        additionalProperties: false,
      },
      changesScreen: true,
      async execute(args, ctx) {
        if (!ctx.cdp || !(await ctx.cdp.isConnected())) return { success: false, text: 'browser_click: not connected — call browser_connect first.' };
        const text = typeof args.text === 'string' ? args.text.trim() : '';
        const selector = typeof args.selector === 'string' ? args.selector.trim() : '';
        if (!text && !selector) return { success: false, isError: true, text: 'browser_click: provide text or selector.' };
        const r = text ? await ctx.cdp.clickByText(text) : await ctx.cdp.click(selector);
        return r.success ? { success: true, text: `browser_click: clicked ${text ? `"${text}"` : selector} (${r.method})` } : { success: false, text: `browser_click failed: ${r.error}. Call browser_read to see the actual elements, then retry.` };
      },
    },
    {
      name: 'browser_type',
      description: 'Type text into a page input by CSS selector or associated label (DOM input — no coordinates). Requires browser_connect first.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to type.' },
          selector: { type: 'string', description: 'CSS selector for the input.' },
          label: { type: 'string', description: 'Label text associated with the input (alternative to selector).' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      changesScreen: true,
      async execute(args, ctx) {
        if (!ctx.cdp || !(await ctx.cdp.isConnected())) return { success: false, text: 'browser_type: not connected — call browser_connect first.' };
        const text = String(args.text ?? '');
        const selector = typeof args.selector === 'string' ? args.selector.trim() : '';
        const label = typeof args.label === 'string' ? args.label.trim() : '';
        if (!selector && !label) return { success: false, isError: true, text: 'browser_type: provide selector or label.' };
        const r = label ? await ctx.cdp.typeByLabel(label, text) : await ctx.cdp.typeInField(selector, text);
        return r.success ? { success: true, text: `browser_type: typed into ${selector || `label "${label}"`}` } : { success: false, text: `browser_type failed: ${r.error}` };
      },
    },

    // ─── BATCHED PLANNING ───────────────────────────────────────
    // Run several known next actions in one turn (saves LLM round-trips).
    buildBatchTool(),

    // ─── TERMINAL ACTIONS ──────────────────────────────────────
    {
      name: 'done',
      description: 'Declare the task complete. Provide SPECIFIC screen evidence — a window title, a value visible in the document, a status bar message. Do NOT use hedging words ("should", "might", "probably", "I think", "I believe") — that means you are guessing. If you can\'t see concrete evidence, take a screenshot or read_screen first.',
      inputSchema: {
        type: 'object',
        properties: { evidence: { type: 'string' } },
        required: ['evidence'],
        additionalProperties: false,
      },
      changesScreen: false,
      terminal: true,
      async execute(args) {
        const evidence = String(args.evidence ?? '').trim();

        // Guard 1: evidence must be present and non-trivial. An empty string
        // or "ok" / "done" gives the verifier nothing to work with.
        if (evidence.length < 8) {
          return {
            success: false,
            text: 'done rejected: evidence is empty or too short. Look at the screen and report a SPECIFIC concrete observation (window title, on-screen text, focused element) before declaring done.',
            isError: true,
          };
        }

        // Guard 2: hedging-language detection. Phrases like "should have
        // been sent", "might be open", "I think it worked" are speculative
        // — they signal the agent guessed instead of verifying. Force a
        // re-check by rejecting the call. The agent's next turn will see
        // this rejection and either take a screenshot/read_screen or
        // rephrase with concrete observations.
        //
        // Pattern is intentionally narrow: words must appear as standalone
        // tokens (or first-letter-of-token), not as part of larger words
        // like "shoulder" or "mighty". Word-boundary anchored.
        if (HEDGING_PATTERN.test(evidence)) {
          return {
            success: false,
            text: `done rejected: evidence contains hedging language ("should", "might", "probably", "I think", "I believe", "appears to", "seems to", "if successful"…). That means you are GUESSING, not observing. Take a screenshot or call read_screen, then describe what you actually see — concrete strings, not predictions.`,
            isError: true,
          };
        }

        return { success: true, text: `done: ${evidence}`, stop: true, terminalExit: 'done' };
      },
    },

    {
      name: 'give_up',
      description: 'Abandon the task when it\'s impossible from here (credentials missing, captcha, destructive action needs user confirm, stuck after retries).',
      inputSchema: {
        type: 'object',
        properties: { reason: { type: 'string' } },
        required: ['reason'],
        additionalProperties: false,
      },
      changesScreen: false,
      terminal: true,
      async execute(args) {
        const reason = String(args.reason ?? 'unknown');
        return { success: false, text: `give_up: ${reason}`, stop: true, terminalExit: 'give_up' };
      },
    },

    {
      name: 'cannot_read',
      description: 'Escalate from blind mode to vision — the a11y snapshot doesn\'t contain what you need. Only available in blind mode.',
      inputSchema: {
        type: 'object',
        properties: { reason: { type: 'string' } },
        required: ['reason'],
        additionalProperties: false,
      },
      changesScreen: false,
      terminal: true,
      async execute(args) {
        const reason = String(args.reason ?? 'a11y snapshot insufficient');
        return { success: false, text: `cannot_read: ${reason}`, stop: true, terminalExit: 'cannot_read' };
      },
    },
  ];

  // A/B toggle: CLAWD_AGENT_NO_BATCH=1 removes the batch tool so the SAME task
  // can be run per-call (one tool per turn) vs batched, for measurement.
  if (/^(1|true)$/i.test(process.env.CLAWD_AGENT_NO_BATCH ?? '')) {
    const bi = tools.findIndex(t => t.name === 'batch');
    if (bi >= 0) tools.splice(bi, 1);
  }

  // Full flat catalog. `screenshot` is available so the agent can call it
  // when a11y is insufficient. `cannot_read` is excluded — the model runs
  // in hybrid mode with direct screenshot access; there is no blind→vision
  // escalation path to trigger.
  return tools.filter(t => t.name !== 'cannot_read');
}

/**
 * Resolve `processId` to the active-window pid when the LLM omits it.
 * Without this, UIA / AX searches walk the entire system tree and
 * either take 10-20 seconds or hang outright. Pre-scoping to the
 * focused app's pid is almost always what the agent actually wants.
 *
 * Used by every agent-internal tool that calls `findElements` or
 * `invokeElement` with an optional `processId` arg.
 */
async function resolveAgentPid(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<number | undefined> {
  if (typeof args.processId === 'number') return args.processId;
  try {
    const active = await ctx.platform.getActiveWindow();
    return active?.processId;
  } catch {
    return undefined;
  }
}

function buildWinQuery(args: Record<string, unknown>): { processName?: string; processId?: number; title?: string } | undefined {
  const q: { processName?: string; processId?: number; title?: string } = {};
  if (typeof args.processName === 'string') q.processName = args.processName;
  if (typeof args.processId === 'number') q.processId = args.processId;
  if (typeof args.title === 'string') q.title = args.title;
  return Object.keys(q).length ? q : undefined;
}

/** Shared `space` arg schema for the granular pointer tools (click/drag/scroll). */
const COORD_SPACE_SCHEMA = {
  type: 'string',
  enum: ['screen', 'image'],
  description:
    'Coordinate space of the x/y you pass. "screen" (default) = accessibility-snapshot coords, already correct for the real screen. "image" = coords you read off the SCREENSHOT (downscaled to 1280px wide); the tool scales them up to the real screen. Use "image" ONLY when the target is not in the a11y snapshot and you read it off the picture.',
} as const;

/** One-line coordinate breadcrumb for tool-result text: makes the input space,
 *  the scaled screen coords, and the scale factor visible so a wrong-window
 *  click is diagnosable from logs alone (no screenshot needed). */
function coordBreadcrumb(
  ix: number, iy: number, sx: number, sy: number,
  space: string, scale: number, ctx: AgentToolContext,
): string {
  const scaled = scale !== 1 ? ` → screen (${sx},${sy})` : '';
  return `${space} (${ix},${iy})${scaled} [×${scale}, screen ${ctx.screen.physicalWidth}×${ctx.screen.physicalHeight}]`;
}

/** Foreground-window before→after, so focus theft (clicks landing on the wrong
 *  window) is visible in the result text. Empty when focus didn't change. */
function focusBreadcrumb(
  before: { title?: string } | null,
  after: { title?: string } | null,
): string {
  const b = before?.title ?? '?';
  const a = after?.title ?? '?';
  if (b === a) return '';
  return ` · focus "${truncateTitle(b)}"→"${truncateTitle(a)}"`;
}

function truncateTitle(s: string): string {
  return s.length > 32 ? s.slice(0, 31) + '…' : s;
}

/**
 * Locate a target string among OCR elements and return the click point (center
 * of the best-matching contiguous span) in SCREEN pixels. Ported from the
 * proven scoring in src/tools/smart.ts: exact > substring-ratio > token-overlap,
 * with a penalty for a single token matching a multi-word target (stops "begin"
 * in body text beating the "Begin Exam" button). Null when nothing scores ≥0.4.
 */
function locateByOcr(
  target: string,
  elements: OcrElement[],
): { x: number; y: number; label: string; score: number } | null {
  const norm = (s: string) => s.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const targetNorm = norm(target);
  const targetWords = targetNorm.split(' ').filter(Boolean);
  const targetWordSet = new Set(targetWords);
  const lineMap = new Map<number, OcrElement[]>();
  for (const el of elements) {
    if (!el.text) continue;
    const a = lineMap.get(el.line) ?? [];
    a.push(el); lineMap.set(el.line, a);
  }
  let best: { x: number; y: number; label: string; score: number } | null = null;
  let bestScore = 0;
  const MAX_N = Math.min(8, targetWords.length + 2);
  for (const toks of lineMap.values()) {
    const sorted = [...toks].sort((a, b) => a.x - b.x);
    for (let i = 0; i < sorted.length; i++) {
      for (let n = 1; n <= MAX_N && i + n <= sorted.length; n++) {
        const span = sorted.slice(i, i + n);
        let contiguous = true;
        for (let k = 1; k < span.length; k++) {
          const gap = span[k].x - (span[k - 1].x + span[k - 1].width);
          if (gap > Math.max(span[k - 1].height * 1.5, 30)) { contiguous = false; break; }
        }
        if (!contiguous) continue;
        const phrase = norm(span.map(t => t.text).join(' '));
        let score = 0;
        if (phrase === targetNorm) score = 1.0;
        else if (phrase.includes(targetNorm) || targetNorm.includes(phrase)) {
          score = Math.min(phrase.length, targetNorm.length) / Math.max(phrase.length, targetNorm.length) * 0.9;
        } else {
          const pw = phrase.split(' ').filter(Boolean);
          const overlap = pw.filter(w => targetWordSet.has(w)).length;
          const cov = overlap / Math.max(targetWords.length, 1);
          if (cov >= 1) score = 0.85; else if (cov >= 0.5) score = 0.5 * cov;
        }
        if (targetWords.length > 1 && n === 1 && score < 0.95) score *= 0.55;
        if (score > bestScore) {
          bestScore = score;
          const minX = Math.min(...span.map(t => t.x));
          const minY = Math.min(...span.map(t => t.y));
          const maxX = Math.max(...span.map(t => t.x + t.width));
          const maxY = Math.max(...span.map(t => t.y + t.height));
          best = {
            x: Math.round((minX + maxX) / 2),
            y: Math.round((minY + maxY) / 2),
            label: span.map(t => t.text).join(' '),
            score,
          };
        }
      }
    }
  }
  return best && bestScore >= 0.4 ? best : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/**
 * Coerce an LLM-supplied coordinate argument into a clean `{ x, y }` pair.
 * Models occasionally smush both axes into one field (e.g. `x="390, 79"`,
 * `x="(390, 79)"`, or `x="390 79"`). The strict number schema makes `Number(...)`
 * silently produce NaN, which then becomes a click at (NaN, y) — a crash
 * disguised as a no-op. This helper splits the smushed form when present
 * and falls back to a clean parse otherwise.
 *
 * App-agnostic, OS-agnostic, model-agnostic. Used by every coordinate-taking
 * tool (click, drag, scroll, hover, move).
 */
export function coerceCoord(rawX: unknown, rawY: unknown): { x: number; y: number; warning?: string } {
  const parseOne = (v: unknown): number => {
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
      // Strip parens, brackets, leading/trailing whitespace.
      const cleaned = v.replace(/[()[\]\s]/g, '');
      const n = Number(cleaned);
      return Number.isFinite(n) ? n : NaN;
    }
    return NaN;
  };

  // Case A: x is a string containing a comma or pair-like "390, 79" / "390 79" / "(390,79)".
  if (typeof rawX === 'string' && /[\s,]/.test(rawX)) {
    const parts = rawX.replace(/[()[\]]/g, '').split(/[,\s]+/).filter(Boolean);
    if (parts.length >= 2) {
      const x = Number(parts[0]);
      const y = Number(parts[1]);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        return {
          x, y,
          warning: `coord parser: x came in as "${rawX}" — split into x=${x},y=${y}. Pass x and y as SEPARATE numeric args next time.`,
        };
      }
    }
  }

  const x = parseOne(rawX);
  const y = parseOne(rawY);
  return { x, y };
}
