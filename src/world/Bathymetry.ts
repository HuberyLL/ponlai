import { smoothstep } from './noise.ts';
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
