import { readLook } from './Look.ts';

// The ambient occlusion's look table, as the renderer reads it (look/Look.ts: the number is the
// installed look's, the neutral set's where none is): the floor a surface's occlusion keeps. The
// screen-space occlusion's kernel (its reach, cutoff and base) is the method's, and stays in
// post/GTAO.ts, which holds the floor's shader function too (`floorOcclusion`).

const LOOK = readLook( 'occlusion', 'look/OcclusionLook.ts' );

/** The least ambient occlusion a surface keeps where its own occlusion and the screen's multiply:
 * the deepest crevice or contact still takes a share of the ambient light and never turns black. */
export const AO_FLOOR = LOOK.floor;
