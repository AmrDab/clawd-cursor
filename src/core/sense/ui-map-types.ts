/**
 * UI State Compiler (Layer A) data model. See
 * docs/superpowers/specs/2026-06-07-ui-state-compiler-design.md.
 */
export const SOURCES = ['window', 'a11y', 'ocr', 'vision', 'dom', 'cursor'] as const;
export type Source = typeof SOURCES[number];

export const ROLES = [
  'button', 'input', 'text', 'link', 'checkbox',
  'list', 'listitem', 'tab', 'image', 'unknown',
] as const;
export type Role = typeof ROLES[number];

export type Bounds = [number, number, number, number]; // [x, y, w, h] screen-space

export interface ElementRef {
  id: string;
  role: Role;
  normalized_text?: string;
}

export interface UIElement {
  id: string;
  role: Role;
  text?: string;
  normalized_text?: string;
  bounds: Bounds;
  confidence: number;
  sources: Source[];
  actionable?: boolean;
  clickable?: boolean;
  editable?: boolean;
  state?: {
    focused?: boolean;
    enabled?: boolean;
    selected?: boolean;
    expanded?: boolean;
    value?: string;
  };
}

export interface UIMap {
  snapshot_id: string;
  platform: 'macos' | 'windows' | 'linux';
  active_app: string;
  process_id?: string;
  window_id?: string;
  window_title: string;
  window_bounds: Bounds;
  display_id?: string;
  coordinate_space: 'screen';
  scale_factor?: number;
  compiled_at: string;
  sources_used: Source[];
  elements: UIElement[];
  anchors: { focused?: ElementRef; primary_action_candidate?: ElementRef };
  truncation?: { total_elements: number; returned_elements: number };
}

export type MaxCost = 'cheap' | 'ocr_ok' | 'vision_ok';
export interface CompileHints {
  purpose?: 'general' | 'find_text' | 'act';
  target_text?: string;
  max_cost?: MaxCost;
}
