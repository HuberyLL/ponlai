// The simulation's one random generator: mulberry32 with its state kept in SimState.
//
// The simulation's one random generator: mulberry32 (as packages/render/util/noise.ts) with its whole state
// kept in SimState.rng, so a save carries it and a loaded game draws the same numbers next.

export interface RngState { rng: number }

/** uniform in [ 0, 1 ) */
export function random( state: RngState ): number {

	const a = ( state.rng + 0x6D2B79F5 ) >>> 0;
	state.rng = a;
	let t = a;
	t = Math.imul( t ^ ( t >>> 15 ), t | 1 );
	t ^= t + Math.imul( t ^ ( t >>> 7 ), t | 61 );
	return ( ( t ^ ( t >>> 14 ) ) >>> 0 ) / 4294967296;

}

