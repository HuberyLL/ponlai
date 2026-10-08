import type * as THREE from 'three/webgpu';
import type { WeatherQuality } from '../sky/Weather.ts';

// Render scale per quality preset. The scene renders at a pixel ratio of its own and the frame
// graph upscales the graded image to the canvas, which always matches the display: a smaller
// canvas stretched by the browser (bilinear) lost a third of the meadow's, cliff's and ivy's
// fine detail at 1.5 DPR.
//
// Pixel ratios of the scene's render, relative to CSS pixels, never above the display's or the
// cap (ocean optics, clouds and the post passes scale with the pixel count):
// - high: the display's own ratio, the image the reviews measure (no upscale at 1.5 DPR or less);
// - medium: a 1920x1080 pixel budget, the default as before;
// - low: a 1600x900 budget, about two thirds of medium's pixels.
export const RENDER_PIXEL_BUDGET: Readonly<Record<WeatherQuality, number>> = {
	low: 1600 * 900,
	medium: 1920 * 1080,
	high: Infinity,
};

// The canvas follows the display up to this ratio. Past it only the upscale and grade passes
// would grow (a phone's 3x), and the browser's stretch of a 2x canvas is no longer visible.
export const OUTPUT_PIXEL_RATIO_CAP = 2;

/** The scene's render pixel ratio for a `width` x `height` CSS-pixel view. `full` (an explicit
 * `?dpr` or the GUI's full-resolution control) lifts the preset's budget. */
export function renderPixelRatio( width: number, height: number, quality: WeatherQuality, full: boolean, cap: number ): number {

	const requested = Math.min( devicePixelRatio, cap );
	const budget = full ? Infinity : RENDER_PIXEL_BUDGET[ quality ];
	return Math.min( requested, Math.sqrt( budget / Math.max( width * height, 1 ) ) );

}

/** The canvas's pixel ratio: the display's, and never below the render's (an explicit `?dpr`
 * above the cap renders, and shows, at that ratio unscaled). */
export function outputPixelRatio( render: number ): number {

	return Math.max( Math.min( devicePixelRatio, OUTPUT_PIXEL_RATIO_CAP ), render );

}

/** Fixes an `rtt()` pass to a size (before its resolution scale). Left alone it follows the
 * canvas, which is larger than the scene's render while the frame is upscaled. */
export function sizeRtt( node: THREE.RTTNode, width: number, height: number ): void {

	// an RTTNode resizes itself to the canvas every frame while its width is null
	node.width = width;
	node.height = height;
	node.setSize( width, height );

}
