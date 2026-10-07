import * as THREE from 'three/webgpu';
import { mulberry32, noise3, smoothstep } from './noise.ts';
import { pickFoliageSites, type FoliageSite } from './FoliageSites.ts';
import { supportsMeadow } from './MeadowSurface.ts';
import { puddleHollows, PUDDLE_FULL_LEVEL } from '../weather/PuddleHollows.ts';
import { VEGETATION_STRIDE as STRIDE, VEGETATION_SPACING } from './types.ts';

// Where the island top's shrubs and small trees grow. Every rule reads the turf anchors and
// fields (rim distance, noise, the puddle hollows, the paths kept clear), never coordinates, so
// a larger island of more tiles plants itself the same way: tree count follows the meadow's
// area, shrubs gather in loose groups wherever the clump field rises.

export type PlantKind = 'round' | 'broadleaf' | 'fern' | 'tree';

export interface PlantSite {
	kind: PlantKind;
	x: number; y: number; z: number;
	nx: number; ny: number; nz: number;
	height: number; // m, above the ground
	radius: number; // m, the ground the plant covers
	seed: number;
	visibility: number; // the anchor's sky visibility before any plant shades it
}

// One small tree per this much meadow (m^2): three on the present island.
const TREE_AREA = 120;
// One shrub group per this much meadow (m^2), their centres at least this far apart (m).
const GROUP_AREA = 13;
const GROUP_SPACING = 2.8;
// The puddles never reach below this hollow value, whatever the ground's relief.
const DRY_GROUND = PUDDLE_FULL_LEVEL - 0.035;

interface Anchor { i: number; x: number; y: number; z: number; rim: number }

class AnchorGrid {

	readonly cells = new Map<number, Anchor[]>();
	add( a: Anchor ): void {

		const key = this.key( Math.floor( a.x ), Math.floor( a.z ) );
		let cell = this.cells.get( key );
		if ( ! cell ) this.cells.set( key, cell = [] );
		cell.push( a );

	}
	key( i: number, j: number ): number { return ( i + 2048 ) * 4096 + j + 2048; }
	near( x: number, z: number, r: number ): Anchor[] {

		const out: Anchor[] = [];
		for ( let j = Math.floor( z - r ); j <= Math.floor( z + r ); j ++ ) for ( let i = Math.floor( x - r ); i <= Math.floor( x + r ); i ++ ) {

			for ( const a of this.cells.get( this.key( i, j ) ) ?? [] ) if ( Math.hypot( a.x - x, a.z - z ) <= r ) out.push( a );

		}
		return out;

	}

}

/** Horizontal distance (m) to a closed walking loop through `waypoints` (x, z), traced like
 * the islander's own path (a centripetal Catmull-Rom loop). */
export function loopDistance( waypoints: [ number, number ][] ): ( x: number, z: number ) => number {

	const curve = new THREE.CatmullRomCurve3( waypoints.map( ( [ x, z ] ) => new THREE.Vector3( x, 0, z ) ), true, 'centripetal' );
	const points = curve.getSpacedPoints( Math.max( 64, Math.ceil( curve.getLength() / 0.1 ) ) );
	return ( x, z ) => {

		let d = Infinity;
		for ( let i = 1; i < points.length; i ++ ) {

			const a = points[ i - 1 ], b = points[ i ];
			const ex = b.x - a.x, ez = b.z - a.z;
			const t = Math.max( 0, Math.min( 1, ( ( x - a.x ) * ex + ( z - a.z ) * ez ) / ( ex * ex + ez * ez || 1 ) ) );
			d = Math.min( d, Math.hypot( x - a.x - ex * t, z - a.z - ez * t ) );

		}
		return d;

	};

}

// No standing water under the plant: its stem and the ring of ground it covers stay dry.
function dryGround( x: number, z: number, r: number ): boolean {

	if ( puddleHollows( x, z ) > DRY_GROUND ) return false;
	for ( let k = 0; k < 6; k ++ ) {

		const a = k / 6 * Math.PI * 2;
		if ( puddleHollows( x + Math.cos( a ) * r * 0.6, z + Math.sin( a ) * r * 0.6 ) > DRY_GROUND ) return false;

	}
	return true;

}

/** Shrub groups and small trees on the island top. `clearance` is the distance to ground that
 * must stay open (the islander's walk). The rim bushes (FoliageSites) keep their own picker and
 * random stream: the rim trails reuse it. */
export function pickPlantSites( veg: Float32Array, clearance: ( x: number, z: number ) => number ): PlantSite[] {

	const n = veg.length / STRIDE;
	const grid = new AnchorGrid();
	const meadow: Anchor[] = [];
	for ( let i = 0; i < n; i ++ ) {

		const k = i * STRIDE;
		if ( veg[ k + 7 ] > 0 || ! supportsMeadow( veg[ k + 1 ], veg[ k + 4 ] ) ) continue;
		const a = { i, x: veg[ k ], y: veg[ k + 1 ], z: veg[ k + 2 ], rim: veg[ k + 6 ] };
		grid.add( a );
		meadow.push( a );

	}
	const area = meadow.length * VEGETATION_SPACING * VEGETATION_SPACING;
	const bushes: FoliageSite[] = pickFoliageSites( veg, mulberry32( 7 ) );
	const sites: PlantSite[] = [];
	const rng = mulberry32( 1109 );
	const site = ( a: Anchor, kind: PlantKind, height: number, radius: number ): PlantSite => {

		const k = a.i * STRIDE;
		return { kind, x: a.x, y: a.y, z: a.z, nx: veg[ k + 3 ], ny: veg[ k + 4 ], nz: veg[ k + 5 ], height, radius,
			seed: Math.floor( rng() * 0x7fffffff ), visibility: veg[ k + 8 ] };

	};
	// Room for a plant of this footprint: off the path, dry, clear of the rim bushes and of the
	// stems already planted (crowns may overlap a little, as they do in a thicket).
	const free = ( x: number, z: number, r: number, path: number ) => clearance( x, z ) > r + path
		&& ! bushes.some( ( b ) => Math.hypot( b.x - x, b.z - z ) < ( b.r + r ) * 0.65 )
		&& ! sites.some( ( s ) => Math.hypot( s.x - x, s.z - z ) < ( s.kind === 'tree' ? 0.45 + r * 0.6 : ( s.radius + r ) * 0.62 ) )
		&& dryGround( x, z, r );

	// --- small trees, at the crests of a broad grove field, well inside the rim so the crown
	// overhangs the cliff no more than a branch's length
	const trees = Math.max( 1, Math.round( area / TREE_AREA ) );
	const grove = ( a: Anchor ) => noise3( a.x * 0.085 + 31.7, 2.9, a.z * 0.085 ) + rng() * 0.25;
	const ranked = meadow.filter( ( a ) => a.rim < - 1.8 ).map( ( a ) => ( { a, score: grove( a ) } ) ).sort( ( p, q ) => q.score - p.score );
	const treeSites: PlantSite[] = [];
	for ( const { a } of ranked ) {

		if ( treeSites.length >= trees ) break;
		if ( treeSites.some( ( t ) => Math.hypot( t.x - a.x, t.z - a.z ) < 7 ) ) continue;
		// The trunk stays 3 m off the path, so the walker never passes under the crown.
		if ( ! free( a.x, a.z, 0.5, 2.5 ) ) continue;
		const s = site( a, 'tree', 2.5 + rng() * 1.0, 1.2 );
		treeSites.push( s );
		sites.push( s );

	}

	// --- shrub groups: centres where the clump field rises, kept apart so lawn stays open
	// between them, and one at the foot of every tree
	const clump = ( x: number, z: number ) => noise3( x * 0.19 + 5.3, 1.7, z * 0.19 ) * 0.5 + 0.5;
	// a slow field picks each group's main kind, so neighbouring groups tend to match
	const kindField = ( x: number, z: number ) => noise3( x * 0.07 + 13.1, 6.2, z * 0.07 ) * 0.5 + 0.5;
	// under a tree: a few smaller plants ringing the trunk, no lead shrub
	const groups: { x: number; z: number; r: number; size: number; members: number; lead: boolean }[] =
		treeSites.map( ( t ) => ( { x: t.x, z: t.z, r: 1.7, size: 0.75, members: 3 + Math.floor( rng() * 3 ), lead: false } ) );
	const target = groups.length + Math.round( area / GROUP_AREA );
	const order = meadow.map( ( a ) => a );
	for ( let i = order.length - 1; i > 0; i -- ) {

		const j = Math.floor( rng() * ( i + 1 ) );
		[ order[ i ], order[ j ] ] = [ order[ j ], order[ i ] ];

	}
	for ( const a of order ) {

		if ( groups.length >= target ) break;
		if ( a.rim > - 0.8 ) continue;
		const c = clump( a.x, a.z );
		if ( rng() > smoothstep( 0.4, 0.68, c ) ) continue;
		// groups crowd into thickets where the field is high and spread out where it is low
		const spacing = GROUP_SPACING * ( 1.5 - 0.8 * smoothstep( 0.45, 0.75, c ) );
		if ( groups.some( ( g ) => Math.hypot( g.x - a.x, g.z - a.z ) < spacing ) ) continue;
		// the group's heart must have room for its lead shrub
		if ( ! free( a.x, a.z, 0.6, 0.6 ) ) continue;
		groups.push( { x: a.x, z: a.z, r: 1 + rng() * 1, size: 0.8 + 0.4 * c, members: 4 + Math.floor( rng() * 5 ), lead: true } );

	}

	const kinds: PlantKind[] = [ 'round', 'broadleaf', 'fern' ];
	const point = new THREE.Vector2();
	for ( const g of groups ) {

		const f = kindField( g.x, g.z );
		const main: PlantKind = f < 0.53 ? 'round' : f < 0.62 ? 'broadleaf' : 'fern';
		for ( let m = 0, tries = 0; m < g.members && tries < g.members * 8; tries ++ ) {

			// the lead plant stands at the group's heart, the rest scatter around it
			const lead = g.lead && m === 0;
			const d = lead ? rng() * 0.25 : g.r * Math.sqrt( 0.15 + 0.85 * rng() );
			const angle = rng() * Math.PI * 2;
			point.set( g.x + Math.cos( angle ) * d, g.z + Math.sin( angle ) * d );
			const near = grid.near( point.x, point.y, VEGETATION_SPACING * 1.5 );
			if ( ! near.length ) continue;
			const a = near.reduce( ( p, q ) => Math.hypot( q.x - point.x, q.z - point.y ) < Math.hypot( p.x - point.x, p.z - point.y ) ? q : p );
			const kind = lead ? 'round' : rng() < 0.6 ? main : kinds[ Math.floor( rng() * 3 ) ];
			// the largest plants of a group near its middle, the lead shrub up to head height
			const centre = 1 - 0.3 * Math.min( 1, d / g.r );
			const v = rng();
			const height = ( kind === 'round' ? ( lead ? 1.15 + v * 0.65 : 0.55 + Math.pow( v, 1.4 ) * 0.9 )
				: kind === 'broadleaf' ? 0.42 + v * 0.48 : 0.5 + v * 0.5 ) * g.size * centre;
			const radius = kind === 'round' ? 0.28 + height * 0.4 : kind === 'broadleaf' ? 0.25 + height * 0.7 : 0.2 + height * 0.6;
			// Shrubs stand back from the edge by their own radius; the rim bushes own the lip.
			if ( a.rim > - 0.35 - radius * 0.6 ) continue;
			if ( ! free( a.x, a.z, radius, 0.45 ) ) continue;
			sites.push( site( a, kind, Math.max( 0.35, height ), radius ) );
			m ++;

		}

	}

	return sites;

}
