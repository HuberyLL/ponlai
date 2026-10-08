import { fbm2, noise3, smoothstep, smax } from './noise.ts';
import type { Footprint, HeightFn } from './WorldShapes.ts';

// Deepen the shelf into a basin before stones are placed. The floor belongs to the water
// column, so individual pebbles do not raise broad mounds beneath themselves.
export function deepenSeabed( footprint: Footprint, placementFloor: HeightFn ): HeightFn {

	return ( x: number, z: number ) => {

		const floor = placementFloor( x, z );
		const distance = footprint.dist( x, z );
		// The floor deep inside the island stays put; outside it, extend the clear shelf
		// gradually into a deeper basin while keeping a continuous slope at the cliffs.
		const extraDepth = smoothstep( - 1, 3, distance ) * 1.5
			+ smoothstep( 5, 22, distance ) * 1.45;
		return floor - extraDepth;

	};

}

// The floor's highest level anywhere off the island. Benches top out here; stone crowns keep
// their own, lower budget (-1.30 m, makeRocks), so nothing ever reaches the surface.
export const SHELF_CEILING = - 1.6;

// The cliff foot: a talus apron and, in places, shallow rock benches. Both are derived from the
// footprint's distance and world-space noise only, so every stretch of a grown coast gets its own
// mix of steep aprons, broad benches and plain sand without placing anything by hand.
//  - Talus: debris piled against the wall slopes away steeply and eases out onto the shelf
//    (concave, like a scree apron), its foot level and reach varying along the coast. It
//    replaces an even scour trough that ringed the island at one depth.
//  - Benches: wave-cut platforms left in front of retreating cliffs (shore platforms) stand
//    1.6 - 2.2 m deep for a few metres, then step down to the shelf over a short, steep edge.
// Shore-platform and talus morphology after Trenhaile, "The Geomorphology of Rock Coasts" (1987);
// the shapes here are art-directed, not modelled.
export function shapeShelf( footprint: Footprint, basin: HeightFn ): HeightFn {

	// Nothing off the island rises past the ceiling (a soft minimum keeps the slope smooth),
	// however a grown footprint's basin happens to run.
	const ceiling = ( h: number ) => - smax( - h, - SHELF_CEILING, 0.3 );
	return ( x: number, z: number ) => {

		let h = basin( x, z );
		const distance = footprint.dist( x, z );
		const d = Math.max( distance, 0 );
		if ( d > 14 ) return ceiling( h );

		// benches: a few per hundred metres of coast, each a few metres wide
		const benchField = noise3( x * 0.042 + 3.1, 17.3, z * 0.042 - 8.6 );
		const bench = smoothstep( 0.06, 0.20, benchField );
		if ( bench > 0 ) {

			const level = - 1.7 - 0.5 * smoothstep( - 0.3, 0.3, noise3( x * 0.09 - 1.4, 2.6, z * 0.09 + 5.1 ) );
			const reach = 3.5 + 5.5 * smoothstep( 0.12, 0.4, benchField ) + fbm2( x * 0.16 + 4.4, z * 0.16 - 0.7, 2 ) * 5;
			// a slight outward fall and a 40 degree edge; below the basin it has no effect
			const top = level - 0.05 * d - Math.max( 0, d - reach ) * 0.85
				+ fbm2( x * 0.42 + 9.1, z * 0.42 - 3.3, 2 ) * 0.16;
			h = smax( h, top - ( 1 - bench ) * 3, 0.5 );

		}

		// talus: the foot level and the apron's reach vary along the coast; a bench keeps its own
		const foot = h + ( - 2.35 + noise3( x * 0.11 + 6.2, 1.9, z * 0.11 - 2.8 ) * 0.9 - h ) * ( 1 - bench );
		const reach = 2.4 + 3.2 * smoothstep( - 0.3, 0.3, noise3( x * 0.07 - 3.7, 6.4, z * 0.07 + 1.2 ) );
		const t = Math.min( 1, d / reach );
		const apron = Math.pow( 1 - t, 1.6 );
		// blocky lumps of fallen debris on the apron, too small to be stones of their own
		const lumps = ( noise3( x * 0.75 + 0.3, 3.3, z * 0.75 - 7.7 ) * 0.22 + noise3( x * 1.7, 8.8, z * 1.7 ) * 0.07 ) * apron;
		h = h + ( foot - h ) * apron + lumps;

		return ceiling( h );

	};

}

// Seabed beds, baked per vertex so they never repeat (a texture lookup tiled every 32 m and
// drew a lattice of identical dark patches): `grass` is the seagrass and algae cover, `pale`
// the clean pale sand washed off the island. The pale sand reaches out from the cliffs in
// irregular tongues and bays rather than an even ring, and the beds start where it thins.
// Both are smooth over a few metres; the material adds the fine edge detail.
export function seabedBeds( footprint: Footprint ): ( x: number, z: number ) => [ number, number ] {

	return ( x: number, z: number ) => {

		const distance = footprint.dist( x, z );
		// a gentle warp so neither field lines up with the grid or the shore
		const wx = fbm2( x * 0.021 + 5.1, z * 0.021 + 1.3, 3 ) * 9;
		const wz = fbm2( x * 0.021 + 8.7, z * 0.021 + 6.2, 3 ) * 9;
		const reach = distance + fbm2( ( x + wx ) * 0.05 + 2.3, ( z + wz ) * 0.05 + 7.9, 3 ) * 32;
		// Beyond the shelf the sand silts up and darkens slowly toward the open basin.
		const shelf = ( 1 - smoothstep( 1, 12, reach ) ) * ( 0.75 + 0.25 * smoothstep( - 0.2, 0.2, fbm2( x * 0.19 + 3.3, z * 0.19 + 0.4, 2 ) ) );
		const pale = Math.max( shelf, 0.22 * ( 1 - smoothstep( 12, 45, reach ) ) );
		const meadow = fbm2( ( x + wx ) * 0.07 + 11.2, ( z + wz ) * 0.07 + 4.6, 4 );
		const grass = smoothstep( 0.1, 0.24, meadow ) * smoothstep( 4, 10, reach );
		return [ grass, pale ];

	};

}
