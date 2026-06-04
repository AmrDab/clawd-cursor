/**
 * Text-LLM tool palettes — one small tool list per Capability.
 *
 * The text agent (`mode: 'blind' | 'hybrid'`) sees a SCOPED catalog
 * based on the subtask's capability classification. This is the
 * clawdcursor analogue of Anthropic's `computer_20250124` tool shape
 * — the model picks among a handful of focused primitives instead of
 * scanning 30+ at every turn.
 *
 * Why text, not vision: the text agent operates on the a11y tree and
 * the subtask's intent is known upfront (type text, launch app, etc.).
 * The vision agent operates on pixels and might need any primitive
 * turn-to-turn — it gets the compound-tool form instead (see
 * `compound.ts`).
 *
 * Fall-through: capability === 'general' → return undefined → caller
 * serves the full agent catalog (pre-Tranche-2.5 behavior).
 */

import type { Capability } from '../classify/capability';

/**
 * Tool-name lists per capability. Names MUST exist in
 * `buildUnifiedTools()`'s catalog (agent/tools.ts). Terminal actions
 * (`done`, `give_up`, `cannot_read`) are present in every palette
 * because the agent needs an exit door.
 *
 * These palettes are intentionally small. A tighter palette means:
 *   - fewer tokens in the system prompt per turn
 *   - less ambiguity for smaller models (Haiku, Kimi, Ollama)
 *   - faster tool_use resolution on the model side
 *
 * Design rule: include the minimum tools needed to complete the
 * capability + an escape hatch. Don't smuggle in "helpful extras" —
 * that defeats the purpose. If a palette is wrong, the model emits
 * `cannot_read` and the escalator promotes to hybrid/vision.
 */
export const TEXT_PALETTES: Record<Exclude<Capability, 'general'>, string[]> = {
  app_launch: [
    'open_app',
    'focus_window',
    'wait_for_element',
    'list_windows',
    'batch',
    'done',
    'give_up',
    'cannot_read',
  ],

  text_input: [
    'type',
    'key',
    'set_field_value',
    'focus_element',
    'read_screen',
    // Launch escape hatch: a "type/paste into X" subtask runs in isolation and
    // has no guarantee X is open or focused. Without these the agent can't open
    // the target app and improvises badly (e.g. Run-dialog typed into the wrong
    // window). open_app + focus_window are OS- and app-agnostic.
    'open_app',
    'focus_window',
    'list_windows',
    // OS protocol-handler escape route — single primitive for any
    // "open the right app to do X" intent (mailto, tel, sms, slack,
    // vscode, obsidian, spotify, zoommtg, https, ...).
    'open_uri',
    'build_uri',
    'batch',
    'done',
    'give_up',
    'cannot_read',
  ],

  navigation: [
    'key',
    'invoke_element',  // click the browser address bar by a11y name (it's in the
    'read_screen',     // a11y tree even when the page DOM is not) — drive nav blind
    'focus_window',
    'switch_tab_os',
    'open_url',
    'open_app',      // launch escape hatch — "switch to X" may need to open X first
    'list_windows',
    // Webview pages have an empty DOM a11y tree; OCR lets the TEXT model read the
    // page + click by visible text WITHOUT escalating to the vision model.
    'read_text',
    'smart_click',
    // CDP/DOM browser control — the agent's own browser instance, driven by
    // selector/text instead of pixels. The MOST reliable path for web tasks
    // (no occlusion/focus-stealing). Connect first; degrades to OCR if absent.
    'browser_connect',
    'browser_navigate',
    'browser_read',
    'browser_click',
    'browser_type',
    'batch',
    'done',
    'give_up',
    'cannot_read',
  ],

  form_fill: [
    'set_field_value',
    'invoke_element',
    'type',
    'key',
    'wait_for_element',
    'focus_element',
    'read_screen',
    // Tranche 2 a11y depth — forms commonly need toggle/select/expand/read-value
    'a11y_toggle',
    'a11y_select',
    'a11y_expand',
    'a11y_get_value',
    'get_element_state',
    // Webview forms (browser-rendered) have no DOM a11y — OCR finds field labels.
    'read_text',
    'smart_click',
    // CDP/DOM — fill web forms by selector/label, far more reliable than OCR.
    'browser_connect',
    'browser_read',
    'browser_click',
    'browser_type',
    // When the "form" is just a wrapper around a known semantic intent
    // (compose mail, place call, open file, open Slack channel, etc.),
    // open_uri + build_uri skip the form entirely.
    'open_uri',
    'build_uri',
    // Launch escape hatch — the form's app may not be open/focused yet.
    'open_app',
    'batch',
    'done',
    'give_up',
    'cannot_read',
  ],

  spatial: [
    // Spatial tasks typically reach the vision agent. This palette is the
    // fallback when the text agent attempts one first and needs the mouse
    // primitives to land a drag without screenshots. If the model calls
    // `cannot_read` here, the pipeline escalates to hybrid/vision cleanly.
    'mouse_move_relative',
    'mouse_down',
    'mouse_up',
    'click',
    'drag',
    'read_screen',
    // OCR gives the text agent eyes on a canvas without a vision-model screenshot.
    'read_text',
    'smart_click',
    'done',
    'give_up',
    'cannot_read',
  ],

  file_ops: [
    'open_file',
    'open_url',
    'read_clipboard',
    'write_clipboard',
    'key',
    'done',
    'give_up',
    'cannot_read',
  ],

  window_mgmt: [
    'focus_window',
    'maximize_window',
    'minimize_window',
    'restore_window',
    'close_window',
    'resize_window',
    'list_windows',
    'list_displays',
    'done',
    'give_up',
    'cannot_read',
  ],
};

/**
 * Look up the palette for a capability. Returns null for `general` so
 * the caller hands the model the full agent catalog (back-compat).
 */
export function paletteFor(capability: Capability): string[] | null {
  if (capability === 'general') return null;
  return TEXT_PALETTES[capability] ?? null;
}
