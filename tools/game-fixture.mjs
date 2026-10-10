// The island for the CPU-only game checks (verify-game.mjs).
// The real bush sites come from the world worker's turf anchors (node cannot run it), so the
// island gets deterministic stand-ins: ~30 bushes crowded along the rim like FoliageSites, a few
// inland.
import { buildFootprint, layoutBounds } from '../src/world/WorldShapes.ts';
import { mulberry32 } from '../src/world/noise.ts';

function syntheticBushes() {

	const fp = buildFootprint(), b = layoutBounds(), rng = mulberry32( 99 );
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

export const input = { bushes: syntheticBushes() };
