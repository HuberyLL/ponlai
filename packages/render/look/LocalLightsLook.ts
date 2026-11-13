import { readLook } from './Look.ts';

// The local lights' look table, as the renderer reads it (look/Look.ts: the number is the installed
// look's, the neutral set's where none is): the gain over the sources' own intensity. The clusters
// and the sources' falloff are the method's and stay in lighting/LocalLights.ts.

const LOOK = readLook( 'localLights', 'look/LocalLightsLook.ts' );

/** The gain on every source's own intensity (lighting/LocalLights.ts `gain` starts from it). */
export const GAIN = LOOK.gain;
