import { readLook } from './Look.ts';

// The meadow canopy's look table, as the renderer reads it (look/Look.ts: the numbers are the
// installed look's, the neutral set's where none is): the two media the key crosses inside a
// meadow, which lighting/MeadowCanopy.ts takes as its uniforms' values. How the light falls off
// through them (the paths, their steps and limits) is the method's and stays there.

const LOOK = readLook( 'meadowCanopy', 'look/MeadowCanopyLook.ts' );

/** The level canopy's medium (lighting/MeadowCanopy.ts `meadowCanopy`). */
export const MEADOW_CANOPY = { ...LOOK.canopy };

/** The crowns' medium (lighting/MeadowCanopy.ts `meadowCast`). */
export const MEADOW_CAST = { ...LOOK.cast };
