/**
 * Shared resolve + gate + dispatch-plan for el_NN element refs on
 * invoke_element / set_field_value. Pure (no platform calls) — the caller
 * passes the live active window so this stays unit-testable. See the Part 2
 * spec section 5.
 */
import type { UIElement, Bounds } from './ui-map-types';
import type { UIMapHolder } from './ui-map-holder';

/** Below this, an el_NN ref is too uncertain to act on. */
export const REF_MIN_CONFIDENCE = 0.5;

export type RefIntent = 'click' | 'fill';
interface ActiveWindow { processId: number; processName: string; title: string; bounds: { x: number; y: number; width: number; height: number }; }

export type RefPlan =
  | { ok: true; via: 'name'; name: string; element: UIElement }
  | { ok: true; via: 'bounds'; bounds: Bounds; element: UIElement }
  | { ok: false; error: string };

function boundsInside(b: Bounds, w: ActiveWindow['bounds']): boolean {
  const [x, y, bw, bh] = b;
  return x >= w.x && y >= w.y && x + bw <= w.x + w.width && y + bh <= w.y + w.height;
}

export function resolveRef(
  ref: { element_id?: string; snapshot_id?: string },
  holder: UIMapHolder | undefined,
  now: number,
  intent: RefIntent,
  activeWindow: ActiveWindow | null,
): RefPlan {
  const hasId = typeof ref.element_id === 'string' && ref.element_id !== '';
  const hasSnap = typeof ref.snapshot_id === 'string' && ref.snapshot_id !== '';
  if (hasId !== hasSnap) return { ok: false, error: 'provide element_id and snapshot_id together, or neither (use name)' };
  if (!holder) return { ok: false, error: 'no UIMap holder on this context' };

  const r = holder.resolve(ref.snapshot_id as string, now);
  if (!r.ok) {
    const msg = r.reason === 'unknown' ? `unknown snapshot ${ref.snapshot_id} — call compile_ui first`
      : r.reason === 'expired' ? 'snapshot expired — call compile_ui again'
      : 'stale snapshot — the screen changed; call compile_ui again';
    return { ok: false, error: msg };
  }
  const map = r.map;
  const element = map.elements.find(e => e.id === ref.element_id);
  if (!element) return { ok: false, error: `element ${ref.element_id} not in snapshot ${ref.snapshot_id}` };

  if (element.confidence < REF_MIN_CONFIDENCE) return { ok: false, error: `element ${element.id} confidence too low to act on — recompile / re-find` };
  if (intent === 'click' && (!element.actionable || element.state?.enabled === false)) return { ok: false, error: `element ${element.id} is not actionable (disabled?)` };
  if (intent === 'fill' && !element.editable) return { ok: false, error: `element ${element.id} is not editable` };

  const name = element.normalized_text ?? '';
  const uniqueName = name !== '' && map.elements.filter(e => e.normalized_text === name).length === 1;
  if (uniqueName) return { ok: true, via: 'name', name, element };

  if (!activeWindow) return { ok: false, error: 'cannot verify active window for bounds dispatch — recompile' };
  const sameWin = String(activeWindow.processId) === map.process_id || activeWindow.title === map.window_title;
  if (!sameWin) return { ok: false, error: 'window changed since compile — call compile_ui again' };
  if (!boundsInside(element.bounds, activeWindow.bounds)) return { ok: false, error: 'element is off the active window — call compile_ui again' };
  return { ok: true, via: 'bounds', bounds: element.bounds, element };
}
