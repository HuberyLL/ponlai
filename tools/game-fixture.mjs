// The island for the CPU-only game checks (verify-game.mjs): the page's default land (seed 1, the
// starting island), and the land IslandGrowth grows from it by a number of pieces (`inputAt`). The
// real bush sites come from the world worker's turf anchors (node cannot run it), so the island
// gets deterministic stand-ins: ~30 bushes crowded along the rim like FoliageSites, a few inland.
import { buildFootprint, landBounds } from '../src/world/WorldShapes.ts';
import { growLand } from '../src/world/IslandGrowth.ts';
import { mulberry32 } from '../src/world/noise.ts';

function syntheticBushes( land ) {

	const fp = buildFootprint( land ), b = landBounds( land ), rng = mulberry32( 99 );
	const out = [];
	for ( let tries = 0; tries < 20000 && out.length < 30; tries ++ ) {

		const x = b.x0 + rng() * ( b.x1 - b.x0 ), z = b.z0 + rng() * ( b.z1 - b.z0 );
		const d = fp.dist( x, z );
		const rim = d > - 2.2 && d < - 0.6;
		if ( d > - 0.6 || ( ! rim && rng() > 0.15 ) ) continue;
		const r = 0.35 + Math.pow( rng(), 1.5 ) * 0.75;
		if ( out.some( ( s ) => Math.hypot( s.x - x, s.z - z ) < ( s.r + r ) * 0.75 ) ) continue;
		out.push( { x, z, r } );

	}
	return out;

}

/** The island grown by `step` pieces after the starting island (seed 1), with its stand-in bushes. */
export function inputAt( step ) {

	const { land } = growLand( 1, step );
	return { land, bushes: syntheticBushes( land ) };

}

export const input = inputAt( 0 );
