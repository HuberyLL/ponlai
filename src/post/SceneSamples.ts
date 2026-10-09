// The scene's multisample count, read once at load. Pipeline sizes its colour target and depth
// resolve by it, and the vegetation picks its coverage path by it (`ALPHA_TO_COVERAGE` in
// Foliage.ts). WebGPU multisamples with 1 or 4 samples only (three turns any other count into 1),
// so the choice is 4, today's image, or 1, no multisampling: leaves then take a plain alpha test
// and grass blades an ordered dither. `msaa=1` selects it; `msaa=2` is read as 1 too, since a
// request for 2 samples renders single-sampled. The quality tiers will set it instead of the URL.
export type SceneSampleCount = 1 | 4;

const requested = new URLSearchParams( location.search ).get( 'msaa' );
export const SCENE_SAMPLES: SceneSampleCount = requested === '1' || requested === '2' ? 1 : 4;
