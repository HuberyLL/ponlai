// The scene's multisample count, read once at load. Pipeline sizes its colour target and depth
// resolve by it, and the alpha-to-coverage vegetation tunes its coverage to it (with 2 samples a
// partly covered pixel has only 0, 1/2 or full coverage). 4 is today's image; 2 is the candidate
// for the quality tiers, which will set it instead of the `msaa` URL option.
export type SceneSampleCount = 2 | 4;

export const SCENE_SAMPLES: SceneSampleCount = new URLSearchParams( location.search ).get( 'msaa' ) === '2' ? 2 : 4;
