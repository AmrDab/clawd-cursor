import type { Role, Source } from './ui-map-types';

const ROLE_MAP: Record<string, Role> = {
  button: 'button', splitbutton: 'button', menuitem: 'button',
  edit: 'input', document: 'input', combobox: 'input', spinner: 'input',
  text: 'text', statictext: 'text',
  hyperlink: 'link',
  checkbox: 'checkbox', radiobutton: 'checkbox',
  list: 'list', listbox: 'list',
  listitem: 'listitem', treeitem: 'listitem',
  tab: 'tab', tabitem: 'tab',
  image: 'image',
};

/** Map a UIA/AX control type (e.g. "ControlType.Button", "Edit") to a Role. */
export function normalizeRole(controlType?: string): Role {
  if (!controlType) return 'unknown';
  const key = controlType.replace(/^ControlType\./, '').trim().toLowerCase();
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
