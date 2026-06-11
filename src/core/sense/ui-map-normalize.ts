import type { Role, Source } from './ui-map-types';

// Canonical roles keyed by BOTH Windows UIA control-type strings and macOS AX
// role strings (after the platform adapters strip "ControlType."/"AX"). The map
// was originally UIA-only, which meant macOS AX inputs ("TextField"/"TextArea")
// and links ("Link") fell through to 'unknown' → editable/clickable both false →
// the entire el_NN find_field/find_action/{element_id}-fill + link-click surface
// was DEAD on macOS (audit 2026-06-11, M1). AX synonyms below restore parity.
const ROLE_MAP: Record<string, Role> = {
  // buttons
  button: 'button', splitbutton: 'button', menuitem: 'button',
  menubutton: 'button', popupbutton: 'button', // AX
  // text inputs
  edit: 'input', document: 'input', combobox: 'input', spinner: 'input',
  textfield: 'input', textarea: 'input', securetextfield: 'input',       // AX
  passwordfield: 'input', searchfield: 'input', incrementor: 'input',    // AX
  // static text
  text: 'text', statictext: 'text',
  // links
  hyperlink: 'link', link: 'link',                                       // link (UIA), AXLink
  // toggles
  checkbox: 'checkbox', radiobutton: 'checkbox',
  checkboxcell: 'checkbox', radiobuttoncell: 'checkbox',                 // AX cells
  // lists
  list: 'list', listbox: 'list', table: 'list', outline: 'list',         // AX table/outline
  listitem: 'listitem', treeitem: 'listitem', row: 'listitem', cell: 'listitem',
  // tabs
  tab: 'tab', tabitem: 'tab', radiobuttongroup: 'tab',
  // images
  image: 'image',
};

/** Map a UIA/AX control type (e.g. "ControlType.Button", "Edit", "TextField") to a Role. */
export function normalizeRole(controlType?: string): Role {
  if (!controlType) return 'unknown';
  // Strip the UIA "ControlType." prefix AND any residual macOS "AX" prefix
  // (the adapter usually strips it, but be defensive so "AXTextField" maps too).
  const key = controlType
    .replace(/^ControlType\./, '')
    .replace(/^AX/, '')
    .trim().toLowerCase();
  return ROLE_MAP[key] ?? 'unknown';
}

/** Trim, lowercase, collapse internal whitespace. */
export function normText(text?: string): string {
  return (text ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

const CLICKABLE_ROLES = new Set<Role>(['button', 'link', 'checkbox', 'listitem', 'tab']);

/**
 * Capability flags. role describes WHAT it is; these describe WHAT YOU CAN DO.
 * a11y elements carry pattern intent via role + enabled; OCR-only elements have
 * no pattern info, so they're read-only text unless a later source corroborates.
 */
export function inferCapabilities(opts: { role: Role; source: Source; enabled?: boolean }): {
  clickable: boolean; editable: boolean; actionable: boolean;
} {
  const fromA11y = opts.source === 'a11y';
  const clickable = fromA11y && CLICKABLE_ROLES.has(opts.role);
  const editable = fromA11y && opts.role === 'input';
  const enabled = opts.enabled !== false;
  const actionable = (clickable || editable) && enabled;
  return { clickable, editable, actionable };
}
