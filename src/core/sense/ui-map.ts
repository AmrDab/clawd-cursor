/**
 * UI State Compiler (Layer A). Fuses a11y + OCR + (lazy) vision + window/display
 * metadata into one UIMap. Pure orchestration over injected sources so it is
 * unit-testable with no real UIA/OCR. See the design spec
 * docs/superpowers/specs/2026-06-07-ui-state-compiler-design.md.
 */
import type { PlatformAdapter, ScreenshotResult } from '../../platform/types';
import type { Snapshot } from './types';
import type { OcrResult } from '../../platform/ocr-engine';
import type { UIMap, UIElement, Source, CompileHints } from './ui-map-types';
import { a11yToUI, ocrToUI } from './ui-map-elements';
import { fuse } from './ui-map-fuse';

const SPARSE_A11Y_MAX = 0;          // ≤ this many named a11y elements ⇒ "sparse"
const LOW_CONFIDENCE = 0.5;         // below this on a needed element ⇒ vision-worthy

export interface CompileDeps {
  /** a11y spine — defaults to captureSnapshot(adapter) in production. */
  captureSnapshot: () => Promise<Snapshot>;
  /** OCR puller — defaults to () => new OcrEngine().recognizeScreen(). */
  ocr: () => Promise<OcrResult>;
  /** Vision puller — defaults to adapter.screenshot(). */
  vision: () => Promise<ScreenshotResult>;
  getScreenSize: PlatformAdapter['getScreenSize'];
  getFocusedElement: PlatformAdapter['getFocusedElement'];
  /** Caller-passed clock + id (pure: no Date.now in this module). */
  now: number;
  snapshotId: string;
}

function namedCount(snap: Snapshot): number {
  return snap.elements.filter(e => (e.name ?? '').trim().length > 0).length;
}

export async function compileUIMap(deps: CompileDeps, hints: CompileHints): Promise<UIMap> {
  const maxCost = hints.max_cost ?? 'ocr_ok';
  const sourcesUsed: Source[] = ['window'];

  const snap = await deps.captureSnapshot();
  if (snap.sources.includes('a11y')) sourcesUsed.push('a11y');

  let elements: UIElement[] = snap.elements.map((se, i) => a11yToUI(se, `el_${i}`));

  // Lazy OCR: only when a11y is sparse OR a requested target_text isn't present.
  const sparse = namedCount(snap) <= SPARSE_A11Y_MAX;
  const wantText = hints.target_text ? hints.target_text.trim().toLowerCase() : '';
  const a11yHasTarget = wantText
    ? elements.some(e => (e.normalized_text ?? '').includes(wantText))
    : true;
  const ocrAllowed = maxCost === 'ocr_ok' || maxCost === 'vision_ok';
  if (ocrAllowed && (sparse || !a11yHasTarget)) {
    const ocrRes = await deps.ocr();
    if (ocrRes.elements.length > 0) {
      sourcesUsed.push('ocr');
      const base = elements.length;
      elements = fuse([...elements, ...ocrRes.elements.map((oe, i) => ocrToUI(oe, `el_${base + i}`))]);
    }
  }

  // Lazy vision: only when allowed AND nothing usable surfaced from a11y+OCR.
  const visionAllowed = maxCost === 'vision_ok';
  const nothingActionable = !elements.some(e => e.actionable && e.confidence >= LOW_CONFIDENCE);
  if (visionAllowed && nothingActionable) {
    await deps.vision();           // (vision-source fusion handled in a later task/Part 2)
    sourcesUsed.push('vision');
  }

  // Re-id ids contiguously after fusion so el_NN is dense within this snapshot.
  elements = elements.map((e, i) => ({ ...e, id: `el_${i}` }));

  const screen = await deps.getScreenSize();
  const aw = snap.activeWindow;
  return {
    snapshot_id: deps.snapshotId,
    platform: snap.platform,
    active_app: aw?.processName ?? '',
    process_id: aw ? String(aw.processId) : undefined,
    window_title: aw?.title ?? '',
    window_bounds: aw ? [aw.bounds.x, aw.bounds.y, aw.bounds.width, aw.bounds.height] : [0, 0, 0, 0],
    coordinate_space: 'screen',
    scale_factor: screen.dpiRatio,
    compiled_at: String(deps.now),
    sources_used: sourcesUsed,
    elements,
    anchors: {},                   // filled in Task 6
  };
}
