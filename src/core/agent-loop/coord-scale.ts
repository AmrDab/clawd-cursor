/**
 * Shared screenshot↔screen coordinate scaling.
 *
 * Two coordinate spaces exist and MUST NOT be mixed:
 *   - SCREEN space — the coordinate system the OS mouse driver consumes.
 *     Accessibility-snapshot coords are already in this space.
 *   - IMAGE space — the downscaled screenshot the model sees, capped at
 *     LLM_TARGET_WIDTH (1280). A target read off the screenshot is in this
 *     space and must be multiplied by `imageScale` to reach screen space.
 *
 * The vision `mouse` compound tool always works in IMAGE space and scales. The
 * granular click/drag/scroll tools default to SCREEN space (a11y coords pass
 * through) but accept IMAGE-space coords when the agent had to read a target
 * off the screenshot (e.g. an empty-a11y webview). Centralising the factor
 * here keeps both paths identical — the earlier bug was the granular tools
 * NOT scaling image coords, so a 1280-space click landed at half-position.
 *
 * PLATFORM NOTE — macOS Retina / HiDPI (#154):
 *   nut-js on macOS drives the cursor in LOGICAL POINTS (Cocoa/CGEvent space),
 *   not physical pixels. On a 2× Retina panel the physical width is double the
 *   logical width (e.g. 4480 physical / 2240 logical), so if we scaled
 *   image → physical the click would land twice as far right as intended.
 *   The correct target for the mouse driver is LOGICAL coords:
 *
 *     mouseScale(macOS)  = logicalWidth  / LLM_TARGET_WIDTH
 *     mouseScale(others) = physicalWidth / LLM_TARGET_WIDTH
 *
 *   The SCREENSHOT coordinate space is unchanged — screenshots are captured at
 *   physical resolution and downscaled to LLM_TARGET_WIDTH regardless of OS.
 *   Only the MOUSE INPUT mapping differs.
 */

/** Width the screenshot is downscaled to before the model sees it. Keep in
 *  sync with the maxWidth passed to adapter.screenshot() and the native layer. */
export const LLM_TARGET_WIDTH = 1280;

/**
 * Factor to convert IMAGE-space (screenshot) coords to the OS mouse driver's
 * coordinate space. 1 when the effective width ≤ screenshot width.
 *
 * On macOS nut-js drives in LOGICAL POINTS, so we scale image → logical.
 * On Windows / Linux nut-js drives in PHYSICAL PIXELS, so we scale image → physical.
 *
 * `ctx.screen.logicalWidth` is populated by MacOSAdapter.getScreenSize().
 * `ctx.screen.physicalWidth` is populated by all adapters.
 */
export function imageScale(ctx: {
  screen?: { physicalWidth?: number; logicalWidth?: number };
  _platform?: string; // injectable for tests; defaults to process.platform
}): number {
  const platform = ctx._platform ?? process.platform;
  if (platform === 'darwin') {
    // macOS: nut-js mouse operates in logical points.
    const lw = ctx.screen?.logicalWidth ?? 0;
    if (lw > 0) {
      return lw > LLM_TARGET_WIDTH ? lw / LLM_TARGET_WIDTH : 1;
    }
    // logicalWidth unavailable: fall back to physical (best effort — will
    // still be wrong on Retina but avoids a silent ×1 regress).
    const pw = ctx.screen?.physicalWidth ?? 0;
    return pw > LLM_TARGET_WIDTH ? pw / LLM_TARGET_WIDTH : 1;
  }
  // Windows / Linux: nut-js mouse operates in physical pixels.
  const w = ctx.screen?.physicalWidth ?? 0;
  return w > LLM_TARGET_WIDTH ? w / LLM_TARGET_WIDTH : 1;
}

/** Round a coordinate after scaling. */
export function scaleCoord(v: number, scale: number): number {
  return Math.round(v * scale);
}
