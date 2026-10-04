import { smoothstep } from './noise.ts';
import type { Footprint, HeightFn } from './WorldShapes.ts';
import type { Rock } from './types.ts';

// A deeper shelf gives the water a visible column between the surface and the sand. Keep
// the original floor beneath each fixed boulder: lowering its placement would change the
// layout, and lowering only the floor under it would leave a floating rock.
export function deepenSeabed( footprint: Footprint, rocks: Rock[], placementFloor: HeightFn ): HeightFn {

	const contacts = rocks.map( ( rock ) => ( {
		x: rock.x, z: rock.z,
		radius2: ( rock.s * 4.0 + 3.0 ) ** 2,
	} ) );

	return ( x: number, z: number ) => {

		const floor = placementFloor( x, z );
		const distance = footprint.dist( x, z );
		// The floor inside the island stays put; a gradual slope outside it remains above
		// the island and stack feet. Farther out, extend the clear shelf into a deeper basin.
		const extraDepth = smoothstep( - 1, 3, distance ) * 1.5
			+ smoothstep( 5, 22, distance ) * 1.2;
		if ( extraDepth === 0 ) return floor;

		let basin = 1;
		for ( const contact of contacts ) {

			const radius2 = ( x - contact.x ) ** 2 + ( z - contact.z ) ** 2;
			if ( radius2 >= contact.radius2 ) continue;
			// A broad mound, flat only at its centre, avoids bright plateau edges. Product
			// blending also keeps overlapping slopes smooth instead of introducing min seams.
			basin *= smoothstep( 0, contact.radius2, radius2 );
			if ( basin === 0 ) return floor;

		}

		return floor - extraDepth * basin;

	};

}
