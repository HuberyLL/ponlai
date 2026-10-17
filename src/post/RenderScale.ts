import type { RenderScaleRule } from '../Quality.ts';

// Render scale per quality tier (`QualityProfile.render` in Quality.ts). The scene renders at a
// pixel ratio of its own and the frame graph upscales the graded image to the canvas, which always
// matches the display: a smaller canvas stretched by the browser (bilinear) lost a third of the
// meadow's, cliff's and ivy's fine detail at 1.5 DPR.
//
// Pixel ratios of the scene's render, relative to CSS pixels, never above the display's or the
// cap (ocean optics, clouds and the post passes scale with the pixel count):
// - high: a budget of native 4K's pixels, so the display's own ratio (up to OUTPUT_PIXEL_RATIO_CAP:
//   native 4K on a 2x display at 1920x1080), never steered: no upscale, no dynamic resolution;
// - medium and low (parked, Quality.ts): a budget of rendered pixels (1600x900 and 1280x720 today);
//   `?dpr` and the GUI's full resolution lift it;
// - a dynamic rule (no tier uses one today): steered by the GPU's frame time
//   (DynamicResolution.ts) between the display's ratio and a floor; a load starts at, and a paused
//   or pinned page holds, its baseline share of the maximum. This returns the baseline as the
//   nominal, `dynamicMaxRatio` the top of the range.
// The canvas always matches the display (up to OUTPUT_PIXEL_RATIO_CAP): a render below it is
// upscaled inside the frame graph with FSR 1 and the grain added after, never stretched by the
// browser. Every pass is sized to the render, not the canvas (the frame graph sizes each target by
// its size class). At the display's ratio nothing is upscaled, so `dpr=1` captures are unchanged. The
// tiers never save through multisampling: every one draws the scene at 4x (Quality.ts).

// The canvas follows the display up to this ratio. Past it only the upscale and grade passes
// would grow (a phone's 3x), and the browser's stretch of a 2x canvas is no longer visible.
export const OUTPUT_PIXEL_RATIO_CAP = 2;

/** The scene's nominal render pixel ratio for a `width` x `height` CSS-pixel view: the tier's
 * budget, or a dynamic tier's baseline. `full` (an explicit `?dpr` or the GUI's full-resolution
 * control) lifts the budget and pins the ratio at the display's (or `?dpr`'s). */
export function renderPixelRatio( width: number, height: number, rule: RenderScaleRule, full: boolean, cap: number ): number {

	const requested = Math.min( devicePixelRatio, cap );
	if ( full ) return requested;
	if ( 'dynamic' in rule ) return dynamicMaxRatio( rule, cap ) * rule.dynamic.baselineShare;
	return Math.min( requested, Math.sqrt( rule.budget / Math.max( width * height, 1 ) ) );

}

/** The top of a dynamic tier's range: the display's ratio, up to the cap and the tier's `max`. */
export function dynamicMaxRatio( rule: Extract<RenderScaleRule, { dynamic: unknown }>, cap: number ): number {

	return Math.min( devicePixelRatio, cap, rule.dynamic.max );

}

/** The canvas's pixel ratio: the display's, and never below the render's (an explicit `?dpr`
 * above the cap renders, and shows, at that ratio unscaled). */
export function outputPixelRatio( render: number ): number {

	return Math.max( Math.min( devicePixelRatio, OUTPUT_PIXEL_RATIO_CAP ), render );

}
