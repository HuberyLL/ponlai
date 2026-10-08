import { pickFoliageSites, type FoliageSite } from './FoliageSites.ts';
import { supportsMeadow } from './MeadowSurface.ts';
import { mulberry32, noise3, smoothstep } from './noise.ts';
import { topAt, type CoastPath } from './RimGround.ts';
import type { Footprint } from './WorldShapes.ts';
import { VEGETATION_STRIDE } from './types.ts';
import type { RimStrand, SDF } from './types.ts';

type Point = [ number, number, number ];

function normalAt( sdf: SDF, x: number, y: number, z: number ): Point {

	const e = 0.025;
	const nx = sdf( x + e, y, z ) - sdf( x - e, y, z );
	const ny = sdf( x, y + e, z ) - sdf( x, y - e, z );
	const nz = sdf( x, y, z + e ) - sdf( x, y, z - e );
	const l = Math.hypot( nx, ny, nz ) || 1;
	return [ nx / l, ny / l, nz / l ];

}

// Find the first visible edge along an outward ray, not a second tile across a concave bay.
function edgeAt( sdf: SDF, x: number, y: number, z: number, nx: number, nz: number ): number | undefined {

	let lo = - 0.6;
	const d = sdf( x + nx * lo, y, z + nz * lo );
	if ( d > 0 ) return;
	for ( let hi = lo + 0.08; hi <= 2.52; hi += 0.08 ) {

		const next = sdf( x + nx * hi, y, z + nz * hi );
		if ( next >= 0 ) {

			for ( let j = 0; j < 18; j ++ ) {

				const mid = ( lo + hi ) * 0.5;
				if ( sdf( x + nx * mid, y, z + nz * mid ) < 0 ) lo = mid;
				else hi = mid;

			}
			return ( lo + hi ) * 0.5;

		}
		lo = hi;

	}

}

// Keep established shrub roots first, then fill the long shores with roots in the top meadow.
// A separate seed preserves the original bushes while spreading the hanging patches all round.
function rimSites( vegetation: Float32Array ): FoliageSite[] {

	const sites = pickFoliageSites( vegetation, mulberry32( 7 ) );
	const extra: FoliageSite[] = [], rng = mulberry32( 8143 );
	for ( let k = 0; k < vegetation.length; k += VEGETATION_STRIDE ) {

		const y = vegetation[ k + 1 ], ny = vegetation[ k + 4 ], rim = vegetation[ k + 6 ];
		if ( ! supportsMeadow( y, ny ) || rim < - 1.45 || rim > 0.45 ) continue;
		extra.push( { x: vegetation[ k ], y, z: vegetation[ k + 2 ], r: 0.65 + rng() * 0.25,
			rim, nx: vegetation[ k + 3 ], ny, nz: vegetation[ k + 5 ], visibility: vegetation[ k + 8 ] } );

	}
	for ( let i = extra.length - 1; i > 0; i -- ) {

		const j = Math.floor( rng() * ( i + 1 ) );
		[ extra[ i ], extra[ j ] ] = [ extra[ j ], extra[ i ] ];

	}
	return sites.concat( extra );

}

// The worker's sea level (the shore field is cut at y = 0, as shared.waterLevel): the cliff's
// foot, from which the bare lowest quarter is measured.
const SEA_LEVEL = 0;

// No stretch of coast stays bare for much longer than twice this: a second pass admits a small
// patch wherever a lip lies this far from every patch along the coast, so the bare runs keep to
// 0.4-4 m on any coast.
const FILL_DISTANCE = 1.9;

interface Lip { site: FoliageSite; x: number; z: number; nx: number; nz: number }

// Distances measured along the traced coast. Across a gully or the scar of a fallen column two
// lips can stand a metre apart while the coast between them winds for several, all of it bare.
class CoastRuler {

	private readonly x: number[] = [];
	private readonly z: number[] = [];
	private readonly path: number[] = [];
	private readonly arc: number[] = [];
	private readonly lengths: number[] = [];
	private readonly closed: boolean[] = [];
	private readonly cells = new Map<number, number[]>();

	constructor( paths: CoastPath[] ) {

		paths.forEach( ( { points, closed }, p ) => {

			let s = 0;
			points.forEach( ( [ x, z ], i ) => {

				if ( i > 0 ) s += Math.hypot( x - points[ i - 1 ][ 0 ], z - points[ i - 1 ][ 1 ] );
				const key = this.key( Math.floor( x ), Math.floor( z ) );
				let cell = this.cells.get( key );
				if ( ! cell ) this.cells.set( key, cell = [] );
				cell.push( this.x.length );
				this.x.push( x ); this.z.push( z ); this.path.push( p ); this.arc.push( s );

			} );
			const [ fx, fz ] = points[ 0 ], [ lx, lz ] = points[ points.length - 1 ];
			this.lengths.push( s + ( closed ? Math.hypot( fx - lx, fz - lz ) : 0 ) );
			this.closed.push( closed );

		} );

	}

	private key( i: number, j: number ): number { return ( i + 2048 ) * 4096 + j + 2048; }

	/** The nearest coast sample within a metre of ( x, z ), or -1. */
	locate( x: number, z: number ): number {

		let best = - 1, bestD = 1;
		for ( let j = Math.floor( z ) - 1; j <= Math.floor( z ) + 1; j ++ ) for ( let i = Math.floor( x ) - 1; i <= Math.floor( x ) + 1; i ++ ) {

			for ( const k of this.cells.get( this.key( i, j ) ) ?? [] ) {

				const d = Math.hypot( this.x[ k ] - x, this.z[ k ] - z );
				if ( d < bestD ) { bestD = d; best = k; }

			}

		}
		return best;

	}

	/** Separation of two points that lie at the located coast samples: along the coast when
	 * both sit on one traced loop (never less than the straight line), else the straight line. */
	separation( ax: number, az: number, a: number, bx: number, bz: number, b: number ): number {

		const straight = Math.hypot( ax - bx, az - bz );
		if ( a < 0 || b < 0 || this.path[ a ] !== this.path[ b ] ) return straight;
		const p = this.path[ a ], d = Math.abs( this.arc[ a ] - this.arc[ b ] );
		return Math.max( straight, this.closed[ p ] ? Math.min( d, this.lengths[ p ] - d ) : d );

	}

}

// Clumped patches of top-rooted trails cross the lip before bending down: bare stretches of
// stone between patches of one to nine strands, mostly short with a long tail of strands that
// wander, fork and reach far down the cliff, and a mounded clump of leaves over each patch's lip.
// Every patch derives from the meadow anchors, the footprint and noise fields with fixed seeds,
// so the coast is covered the same way whatever shape the island grows to.
export function makeRimTrails( sdf: SDF, fp: Footprint, vegetation: Float32Array, coast: CoastPath[] ): RimStrand[] {

	const lips: Lip[] = [];
	for ( const site of rimSites( vegetation ) ) {

		const lip = lipOf( sdf, fp, site );
		if ( lip ) lips.push( lip );

	}
	const rng = mulberry32( 9067 );
	const strands: RimStrand[] = [];
	const patches: { x: number; z: number; spacing: number }[] = [];
	const ruler = new CoastRuler( coast );
	for ( const lip of lips ) {

		// Where the coast's growth field is low the stone stays bare for metres; inside a clump
		// patches sit 0.4-1.5 m apart, thinning toward its fringes.
		const growth = noise3( lip.x * 0.31 + 4.1, 1.7, lip.z * 0.31 - 2.6 ) * 0.5 + 0.5;
		if ( growth < 0.40 ) continue;
		const fringe = 1 - smoothstep( 0.40, 0.68, growth );
		const spacing = ( 0.40 + Math.pow( rng(), 1.6 ) * 1.1 ) * ( 1 + fringe * 1.6 );
		if ( patches.some( ( p ) => Math.hypot( p.x - lip.x, p.z - lip.z ) < Math.max( spacing, p.spacing ) ) ) continue;
		// One to nine strands, few in most patches and many in the vigorous ones.
		const vigour = smoothstep( 0.40, 0.85, growth );
		const count = 1 + Math.floor( Math.pow( rng(), 1.5 - vigour * 0.7 ) * 8.99 );
		if ( growPatch( sdf, lip, count, false, strands, rng ) ) patches.push( { x: lip.x, z: lip.z, spacing } );

	}
	// The growth field's low stretches can run for many metres on a long coast. A sparse patch of
	// one to three strands breaks any longer bare run; the vigorous patches above are unchanged.
	const at = patches.map( ( p ) => ruler.locate( p.x, p.z ) );
	for ( const lip of lips ) {

		const here = ruler.locate( lip.x, lip.z );
		if ( patches.some( ( p, i ) => ruler.separation( p.x, p.z, at[ i ], lip.x, lip.z, here ) < FILL_DISTANCE ) ) continue;
		if ( growPatch( sdf, lip, 1 + Math.floor( rng() * 2.99 ), true, strands, rng ) ) {

			patches.push( { x: lip.x, z: lip.z, spacing: FILL_DISTANCE } );
			at.push( here );

		}

	}
	return strands;

}

// The lip in front of a meadow site: the coast's outward direction from the footprint and the
// first edge along it, or undefined where the site is too far from the edge to send a trail over.
function lipOf( sdf: SDF, fp: Footprint, site: FoliageSite ): Lip | undefined {

	if ( ! supportsMeadow( site.y, site.ny ) || site.rim < - 1.8 ) return;
	const e = 0.16;
	const gx = fp.dist( site.x + e, site.z ) - fp.dist( site.x - e, site.z );
	const gz = fp.dist( site.x, site.z + e ) - fp.dist( site.x, site.z - e );
	const g = Math.hypot( gx, gz );
	if ( g < 0.02 ) return;
	const nx = gx / g, nz = gz / g;
	const edge = edgeAt( sdf, site.x, site.y - 0.18, site.z, nx, nz );
	if ( edge === undefined || edge < 0.08 || edge > Math.min( 1.12, site.r + 0.30 ) ) return;
	return { site, x: site.x + nx * edge, z: site.z + nz * edge, nx, nz };

}

// Root `count` strands behind one lip and crown them with a leaf mound; a sparse patch keeps its
// strands in the upper metre, most long enough to show below the turf skirt. False when no strand could be kept clear of the stone.
function growPatch( sdf: SDF, lip: Lip, count: number, sparse: boolean, strands: RimStrand[], rng: () => number ): boolean {

	const { site, nx, nz } = lip;
	const patchStart = strands.length;
	const spread = Math.min( 0.55, 0.06 + Math.sqrt( count ) * 0.12 );
	for ( let branch = 0; branch < count; branch ++ ) {

		const offset = ( rng() * 2 - 1 ) * spread;
		const inset = 0.05 + rng() * 0.12;
		const x = site.x - nz * offset + nx * inset, z = site.z + nx * offset + nz * inset;
		const y = topAt( sdf, x, z );
		if ( y === undefined ) continue;
		const rootNormal = normalAt( sdf, x, y, z );
		if ( ! supportsMeadow( y, rootNormal[ 1 ] ) ) continue;
		const topEdge = edgeAt( sdf, x, y - 0.18, z, nx, nz );
		if ( topEdge === undefined || topEdge > 1.25 || topEdge < 0.02 ) continue;
		// Long-tailed drops: about 15 % reach 1.5-2.6 m, the rest stay in the upper metre, and
		// the lowest quarter of the cliff (above the sea at its foot) always stays bare stone.
		const tier = sparse ? 0.25 + rng() * 0.6 : rng();
		let drop = tier < 0.34 ? 0.20 + rng() * 0.25 : tier < 0.85 ? 0.45 + Math.pow( rng(), 1.3 ) * 0.75 : 1.5 + rng() * 1.1;
		drop = Math.min( drop, ( y - SEA_LEVEL ) * 0.75 - 0.03 );
		const points = trace( sdf, x, y, z, nx, nz, topEdge, rootNormal, drop, rng );
		if ( ! points ) continue;
		const index = strands.length;
		strands.push( { points, seed: Math.floor( rng() * 0x7fffffff ), lip: 16 } );
		// Longer strands fork once or twice partway down and spread apart.
		const forks = drop > 0.7 ? ( rng() < 0.6 ? 1 : 0 ) + ( drop > 1.4 && rng() < 0.45 ? 1 : 0 ) : 0;
		for ( let f = 0; f < forks; f ++ ) {

			const hang = points.length / 6 - 17;
			const from = 16 + Math.max( 2, Math.floor( hang * ( 0.2 + rng() * 0.4 ) ) );
			const fork = branchFrom( sdf, points, from, nx, nz, drop * ( 1 - ( from - 16 ) / hang ) * ( 0.35 + rng() * 0.45 ), rng );
			if ( fork ) strands.push( { points: fork, seed: Math.floor( rng() * 0x7fffffff ), lip: 0, parent: index, from } );

		}

	}
	if ( strands.length === patchStart ) return false;
	strands[ patchStart ].clump = lipClump( sdf, lip.x, lip.z, nx, nz, spread, count, rng );
	return true;

}

// A root arc from the turf over the lip, then a hanging section that keeps clear of the wall,
// drifts sideways and wanders more the longer it hangs. Returns x, y, z and the normal per node.
function trace( sdf: SDF, x: number, y: number, z: number, nx: number, nz: number, topEdge: number, rootNormal: Point, drop: number, rng: () => number ): Float32Array | undefined {

	const drift = ( rng() - 0.5 ) * ( 0.30 + drop * 0.18 );
	const wander = 0.02 + drop * 0.05, waves = 1 + drop * 1.6, wavePhase = rng() * Math.PI * 2;
	const air = 0.13 + rng() * 0.04;
	const points: number[] = [];
	if ( ! appendClear( sdf, points, x, y - 0.02, z, rootNormal ) ) return;
	// The short arch hides in the crown before its outside section turns down.
	for ( let j = 1; j <= 16; j ++ ) {

		const u = j / 16;
		const out = ( topEdge + air ) * u;
		const side = Math.sin( u * Math.PI ) * drift * 0.35;
		if ( ! appendClear( sdf, points, x + nx * out - nz * side, y + 0.20 * Math.sin( u * Math.PI * 0.90 ) - 0.04 * u, z + nz * out + nx * side ) ) return;

	}
	const nodes = Math.max( 10, Math.min( 34, Math.round( drop / 0.075 ) ) );
	for ( let j = 1; j <= nodes; j ++ ) {

		const u = j / nodes, py = y + 0.022 - drop * u;
		const side = drift * u + Math.sin( u * Math.PI * waves + wavePhase ) * wander * u;
		const baseX = x - nz * side, baseZ = z + nx * side;
		const wall = edgeAt( sdf, baseX, py, baseZ, nx, nz );
		if ( wall === undefined ) return;
		// A ray near the roof can hit a shallow top dip before the outside wall.
		// Once the branch crosses the lip, it cannot turn back into that dip.
		const out = Math.max( topEdge, wall ) + air + Math.sin( u * Math.PI ) * 0.06;
		if ( ! appendClear( sdf, points, baseX + nx * out, py, baseZ + nz * out ) ) return;

	}
	return new Float32Array( points );

}

// A side branch from node `from` of a hanging strand, leaning away sideways as it falls.
function branchFrom( sdf: SDF, parent: Float32Array, from: number, nx: number, nz: number, drop: number, rng: () => number ): Float32Array | undefined {

	if ( drop < 0.18 ) return;
	const k = from * 6;
	const x = parent[ k ], y = parent[ k + 1 ], z = parent[ k + 2 ];
	const lean = ( rng() < 0.5 ? - 1 : 1 ) * ( 0.10 + rng() * 0.12 + drop * 0.12 );
	const points: number[] = [];
	if ( ! appendClear( sdf, points, x, y, z ) ) return;
	const nodes = Math.max( 5, Math.min( 24, Math.round( drop / 0.075 ) ) );
	for ( let j = 1; j <= nodes; j ++ ) {

		// It parts from the parent sideways first, then hangs.
		const u = j / nodes, side = lean * Math.sqrt( u );
		if ( ! appendClear( sdf, points, x - nz * side + nx * 0.03 * Math.sin( u * Math.PI ), y - drop * u, z + nx * side + nz * 0.03 * Math.sin( u * Math.PI ) ) ) return;

	}
	return new Float32Array( points );

}

// Push a node out to 0.112 m from the stone (the leaves' wall clearance) and append it with its
// outward normal; false when it cannot be kept clear or would sink into the lowest cliff.
function appendClear( sdf: SDF, points: number[], px: number, py: number, pz: number, rootNormal?: Point ): boolean {

	if ( ! rootNormal ) {

		for ( let i = 0; i < 6; i ++ ) {

			const d = sdf( px, py, pz );
			if ( d >= 0.105 ) break;
			const n = normalAt( sdf, px, py, pz );
			px += n[ 0 ] * ( 0.112 - d ); py += n[ 1 ] * ( 0.112 - d ); pz += n[ 2 ] * ( 0.112 - d );

		}
		if ( sdf( px, py, pz ) < 0.09 || py < SEA_LEVEL + 0.5 ) return false;

	}
	const n = rootNormal ?? normalAt( sdf, px, py, pz );
	points.push( px, py, pz, n[ 0 ], n[ 1 ], n[ 2 ] );
	return true;

}

// A low, mounded clump of leaves sitting on the turf over a patch's lip, curling a little over the
// edge: 0.3-0.6 m across, stretched along the coast. x, y, z and the mound's normal per anchor.
function lipClump( sdf: SDF, lipX: number, lipZ: number, nx: number, nz: number, spread: number, count: number, rng: () => number ): Float32Array | undefined {

	const cx = lipX - nx * 0.10, cz = lipZ - nz * 0.10;
	const ground = topAt( sdf, cx, cz );
	if ( ground === undefined ) return;
	const radius = Math.min( 0.32, 0.15 + rng() * 0.08 + spread * 0.18 + count * 0.008 );
	const height = radius * ( 0.55 + rng() * 0.2 ), stretch = 1.2 + rng() * 0.3;
	const anchors: number[] = [];
	const leaves = Math.round( 14 + radius * radius * 380 );
	for ( let i = 0; i < leaves; i ++ ) {

		// Points on a half-ellipsoid, denser toward its crown.
		const a = rng() * Math.PI * 2, c = Math.pow( rng(), 0.7 );
		const s = Math.sqrt( 1 - c * c ) * ( 0.75 + rng() * 0.25 );
		const along = Math.cos( a ) * s * stretch, across = Math.sin( a ) * s;
		let px = cx - nz * along * radius + nx * across * radius, pz = cz + nx * along * radius + nz * across * radius;
		let py = ground + c * height;
		// Outside the edge the mound curls down over the lip.
		const outside = ( px - lipX ) * nx + ( pz - lipZ ) * nz;
		if ( outside > 0 ) py -= outside * 0.9;
		let gx = - nz * along + nx * across, gz = nx * along + nz * across, gy = c * radius / height;
		const l = Math.hypot( gx, gy, gz ) || 1;
		gx /= l; gy /= l; gz /= l;
		// Keep the leaves on top of the turf and clear of the stone.
		for ( let k = 0; k < 6 && sdf( px, py, pz ) < 0.03; k ++ ) {

			py += 0.02; px += nx * 0.01; pz += nz * 0.01;

		}
		anchors.push( px, py, pz, gx, gy, gz );

	}
	return new Float32Array( anchors );

}
