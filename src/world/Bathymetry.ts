import { fbm2, smoothstep } from './noise.ts';
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
			+ smoothstep( 5, 22, distance ) * 1.2;
		return floor - extraDepth;

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
