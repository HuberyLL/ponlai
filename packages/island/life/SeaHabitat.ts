import type { ShoreField } from '../../render/data.ts';
import { hash3i, mulberry32 } from '../../render/data.ts';
import type { Rock, WorldData } from '../world/types.ts';
import { openSeaBeds, openSeaHeight } from '../world/Bathymetry.ts';
import { LAND_REACH } from '../world/WorldShapes.ts';

// What the sea offers its life at a point: the distance from the coast, the floor's depth, the
// seagrass, the stones; and the measures the numbers of each kind follow.
//
// Everything here reads the land's own fields (WorldData: the shore's signed distance, the rendered
// floor's height and its beds), so a creature's habitat is a function of the land, and nothing is
// placed by hand. Past the fields' bounds the open sea's own functions answer (Bathymetry.ts
// openSeaHeight, openSeaBeds: functions of world position alone), and the distance from the coast
// reads LAND_REACH or more there: the shore's field is clamped to it, so the habitat tells only
// "at least that far out" beyond it. A kind that keeps well off the coast measures its own distance
// from the island's outline instead (SwimPath.ts `ring`).

// bilinear lookup in a world field's channel `c` of `stride` (texel centres at x0 + ( i + 0.5 ) *
// cell); NaN outside
function lookup( f: ShoreField, stride = 1, c = 0 ): ( x: number, z: number ) => number {

	return ( x, z ) => {

		const fx = ( x - f.x0 ) / f.cell - 0.5, fz = ( z - f.z0 ) / f.cell - 0.5;
		const i = Math.floor( fx ), j = Math.floor( fz );
		if ( i < 0 || j < 0 || i + 1 >= f.nx || j + 1 >= f.nz ) return NaN;
		const u = fx - i, v = fz - j, d = f.data, k = j * f.nx + i;
		const at = ( n: number ) => d[ n * stride + c ];
		return ( at( k ) * ( 1 - u ) + at( k + 1 ) * u ) * ( 1 - v ) + ( at( k + f.nx ) * ( 1 - u ) + at( k + f.nx + 1 ) * u ) * v;

	};

}

/** The sea's habitat over a land (WorldData). */
export class SeaHabitat {

	/** The island's centroid on the sea level's section and its outline's mean radius (m). */
	readonly centre: { x: number; z: number; radius: number };
	/** The coast's length (m) and the shelf's area shallower than 6 m (m²). */
	readonly coastLength: number;
	readonly shelfArea: number;
	/** The area of seagrass meadow (cover-weighted, m²) within the fields' bounds. */
	readonly meadowArea: number;
	readonly rocks: readonly Rock[];
	/** The fields' bounds (m). */
	readonly bounds: { x0: number; z0: number; x1: number; z1: number };
	private readonly coastAt: ( x: number, z: number ) => number;
	private readonly floorAt: ( x: number, z: number ) => number;
	private readonly grassAt: ( x: number, z: number ) => number;

	constructor( data: WorldData ) {

		this.coastAt = lookup( data.shore );
		this.floorAt = lookup( data.seabedField );
		this.grassAt = lookup( data.seabedBeds, 2, 0 );
		this.rocks = data.rocks;
		const f = data.shore;
		this.bounds = { x0: f.x0, z0: f.z0, x1: f.x0 + f.nx * f.cell, z1: f.z0 + f.nz * f.cell };
		const m = measure( this, f );
		this.centre = m.centre;
		this.coastLength = m.coastLength;
		this.shelfArea = m.shelfArea;
		this.meadowArea = m.meadowArea;

	}

	/** The signed distance from the coast (m, > 0 at sea); LAND_REACH past the shore's field. */
	coast( x: number, z: number ): number {

		const d = this.coastAt( x, z );
		return Number.isNaN( d ) ? LAND_REACH : d;

	}

	/** The floor's height (m, < 0 under the sea). */
	floor( x: number, z: number ): number {

		const h = this.floorAt( x, z );
		return Number.isNaN( h ) ? openSeaHeight( x, z ) : h;

	}

	/** The seagrass cover (0 .. 1). */
	grass( x: number, z: number ): number {

		const g = this.grassAt( x, z );
		return Number.isNaN( g ) ? openSeaBeds( x, z )[ 0 ] : g;

	}

	/** Cells of a world-anchored grid of `cell` metres whose jittered point `fits`, in the order of a
	 * hash of their own (salted by `salt`): the candidates a kind takes its homes from, so the
	 * layout is a function of the land alone. */
	candidates( cell: number, salt: number, fits: ( x: number, z: number ) => boolean, margin = 0 ): { x: number; z: number; seed: number }[] {

		const B = this.bounds, out: { x: number; z: number; seed: number; key: number }[] = [];
		for ( let cj = Math.floor( ( B.z0 - margin ) / cell ); cj * cell < B.z1 + margin; cj ++ ) for ( let ci = Math.floor( ( B.x0 - margin ) / cell ); ci * cell < B.x1 + margin; ci ++ ) {

			// (an integer: the generator takes its seed's 32 bits)
			const seed = Math.floor( hash3i( ci, cj, salt ) * 4294967296 );
			const rng = mulberry32( seed );
			const x = ( ci + 0.5 + ( rng() - 0.5 ) * 0.8 ) * cell, z = ( cj + 0.5 + ( rng() - 0.5 ) * 0.8 ) * cell;
			if ( fits( x, z ) ) out.push( { x, z, seed, key: rng() } );

		}
		out.sort( ( a, b ) => a.key - b.key );
		return out;

	}

	/** Picks up to `count` of `cands` at least `apart` metres from each other. */
	static spread<T extends { x: number; z: number }>( cands: readonly T[], count: number, apart: number ): T[] {

		const out: T[] = [];
		for ( const c of cands ) {

			if ( out.length >= count ) break;
			if ( out.some( ( o ) => Math.hypot( o.x - c.x, o.z - c.z ) < apart ) ) continue;
			out.push( c );

		}
		return out;

	}

}

// The coast's length on the shore's field (the crossings of its zero between neighbours of a 0.5 m
// lattice, times the spacing, times pi / 4: a curve's crossings of a square lattice count its
// length in the city-block metric, 4 / pi times its own on average), the shelf's and the meadows'
// areas, and the land's centroid and mean radius.
function measure( H: SeaHabitat, f: ShoreField ) {

	const step = Math.max( 1, Math.round( 0.5 / f.cell ) ), d = f.data;
	let crossings = 0, land = 0, cx = 0, cz = 0, shelf = 0, meadow = 0;
	const a = ( step * f.cell ) ** 2;
	for ( let j = 0; j + step < f.nz; j += step ) for ( let i = 0; i + step < f.nx; i += step ) {

		const k = j * f.nx + i, v = d[ k ] < 0;
		if ( v !== d[ k + step ] < 0 ) crossings ++;
		if ( v !== d[ k + step * f.nx ] < 0 ) crossings ++;
		const x = f.x0 + ( i + 0.5 ) * f.cell, z = f.z0 + ( j + 0.5 ) * f.cell;
		if ( v ) {

			land ++; cx += x; cz += z;
			continue;

		}
		const floor = H.floor( x, z );
		if ( floor > - 6 ) shelf += a;
		meadow += H.grass( x, z ) * a;

	}
	const n = Math.max( land, 1 );
	return {
		coastLength: crossings * step * f.cell * Math.PI / 4,
		shelfArea: shelf, meadowArea: meadow,
		centre: { x: cx / n, z: cz / n, radius: Math.sqrt( land * a / Math.PI ) },
	};

}
