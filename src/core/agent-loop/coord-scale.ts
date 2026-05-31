/**
 * Shared screenshot↔screen coordinate scaling.
 *
 * Two coordinate spaces exist and MUST NOT be mixed:
 *   - SCREEN space — physical pixels the OS mouse layer consumes (e.g. 2560
 *     wide). Accessibility-snapshot coords are already in this space.
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
 * OS-agnostic: the only input is the adapter-reported physical width.
 */

/** Width the screenshot is downscaled to before the model sees it. Keep in
 *  sync with the maxWidth passed to adapter.screenshot() and the native layer. */
export const LLM_TARGET_WIDTH = 1280;

/**
 * Factor to convert IMAGE-space (screenshot) coords to SCREEN-space (physical).
 * 1 when the screen is no wider than the screenshot (no downscale).
 */
export function imageScale(ctx: { screen?: { physicalWidth?: number } }): number {
  const w = ctx.screen?.physicalWidth ?? 0;
  return w > LLM_TARGET_WIDTH ? w / LLM_TARGET_WIDTH : 1;
}

/** Round a coordinate after scaling. */
export function scaleCoord(v: number, scale: number): number {
  return Math.round(v * scale);
}
