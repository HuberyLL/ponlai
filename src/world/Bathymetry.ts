import { fbm2, noise3, smoothstep, smax } from './noise.ts';
import { LAND_REACH, type Footprint, type HeightFn } from './WorldShapes.ts';

// The sea floor: a shelf round the island that follows the land's distance (clamped to LAND_REACH,
// WorldShapes.ts) and world-space noise, and gives way to the open sea along an irregular edge.
// Everything here is a function of world position and the land within LAND_REACH of it, so a
// stretch of floor stays as it was wherever the land grows farther away.

// ------------------------------------------------------------------ the open sea

// The open sea's floor and beds depend on world position alone. They are sampled on a world 4 m
// lattice and interpolated on the two triangles per cell the floor's meshes draw (split by the
// diagonal from ( i + 1, j ) to ( i, j + 1 )): the far floor's mesh is that lattice, and a 0.5 m
// tile reproduces it exactly (its triangles lie inside the lattice's), so the two meet without
// a crack.
export const OPEN_LATTICE = 4;

// A lattice's values are cached by node: every floor sample reads three of them.
function onLattice( at: HeightFn ): HeightFn {

	const nodes = new Map<number, number>();
	const node = ( i: number, j: number ) => {

		const key = ( i + 32768 ) * 65536 + j + 32768;
		let v = nodes.get( key );
		if ( v === undefined ) nodes.set( key, v = at( i * OPEN_LATTICE, j * OPEN_LATTICE ) );
		return v;

	};
	return ( x, z ) => {

		const fx = x / OPEN_LATTICE, fz = z / OPEN_LATTICE;
		const i = Math.floor( fx ), j = Math.floor( fz ), u = fx - i, v = fz - j;
		if ( u + v <= 1 ) {

			const a = node( i, j );
			return a + ( node( i + 1, j ) - a ) * u + ( node( i, j + 1 ) - a ) * v;

		}
		const d = node( i + 1, j + 1 );
		return d + ( node( i, j + 1 ) - d ) * ( 1 - u ) + ( node( i + 1, j ) - d ) * ( 1 - v );

	};

}

/** The open sea's floor (m): an even depth with broad undulations, no deeper toward any centre. */
export const openSeaHeight = onLattice( ( x, z ) => - 9.35 + fbm2( x * 0.035 + 3.0, z * 0.035, 4 ) * 1.2 );

// the beds' gentle warp, so neither field lines up with the grid or the shore
function bedWarp( x: number, z: number ): [ number, number ] {

	return [ fbm2( x * 0.021 + 5.1, z * 0.021 + 1.3, 3 ) * 9, fbm2( x * 0.021 + 8.7, z * 0.021 + 6.2, 3 ) * 9 ];

}

// the seagrass meadows' field, wherever the floor is deep enough for them
function seagrass( x: number, z: number ): number {

	const [ wx, wz ] = bedWarp( x, z );
	return smoothstep( 0.1, 0.24, fbm2( ( x + wx ) * 0.07 + 11.2, ( z + wz ) * 0.07 + 4.6, 4 ) );

}

const openSeagrass = onLattice( seagrass );

/** The open sea's beds: seagrass cover in meadows, and no pale sand. */
export function openSeaBeds( x: number, z: number ): [ number, number ] {

	return [ openSeagrass( x, z ), 0 ];

}

// The open sea's mean seagrass cover (openSeaBeds over a large area), for the water's estimate of
// the floor beyond the beds it is given.
export const OPEN_SEAGRASS_MEAN = 0.157;

// ------------------------------------------------------------------ the shelf

// How wide the shelf runs along the coast, changing over a few tens of metres of coast (about
// -0.25 .. 0.25): its width is 0.6 to 1.8 times an even ring's.
const shelfWidthNoise = ( x: number, z: number ) => fbm2( x * 0.028 + 1.7, z * 0.028 - 4.2, 3 );

// Where the shelf starts to give way to the open sea (m from the coast): 6 to 12 m, wandering
// over a few tens of metres of coast, so its outer slope comes and goes instead of drawing an even
// ring round the island.
function shelfEdge( x: number, z: number ): number {

	return 6 + 6 * smoothstep( - 0.35, 0.35, fbm2( x * 0.025 - 4.1, z * 0.025 + 8.3, 3 ) );

}

// The shelf's share of the floor at a point `d` from the coast: 1 on the shelf, 0 in the open sea,
// which it reaches at LAND_REACH. The blend takes 12 to 18 m: the shelf can stand 3 to 5 m above
// the open sea where it runs wide, and an 8 m blend (an edge 8 to 16 m out, or 20 m and a ramp of
// 4 m) cut that drop as a wall of 40 to 60 degrees, steeper than sand rests; over 12 m it keeps
// to the slopes the shelf had before it was clamped.
function shelfShare( x: number, z: number, d: number ): number {

	return 1 - smoothstep( shelfEdge( x, z ), LAND_REACH, d );

}

// height of the shelf (m, negative): a shallow lagoon around the island whose floor shows through
// the water, dropping off within ~20 m into deep, even-coloured water; gentle sand waves. The
// shelf's width and depth vary along the coast through fields sampled in world space, so a larger
// footprint gets its own wide and narrow stretches without any per-tile tuning. The cliff foot
// (talus, benches) is shaped afterwards by `shapeShelf`.
function makeSeabed( fp: Footprint ): HeightFn {

	return ( x: number, z: number ) => {

		const dd = Math.max( fp.dist( x, z ), 0 );
		// Shelf width: 0.6 to 1.8 times the old even ring; a smaller warp keeps the drop-off from
		// tracing the coastline.
		const width = Math.min( 1.8, Math.max( 0.6, 1.15 + shelfWidthNoise( x, z ) * 2.4 ) );
		const warp = fbm2( x * 0.075 - 6.3, z * 0.075 + 2.9, 2 ) * 6 * smoothstep( 2, 8, dd );
		const ds = Math.max( 0, dd / width + warp );
		// a shallow lagoon: sand visible everywhere near the island, the reef edge drops off far out
		let h = - 1.6
			- 1.2 * smoothstep( 0, 5, dd )
			- 3.6 * smoothstep( 6, 26, ds );
		// the shelf's own level rises and sinks by about half a metre along the coast
		h += fbm2( x * 0.045 - 2.2, z * 0.045 + 7.4, 3 ) * 2.2 * smoothstep( 2, 6, dd ) * ( 1 - smoothstep( 16, LAND_REACH, dd ) );
		// broad undulation (the open sea's own) and a sandbar or two
		h += fbm2( x * 0.035 + 3.0, z * 0.035, 4 ) * 1.2 * smoothstep( 2, 14, dd );
		h += Math.max( 0, noise3( x * 0.06, 9.1, z * 0.06 ) ) * 1.4 * smoothstep( 6, 18, dd ) * ( 1 - smoothstep( 18, LAND_REACH, dd ) );
		return h;

	};

}

// Deepen the shelf into a basin before stones are placed. The floor belongs to the water
// column, so individual pebbles do not raise broad mounds beneath themselves.
function deepenSeabed( fp: Footprint, placementFloor: HeightFn ): HeightFn {

	return ( x: number, z: number ) => {

		const floor = placementFloor( x, z );
		const distance = fp.dist( x, z );
		// The floor deep inside the island stays put; outside it, extend the clear shelf
		// gradually into a deeper basin while keeping a continuous slope at the cliffs.
		const extraDepth = smoothstep( - 1, 3, distance ) * 1.5
			+ smoothstep( 5, 22, distance ) * 1.45;
		return floor - extraDepth;

	};

}

// The floor's highest level anywhere off the island. Benches top out here; stone crowns keep
// their own, lower budget (-1.30 m, Stones.ts), so nothing ever reaches the surface.
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
function shapeShelf( fp: Footprint, basin: HeightFn ): HeightFn {

	return ( x: number, z: number ) => {

		let h = basin( x, z );
		const d = Math.max( fp.dist( x, z ), 0 );
		if ( d > 14 ) return h;

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
		return h + ( foot - h ) * apron + lumps;

	};

}

// ------------------------------------------------------------------ the floor

/**
 * The sea floor's height (m, negative): the shelf where it lies above the open sea, blended onto
 * the open sea from its edge outward (the shelf only lifts the floor, so the floor is never below
 * the far floor and equals it from LAND_REACH out). Nothing off the island rises past the ceiling
 * (a soft minimum keeps the slope smooth), however a grown footprint's shelf happens to run.
 */
export function seabedFloor( fp: Footprint ): HeightFn {

	const shelf = shapeShelf( fp, deepenSeabed( fp, makeSeabed( fp ) ) );
	return ( x: number, z: number ) => {

		const open = openSeaHeight( x, z );
		const h = open + Math.max( 0, shelf( x, z ) - open ) * shelfShare( x, z, fp.dist( x, z ) );
		return - smax( - h, - SHELF_CEILING, 0.3 );

	};

}

// The floor's lattice (m): the near tiles sample the floor on it, and the floor is drawn as its
// triangles.
export const FLOOR_STEP = 0.5;

/**
 * The rendered floor: `seabedFloor`'s 0.5 m lattice, as the tiles store it (float32), interpolated
 * on the meshes' diagonal, so a stone seated on it sits on the triangles that are drawn.
 */
export function floorAt( fp: Footprint ): HeightFn {

	const floor = seabedFloor( fp );
	const nodes = new Map<number, number>();
	const node = ( i: number, j: number ) => {

		const key = ( i + 32768 ) * 65536 + j + 32768;
		let v = nodes.get( key );
		if ( v === undefined ) nodes.set( key, v = Math.fround( floor( i * FLOOR_STEP, j * FLOOR_STEP ) ) );
		return v;

	};
	return ( x, z ) => {

		const fx = x / FLOOR_STEP, fz = z / FLOOR_STEP;
		const i = Math.floor( fx ), j = Math.floor( fz ), u = fx - i, v = fz - j;
		if ( u + v <= 1 ) {

			const a = node( i, j );
			return a + ( node( i + 1, j ) - a ) * u + ( node( i, j + 1 ) - a ) * v;

		}
		const d = node( i + 1, j + 1 );
		return d + ( node( i, j + 1 ) - d ) * ( 1 - u ) + ( node( i + 1, j ) - d ) * ( 1 - v );

	};

}

// Seabed beds, baked per vertex so they never repeat (a texture lookup tiled every 32 m and
// drew a lattice of identical dark patches): `grass` is the seagrass and algae cover, `pale`
// the clean pale sand washed off the island. The pale sand reaches out from the cliffs in
// irregular tongues and bays rather than an even ring, and the beds start where it thins.
// Both are smooth over a few metres; the material adds the fine edge detail. Past the shelf's
// edge they blend onto the open sea's, as the floor does.
export function seabedBeds( fp: Footprint ): ( x: number, z: number ) => [ number, number ] {

	return ( x: number, z: number ) => {

		const distance = fp.dist( x, z );
		const [ wx, wz ] = bedWarp( x, z );
		const reach = distance + fbm2( ( x + wx ) * 0.05 + 2.3, ( z + wz ) * 0.05 + 7.9, 3 ) * 32;
		// The pale sand thins out across the shelf, its last silt gone by the shelf's edge.
		const shelf = ( 1 - smoothstep( 1, 12, reach ) ) * ( 0.75 + 0.25 * smoothstep( - 0.2, 0.2, fbm2( x * 0.19 + 3.3, z * 0.19 + 0.4, 2 ) ) );
		const pale = Math.max( shelf, 0.22 * ( 1 - smoothstep( 12, LAND_REACH, reach ) ) );
		const grass = seagrass( x, z ) * smoothstep( 4, 10, reach );
		const w = shelfShare( x, z, distance );
		const [ openGrass, openPale ] = openSeaBeds( x, z );
		return [ openGrass + ( grass - openGrass ) * w, openPale + ( pale - openPale ) * w ];

	};

}
