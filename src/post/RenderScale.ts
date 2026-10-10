import type { RenderScaleRule } from '../Quality.ts';

// Render scale per quality tier (`QualityProfile.render` in Quality.ts). The scene renders at a
// pixel ratio of its own and the frame graph upscales the graded image to the canvas, which always
// matches the display: a smaller canvas stretched by the browser (bilinear) lost a third of the
// meadow's, cliff's and ivy's fine detail at 1.5 DPR.
//
// Pixel ratios of the scene's render, relative to CSS pixels, never above the display's or the
// cap (ocean optics, clouds and the post passes scale with the pixel count):
// - high: dynamic, from the display's own ratio (up to 1.5, the image the reviews measure) down to
//   a floor, steered by the GPU's frame time (DynamicResolution.ts); this returns its nominal;
// - medium and low: a budget of rendered pixels (1600x900 and 1280x720 today).

// The canvas follows the display up to this ratio. Past it only the upscale and grade passes
// would grow (a phone's 3x), and the browser's stretch of a 2x canvas is no longer visible.
export const OUTPUT_PIXEL_RATIO_CAP = 2;

/** The scene's nominal render pixel ratio for a `width` x `height` CSS-pixel view: the tier's
 * budget, or a dynamic tier's maximum. `full` (an explicit `?dpr` or the GUI's full-resolution
 * control) lifts the budget. */
export function renderPixelRatio( width: number, height: number, rule: RenderScaleRule, full: boolean, cap: number ): number {

	const requested = Math.min( devicePixelRatio, cap );
	if ( full ) return requested;
	if ( 'dynamic' in rule ) return Math.min( requested, rule.dynamic.max );
	return Math.min( requested, Math.sqrt( rule.budget / Math.max( width * height, 1 ) ) );

}

/** The canvas's pixel ratio: the display's, and never below the render's (an explicit `?dpr`
 * above the cap renders, and shows, at that ratio unscaled). */
export function outputPixelRatio( render: number ): number {

	return Math.max( Math.min( devicePixelRatio, OUTPUT_PIXEL_RATIO_CAP ), render );

}
