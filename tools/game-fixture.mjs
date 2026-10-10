// The island for the CPU-only game checks (verify-game.mjs).
// The real bush and plant sites come from the world worker's turf anchors (node cannot run it), so
// the island gets deterministic stand-ins: ~30 bushes crowded along the rim like FoliageSites, a few
// inland, and shrub groups with three small trees on the plateau, kept off the puddle hollows and
// the walking loop as PlantSites keeps them (the real island has about 60 plants, three of them
// trees).
import { buildFootprint, layoutBounds } from '../src/world/WorldShapes.ts';
import { mulberry32 } from '../src/world/noise.ts';
import { puddleGround } from '../src/weather/PuddleHollows.ts';
import { walkLoopDistance } from '../src/world/WalkLoop.ts';

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

function syntheticPlants( bushes ) {

	const fp = buildFootprint(), b = layoutBounds(), rng = mulberry32( 101 ), clearance = walkLoopDistance();
	const out = [];
	const free = ( x, z, r, path = 1.5 ) => ! puddleGround( x, z ) && fp.dist( x, z ) < - 1.5 - r && clearance( x, z ) > r + path
		&& ! bushes.some( ( s ) => Math.hypot( s.x - x, s.z - z ) < ( s.r + r ) * 0.65 )
		&& ! out.some( ( s ) => Math.hypot( s.x - x, s.z - z ) < ( s.r + r ) * 0.62 );
	const spot = ( inside ) => {

		const x = b.x0 + rng() * ( b.x1 - b.x0 ), z = b.z0 + rng() * ( b.z1 - b.z0 );
		return fp.dist( x, z ) < inside ? { x, z } : null;

	};
	for ( let tries = 0, trees = 0; tries < 2000 && trees < 3; tries ++ ) {

		const p = spot( - 4 );
		if ( ! p || ! free( p.x, p.z, 0.5, 4.5 ) || out.some( ( t ) => Math.hypot( t.x - p.x, t.z - p.z ) < 7 ) ) continue;
		out.push( { x: p.x, z: p.z, r: 1.2 } );
		trees ++;

	}
	for ( let tries = 0, groups = 0; tries < 4000 && groups < 10; tries ++ ) {

		const g = spot( - 2.5 );
		if ( ! g || ! free( g.x, g.z, 0.6 ) ) continue;
		groups ++;
		const members = 4 + Math.floor( rng() * 3 );
		for ( let m = 0, k = 0; m < members && k < members * 8; k ++ ) {

			const a = rng() * Math.PI * 2, d = m === 0 ? 0 : 0.6 + rng() * 1.2;
			const x = g.x + Math.cos( a ) * d, z = g.z + Math.sin( a ) * d, r = 0.4 + rng() * 0.5;
			if ( ! free( x, z, r ) ) continue;
			out.push( { x, z, r } );
			m ++;

		}

	}
	return out;

}

const bushes = syntheticBushes();
export const input = { bushes, plants: syntheticPlants( bushes ) };
