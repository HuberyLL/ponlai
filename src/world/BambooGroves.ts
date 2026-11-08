import { fbm2, hash3i, mulberry32, noise3, smoothstep } from './noise.ts';
import { sampleRimGround } from './RimGround.ts';
import type { RimGroundField } from './types.ts';
import type { Bounds } from './WorldShapes.ts';

// Where the bamboo stands (Bamboo.ts builds the culms): over the whole island, as a running bamboo
// left to itself takes a hillside. Its rhizomes carry it out in groves, dense inside and of an even
// height, whose edges run out in lobes and tongues where the rhizomes advanced, a few culms
// standing alone ahead of them on the open ground, and gaps of meadow left between the groves.
//
// - The groves are a field of the point (`groveAt`): a low noise, its domain warped so their edges
//   lobe, thresholded so they hold `cover` of the land, dense to sparse within a couple of metres
//   (`edge`). The threshold is found once over a fixed stretch of the world, never over the land, so
//   a grown island keeps its groves where they were.
// - Each cell of a world lattice (`cell`) draws once from a stream of its own whether a culm stands
//   in it (likely in a grove, now and then on the open meadow), where, and the culm's height, girth,
//   age, lean and the seed of its form. No other rule: the culms stand wherever the land's top is
//   (`inset` in from the cliff's edge, so a foot stands on the ground).
// - The grove's floor carries its young bamboo (`plantShoots`): low leafy shoots the rhizomes send
//   up, thickest over the grove's edge and middle depth (where the light still reaches) and in
//   patches, thinner deep inside, where the floor is mostly soil and fallen leaves.
// - The grove's floor is bare of grass where its litter lies (`litterAt`, GROVES `litter`): a depth
//   gate opens a couple of metres inside the culm line and is full a few metres further in, and
//   there a second warped noise, thresholded to about half the floor (moved per grove by a very low
//   noise), cuts clearings with edges about a metre across; and a disc of litter lies under each
//   cluster of shoots (`shootClusterAt`, on a world lattice of its own: likelier deep inside, rare
//   among the grass at the edge). The grass stops at the litter (`grassOnLitter`: at a threshold
//   jittered per point, with a few stray tufts left in it). A function of the world alone, as the
//   groves are; the soil map bakes it for the ground (Soil.ts), the meadow tests it per anchor.
// - Inside a grove a culm stands nearly upright; toward its open edge it leans out down the
//   density's slope, to the open ground and the light, and bows over at the top in an arc, and it
//   is a little shorter (the youngest culms are at the front).
// A culm or shoot belongs to the box its foot lies in (`plantCulms`, `plantShoots`: Bamboo.ts
// plants a land chunk at a time), and each cell draws the same wherever a box starts, so the
// chunks' sites together are the whole land's.
// Plain numbers and no three.js, so the world's workers and node can plant it.

export const GROVES = {
	cell: 0.9, // the lattice a culm may stand in (m): one draw per cell
	scale: 16, // the groves' noise wavelength (m)
	warp: 5, // how far the noise's domain is pushed (m): the groves' lobed edges
	cover: 0.5, // the share of the land the groves hold
	edge: 0.07, // a grove's edge, in the noise's units: dense to sparse within a couple of metres
	dense: 0.85, // a cell's chance of a culm inside a grove
	stray: 0.04, // and on the open meadow
	height: 13, // a grown culm's height (m), inside a grove
	slender: 130, // a culm's height over its diameter at the foot
	lean: [ 0.04, 0.28 ] as const, // a culm's lean (rad) inside a grove and at its open edge
	bow: [ 0.04, 0.16 ] as const, // how far the top bows over (of the height), inside and at the edge
	inset: 0.35, // a foot's least distance in from the cliff's edge (m)
	shade: 0.72, // the share of the sky a full grove's canopy hides from its floor (`groveSky`)
	// the young bamboo on a grove's floor (`plantShoots`): its lattice (m), a cell's chance of one at
	// the grove's middle depth, how far that thins deep inside, and the patches' noise wavelength (m)
	shoots: { cell: 0.42, chance: 0.75, inner: 0.45, patch: 3.5 },
	// the grove's bare floor of fallen leaves (`litterAt`): the depth gate in the groves' noise above
	// the culm line (`gate`, its two ends), the clearings' noise (`scale` its wavelength and `warp` its
	// domain's push, m), their share of a grove's floor where the gate is open (`share`) and how far
	// a very low noise (`spread` its wavelength, m) moves it up or down (`vary`), and the clearings'
	// edge (`edge`, in the clearings' noise's units: about a metre across)
	litter: { gate: [ 0.05, 0.15 ], scale: 16, warp: 3, share: 0.45, spread: 80, vary: 0.15, edge: 0.12,
		// where grass stops on it (`grassOnLitter`): at `stop` of the litter, moved per anchor by up
		// to +-`jitter`, and the stray tufts left in the bare floor, a share (`stray`) of the cells of
		// a world lattice (`strayCell`, m) holding one (`strayRadius`, m)
		stop: 0.5, jitter: 0.1, stray: 0.03, strayCell: 1, strayRadius: 0.3 },
	// the clusters of shoots (`shootClusterAt`): their lattice (m), a cell's chance of one where the
	// litter's gate is open (`inner`) and in the grass at the grove's edge (`edge`, where the groves'
	// density lies within `band`), the shoots of one (`count`), the radius they spread over (m) and
	// the bare disc of fallen leaves under it (`disc`: its radius, m, and its soft edge)
	clusters: { cell: 8, inner: 0.3, edge: 0.05, band: [ 0.3, 0.6 ] as const, count: [ 8, 20 ] as const, radius: [ 0.5, 1 ] as const, disc: [ 0.75, 1 ] as const, soft: 0.3 },
};

/** Another look for the page to load (`bamboo=cover,height`, for comparing): the groves' share of
 * the land and a grown culm's height (m), each left out keeping the default. A load knob: set once,
 * before the meadow and the bamboo are planted (both read the groves). */
export function loadBambooLook( option: string | null ): void {

	const [ cover, height ] = ( option ?? '' ).split( ',' ).map( Number );
	if ( Number.isFinite( cover ) && cover > 0 && cover <= 1 ) GROVES.cover = cover;
	if ( Number.isFinite( height ) && height > 1 ) GROVES.height = height;

}

/** A culm's place and build: its foot, height (m), foot radius (m), age (0 new to 1 old), the
 * level way it leans ( outX, outZ ), its lean (rad) and bow (m), the groves' density at its foot
 * and the seed of its form. */
export interface CulmSite {
	x: number; y: number; z: number; grove: number;
	height: number; radius: number; age: number;
	outX: number; outZ: number; lean: number; bow: number;
	seed: number;
}

// The grove field's noise: a low fractal sum, its domain warped twice (broadly, then finer, so the
// edges run out in tongues), about [-1, 1].
function groveNoise( x: number, z: number ): number {

	const w = GROVES.warp, f = 1 / GROVES.scale, g = f * 2.7;
	const ux = x + w * noise3( x * f * 0.9 + 3.1, 7.7, z * f * 0.9 - 1.3 );
	const uz = z + w * noise3( x * f * 0.9 - 5.2, 2.9, z * f * 0.9 + 4.4 );
	const wx = ux + w * 0.45 * noise3( ux * g - 8.6, 1.9, uz * g + 2.2 );
	const wz = uz + w * 0.45 * noise3( ux * g + 6.4, 5.3, uz * g - 3.7 );
	return fbm2( wx * f + 26.1, wz * f + 1.3, 3 );

}

// The noise's level below which a share of the world lies: its values over a fixed 512 m square
// of the world (64 x 64 points), sorted once.
let levels: Float64Array | null = null;
function levelFor( share: number ): number {

	if ( ! levels ) {

		const n = 64, v = new Float64Array( n * n );
		for ( let j = 0; j < n; j ++ ) for ( let i = 0; i < n; i ++ ) v[ j * n + i ] = groveNoise( ( i + 0.5 ) * 8 - 256, ( j + 0.5 ) * 8 - 256 );
		levels = v.sort();

	}
	return levels[ Math.min( levels.length - 1, Math.max( 0, Math.floor( share * levels.length ) ) ) ];

}

/** The groves' density at ( x, z ): 1 inside a grove, 0 on the open meadow, the edge between. */
export function groveAt( x: number, z: number ): number {

	const t = levelFor( 1 - GROVES.cover );
	return smoothstep( t - GROVES.edge, t + GROVES.edge, groveNoise( x, z ) );

}

/** The share of the sky a point of the ground at ( x, z ) sees past the groves' canopy: a grove's
 * floor lies in its shade, lit by the sky through the gaps between the culms' leaves (GROVES
 * `shade`), the open meadow under the whole sky. The world's sky visibility takes it (the
 * island's ground and the meadow's tufts, Chunks.ts), and the culms by their height (Bamboo.ts),
 * where the materials do not read the ambient volume, whose probes see the canopy themselves
 * (lighting/AmbientSample.ts CANOPY_SHADE). Beside the volume only the meadow's blades keep the
 * canopy, relative to their tips (Grass.ts `aoCanopy`, `grass.ao.canopy`, by GROVES `shade`
 * from the soil map's density). */
export function groveSky( x: number, z: number ): number {

	return 1 - GROVES.shade * groveAt( x, z );

}

// The clearings' noise: a low fractal sum, its domain warped (`litter.warp`), about [-1, 1].
function clearingNoise( x: number, z: number ): number {

	const L = GROVES.litter, f = 1 / L.scale, w = L.warp, g = f * 2.3;
	const ux = x + w * noise3( x * g + 9.4, 3.3, z * g - 6.1 ), uz = z + w * noise3( x * g - 2.8, 8.1, z * g + 5.5 );
	return fbm2( ux * f - 14.2, uz * f + 31.7, 3 );

}

// the clearings' noise's levels over the same fixed square as the groves' (`levelFor`)
let clearingLevels: Float64Array | null = null;
function clearingLevel( share: number ): number {

	if ( ! clearingLevels ) {

		const n = 64, v = new Float64Array( n * n );
		for ( let j = 0; j < n; j ++ ) for ( let i = 0; i < n; i ++ ) v[ j * n + i ] = clearingNoise( ( i + 0.5 ) * 8 - 256, ( j + 0.5 ) * 8 - 256 );
		clearingLevels = v.sort();

	}
	return clearingLevels[ Math.min( clearingLevels.length - 1, Math.max( 0, Math.floor( share * clearingLevels.length ) ) ) ];

}

/** How far the litter's depth gate is open at ( x, z ): 0 at and outside the culm line, 1 well
 * inside a grove (GROVES.litter `gate`, in the groves' noise above its threshold). */
function litterGate( x: number, z: number ): number {

	const g = GROVES.litter.gate, t = levelFor( 1 - GROVES.cover );
	return smoothstep( t + g[ 0 ], t + g[ 1 ], groveNoise( x, z ) );

}

/** The groves' density (`groveAt`) at and above which the litter's depth gate may be open: the
 * gate opens where the groves' noise passes `t + gate[ 0 ]`, and the density is the same noise's
 * nondecreasing smoothstep, so wherever the gate is open `groveAt` is at least its value there
 * (the soil map's bake skips `litterAt`'s clearings below it, Soil.ts). */
export function litterGateDensity(): number {

	const t = levelFor( 1 - GROVES.cover );
	return smoothstep( t - GROVES.edge, t + GROVES.edge, t + GROVES.litter.gate[ 0 ] );

}

/** A cluster of shoots: its centre, the shoots in it, the radius they spread over (m), the radius of
 * the bare disc under it (m) and the seed of its shoots. */
export interface ShootCluster { x: number; z: number; count: number; radius: number; disc: number; seed: number }

/** The cluster the lattice's cell ( i, j ) (GROVES.clusters `cell`) draws, or null: a function of
 * the world alone, never of the land (the cliff's inset is the planting's). */
export function shootClusterAt( i: number, j: number ): ShootCluster | null {

	const key = ( i + 32768 ) * 65536 + j + 32768;
	let c = clusterCache.get( key );
	if ( c === undefined ) clusterCache.set( key, c = drawCluster( i, j ) );
	return c;

}

// (each cell's draw, kept: `litterAt` asks for nine cells at every point)
const clusterCache = new Map<number, ShootCluster | null>();
function drawCluster( i: number, j: number ): ShootCluster | null {

	const C = GROVES.clusters;
	const rng = mulberry32( ( hash3i( i, j, 5821 ) * 4294967296 ) >>> 0 );
	const x = ( i + 0.15 + 0.7 * rng() ) * C.cell, z = ( j + 0.15 + 0.7 * rng() ) * C.cell;
	const d = groveAt( x, z );
	if ( d < C.band[ 0 ] ) return null;
	const inEdge = d <= C.band[ 1 ] ? C.edge : 0;
	const chance = Math.max( inEdge, C.edge + ( C.inner - C.edge ) * litterGate( x, z ) );
	if ( rng() >= chance ) return null;
	const count = C.count[ 0 ] + Math.floor( rng() * ( C.count[ 1 ] - C.count[ 0 ] + 1 ) );
	const radius = C.radius[ 0 ] + ( C.radius[ 1 ] - C.radius[ 0 ] ) * rng();
	const disc = C.disc[ 0 ] + ( C.disc[ 1 ] - C.disc[ 0 ] ) * rng();
	return { x, z, count, radius, disc, seed: ( rng() * 4294967296 ) >>> 0 };

}

/** The clusters of shoots whose cells meet the box, in the lattice's row order. */
export function shootClusters( x0: number, z0: number, x1: number, z1: number ): ShootCluster[] {

	const cell = GROVES.clusters.cell, out: ShootCluster[] = [];
	for ( let j = Math.floor( z0 / cell ); j <= Math.floor( z1 / cell ); j ++ ) for ( let i = Math.floor( x0 / cell ); i <= Math.floor( x1 / cell ); i ++ ) {

		const c = shootClusterAt( i, j );
		if ( c !== null ) out.push( c );

	}
	return out;

}

/** The grove's bare floor of fallen leaves at ( x, z ), 0 (grass grows) to 1 (bare litter): the
 * clearings' noise over its level, the level raised toward the culm line until no clearing reaches
 * it (the depth gate), and the bare discs under the clusters of shoots. A function of the world
 * alone, as `groveAt` is. */
export function litterAt( x: number, z: number ): number {

	const L = GROVES.litter;
	let litter = 0;
	const gate = litterGate( x, z );
	if ( gate > 0 ) {

		const share = Math.min( Math.max( L.share + L.vary * noise3( x / L.spread + 17.3, 2.2, z / L.spread - 8.8 ), 0 ), 1 );
		// (where the gate is shut the level lies above every value of the noise)
		const level = clearingLevel( 1 - share ) + ( 1 - gate ) * 2;
		litter = smoothstep( level - L.edge, level + L.edge, clearingNoise( x, z ) );

	}
	if ( litter < 1 ) {

		const C = GROVES.clusters, ci = Math.floor( x / C.cell ), cj = Math.floor( z / C.cell );
		for ( let j = cj - 1; j <= cj + 1; j ++ ) for ( let i = ci - 1; i <= ci + 1; i ++ ) {

			const c = shootClusterAt( i, j );
			if ( c !== null ) litter = Math.max( litter, 1 - smoothstep( c.disc - C.soft, c.disc, Math.hypot( x - c.x, z - c.z ) ) );

		}

	}
	return litter;

}

/** Whether grass grows at ( x, z ) for the litter: below the litter's stop, moved by a hash of
 * the point (a ragged edge, not a contour line), or inside one of the stray tufts. */
export function grassOnLitter( x: number, z: number ): boolean {

	const L = GROVES.litter;
	const litter = litterAt( x, z );
	if ( litter <= 0 ) return true;
	const h = hash3i( Math.round( x * 64 ), Math.round( z * 64 ), 7177 );
	if ( litter < L.stop + 2 * L.jitter * ( h - 0.5 ) ) return true;
	const s = L.strayCell, i = Math.floor( x / s ), j = Math.floor( z / s );
	if ( hash3i( i, j, 6131 ) >= L.stray ) return false;
	const tx = ( i + 0.2 + 0.6 * hash3i( i, j, 6133 ) ) * s, tz = ( j + 0.2 + 0.6 * hash3i( i, j, 6137 ) ) * s;
	return Math.hypot( x - tx, z - tz ) < L.strayRadius;

}

/** The culms over the land's top (`rim`: the rim ground, RimGround.ts, its distance from the
 * cliff's edge negative inland) whose feet lie in `box` (half-open, as the chunks tile the plane),
 * on the ground `groundAt` gives, in the lattice's row order: a row of cells a step. */
export function* plantCulms( rim: RimGroundField, groundAt: ( x: number, z: number ) => number, box: Bounds ): Generator<void, CulmSite[]> {

	const P = GROVES, cell = P.cell;
	const stands = ( x: number, z: number ) => inBox( box, x, z ) && ! ( sampleRimGround( rim, x, z ).distance > - P.inset );
	const sites: CulmSite[] = [];
	for ( let j = Math.floor( box.z0 / cell ); j * cell < box.z1; j ++ ) {

		for ( let i = Math.floor( box.x0 / cell ); i * cell < box.x1; i ++ ) {

			const site = culmAt( i, j, stands, groundAt );
			if ( site !== null ) sites.push( site );

		}
		yield;

	}
	return sites;

}

const inBox = ( b: Bounds, x: number, z: number ) => x >= b.x0 && x < b.x1 && z >= b.z0 && z < b.z1;

/** The culm the lattice's cell ( i, j ) draws, or null: none drawn, or its foot where `stands`
 * says no culm stands (plantCulms: `inset` in from the cliff's edge). On the ground `groundAt`
 * gives. */
export function culmAt( i: number, j: number, stands: ( x: number, z: number ) => boolean, groundAt: ( x: number, z: number ) => number ): CulmSite | null {

	const P = GROVES, cell = P.cell;
	const rng = mulberry32( ( hash3i( i, j, 4517 ) * 4294967296 ) >>> 0 );
	// the foot within the cell's middle, so two culms stand at least a third of a cell apart
	const x = ( i + 0.167 + 0.667 * rng() ) * cell, z = ( j + 0.167 + 0.667 * rng() ) * cell;
	const d = groveAt( x, z );
	if ( rng() >= P.stray + ( P.dense - P.stray ) * d ) return null;
	if ( ! stands( x, z ) ) return null;
	// out from the grove: down its density's slope, turned a little (anywhere where it is flat)
	const e = 0.5;
	const gx = groveAt( x + e, z ) - groveAt( x - e, z ), gz = groveAt( x, z + e ) - groveAt( x, z - e );
	const g = Math.hypot( gx, gz );
	const away = g > 1e-3 ? Math.atan2( - gz, - gx ) : rng() * Math.PI * 2;
	const turn = away + ( rng() - 0.5 ) * 1.2;
	const open = 1 - d;
	const height = P.height * ( 0.85 + 0.15 * d ) * ( 0.8 + 0.3 * rng() );
	const radius = height / P.slender / 2 * ( 0.85 + 0.3 * rng() );
	const k = rng();
	const age = k < 0.2 ? 0 : k < 0.42 ? 0.35 + 0.4 * rng() : 1;
	const lean = P.lean[ 0 ] + ( P.lean[ 1 ] - P.lean[ 0 ] ) * open * open + ( rng() - 0.5 ) * 0.06;
	const bow = height * ( P.bow[ 0 ] + ( P.bow[ 1 ] - P.bow[ 0 ] ) * open ) * ( 0.6 + 0.8 * rng() );
	const seed = ( rng() * 4294967296 ) >>> 0;
	return { x, y: groundAt( x, z ), z, grove: d, height, radius, age, outX: Math.cos( turn ), outZ: Math.sin( turn ), lean, bow, seed };

}

/** A young bamboo shoot on a grove's floor: its foot, its height (m: where its leaves fan out), the
 * way it turns, how lit it stands (0 deep in the grove to 1 at its edge) and the seed of its leaves. */
export interface ShootSite { x: number; y: number; z: number; height: number; turn: number; light: number; seed: number }

/** The young bamboo over the land's top whose feet lie in `box` (as `plantCulms`), in the
 * lattice's row order: a row of cells a step. */
export function* plantShoots( rim: RimGroundField, groundAt: ( x: number, z: number ) => number, box: Bounds ): Generator<void, ShootSite[]> {

	const P = GROVES.shoots, cell = P.cell;
	const sites: ShootSite[] = [];
	for ( let j = Math.floor( box.z0 / cell ); j * cell < box.z1; j ++ ) {

		for ( let i = Math.floor( box.x0 / cell ); i * cell < box.x1; i ++ ) {

			const rng = mulberry32( ( hash3i( i, j, 4639 ) * 4294967296 ) >>> 0 );
			const x = ( i + rng() ) * cell, z = ( j + rng() ) * cell;
			if ( ! inBox( box, x, z ) ) continue;
			const d = groveAt( x, z );
			const patch = 0.45 + 0.55 * smoothstep( - 0.35, 0.35, noise3( x / P.patch + 4.7, 6.1, z / P.patch - 2.3 ) );
			const chance = P.chance * smoothstep( 0.08, 0.5, d ) * ( 1 - P.inner * smoothstep( 0.7, 1, d ) ) * patch;
			if ( rng() >= chance ) continue;
			if ( sampleRimGround( rim, x, z ).distance > - GROVES.inset ) continue;
			const height = ( 0.22 + 0.4 * rng() ) * ( 1.15 - 0.3 * d );
			sites.push( { x, y: groundAt( x, z ), z, height, turn: rng() * Math.PI * 2, light: 1 - d, seed: ( rng() * 4294967296 ) >>> 0 } );

		}
		yield;

	}
	return sites;

}
