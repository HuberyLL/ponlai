import { fbm2, hash3i, mulberry32, noise3, smoothstep, type Bounds } from '../../render/data.ts';
import { sampleRimGround } from './RimGround.ts';
import type { RimGroundField } from './types.ts';

// Where the bamboo stands: groves, lobes and lone culms over the whole island.
//
// Where the bamboo stands (Bamboo.ts builds the culms): over the whole island, as a running bamboo
// left to itself takes a hillside. Its rhizomes carry it out in groves, dense inside, their culms
// of varied height, whose edges run out in lobes and tongues where the rhizomes advanced, a few culms
// standing alone ahead of them on the open ground, and gaps of meadow left between the groves.
//
// - The groves are a field of the point (`groveAt`): a low noise, its domain warped so their edges
//   lobe, thresholded so they hold `cover` of the land, dense to sparse within a couple of metres
//   (`edge`). The threshold is found once over a fixed stretch of the world, never over the land, so
//   a grown island keeps its groves where they were.
// - Each cell of a world lattice (`cell`) draws once from a stream of its own whether a culm stands
//   in it (likely in a grove, now and then on the open meadow), where, and the culm's height, girth,
//   age, lean and the seed of its form and of its leaves' colour (BambooColours.ts leafBandAt).
// - The heights in a grove vary as a stand of moso bamboo's do: a coefficient of variation of 0.16
//   to 0.18 (Yang and Tang 2021, Journal of Zhejiang A&F University 38(6); Zhou et al. 2023,
//   Frontiers in Plant Science 14: 1095126). The taller culms are the thicker: those sources give a
//   correlation, and the form is our choice, the diameter at the foot growing as the height to the
//   1.25 (the height as the diameter to the 0.8) with a lognormal spread about it (`size`). Each
//   draw is a quantile of its one uniform: a normal cut at 0.6 and 1.4 of the mean for the height.
//   No other rule: the culms stand wherever the land's top is (`inset` in from the cliff's edge, so
//   a foot stands on the ground).
// - The grove's floor is the meadow's soil and grass, the grass sparser inside (`grassOnLitter`,
//   GROVES `litter`): it thins over a few metres about the culm line to a share of the meadow's
//   (each point kept by a hash against the share left there), along an edge frayed by a second
//   warped noise, never a contour of the groves' field. The grove's inner floor (`litterAt`) begins
//   on the same frayed edge, where the yunpeng do not stand (YunpengSites.ts). Functions of the
//   world alone, as the groves are; the meadow tests them per anchor.
// - Inside a grove a culm stands nearly upright; toward its open edge it leans out down the
//   density's slope, to the open ground and the light, and bows over at the top in an arc, and it
//   is a little shorter (the youngest culms are at the front).
// A culm belongs to the box its foot lies in (`plantCulms`: Bamboo.ts plants a land chunk at a
// time), and each cell draws the same wherever a box starts, so the chunks' sites together are the
// whole land's.
// Plain numbers and no three.js, so the world's workers and node can plant it.

export const GROVES = {
	cell: 0.9, // the lattice a culm may stand in (m): one draw per cell
	scale: 16, // the groves' noise wavelength (m)
	warp: 5, // how far the noise's domain is pushed (m): the groves' lobed edges
	cover: 0.5, // the share of the land the groves hold
	edge: 0.07, // a grove's edge, in the noise's units: dense to sparse within a couple of metres
	dense: 0.85, // a cell's chance of a culm inside a grove
	stray: 0.04, // and on the open meadow
	height: 13, // a grown culm's height (m), inside a grove: their mean there is 0.95 of it
	slender: 130, // a culm's height over its diameter at the foot, at the grove's mean height
	// the culms' sizes: the height's coefficient of variation (`cv`, a normal cut at `cut` of the
	// mean each way), the foot's diameter as the height to the power `power` (D ~ H^1.25,
	// H ~ D^0.8), and its spread about that (`spread`, the sd of its log, cut at three sds)
	size: { cv: 0.175, cut: 0.4, power: 1.25, spread: 0.12 },
	lean: [ 0.04, 0.28 ] as const, // a culm's lean (rad) inside a grove and at its open edge
	bow: [ 0.04, 0.16 ] as const, // how far the top bows over (of the height), inside and at the edge
	inset: 0.35, // a foot's least distance in from the cliff's edge (m)
	shade: 0.72, // the share of the sky a full grove's canopy hides from its floor (`groveSky`)
	// the grove's inner floor (`litterAt`): where it begins and is whole, in the groves'
	// noise about its threshold (`gate`: the culm line at 0), how far a second noise frays that edge
	// (`fray`, in the same units, times the noise's about -1 to 1), and that noise's wavelength and
	// its domain's push (`scale`, `warp`, m)
	litter: { gate: [ - 0.02, 0.04 ], fray: 0.2, scale: 2.5, warp: 1.5,
		// how the grass thins into a grove (`grassOnLitter`): the share of it kept falls from all to
		// `inside` across `thin` of the same frayed noise, a few metres each way of where the inner
		// floor begins, and stays at `inside` under the culms
		thin: [ - 0.12, 0.14 ], inside: 0.35 },
};

/** Another look for the app to load (`bamboo=cover,height`, for comparing): the groves' share of
 * the land and a grown culm's height (m), each left out keeping the default. A load-time setting: set once,
 * before the meadow and the bamboo are planted (both read the groves). */
export function loadBambooLook( option: string | null ): void {

	const [ cover, height ] = ( option ?? '' ).split( ',' ).map( Number );
	if ( Number.isFinite( cover ) && cover > 0 && cover <= 1 ) GROVES.cover = cover;
	if ( Number.isFinite( height ) && height > 1 ) GROVES.height = height;

}

/** The mean free path (m) of a level ray through a grove: how far it runs, on average, before it
 * meets a culm. A ray meets every culm whose axis passes within half a diameter of it, so the path
 * is one over the culms' density ( GROVES.dense a cell ) times their diameter (a culm of the grove's
 * mean height, at its foot: about 10 m). The culms' taper lengthens it; the branches and the leaves,
 * left out, shorten it far more in the crowns, so it is the longest path the grove gives. */
export function groveFreePath(): number {

	const diameter = 0.95 * GROVES.height / GROVES.slender;
	return GROVES.cell * GROVES.cell / ( GROVES.dense * diameter );

}

/** A culm's place and build: its foot, height (m), foot radius (m), age (0 new to 1 old), the
 * level way it leans ( outX, outZ ), its lean (rad) and bow (m), the groves' density at its foot
 * and the seed of its form and its leaves' colour. */
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

// The litter's fraying noise: a low fractal sum, its domain warped (`litter.warp`), about [-1, 1].
function frayNoise( x: number, z: number ): number {

	const L = GROVES.litter, f = 1 / L.scale, w = L.warp, g = f * 2.3;
	const ux = x + w * noise3( x * g + 9.4, 3.3, z * g - 6.1 ), uz = z + w * noise3( x * g - 2.8, 8.1, z * g + 5.5 );
	return fbm2( ux * f - 14.2, uz * f + 31.7, 3 );

}

/** The grove's inner floor at ( x, z ), 0 (outside) to 1 (well inside): the groves' noise about its
 * threshold, frayed by a noise of its own. A function of the world alone, as
 * `groveAt` is. */
export function litterAt( x: number, z: number ): number {

	const L = GROVES.litter, t = levelFor( 1 - GROVES.cover );
	const v = groveNoise( x, z ) - t;
	if ( v < L.gate[ 0 ] - L.fray ) return 0;
	return smoothstep( L.gate[ 0 ], L.gate[ 1 ], v + L.fray * frayNoise( x, z ) );

}

/** Whether grass grows at ( x, z ) for the groves: kept by a hash of the point against the share
 * of the grass the groves leave there (thinning over a few metres into a grove, so the meadow goes
 * over into the sparser grass under the culms gradually). */
export function grassOnLitter( x: number, z: number ): boolean {

	const L = GROVES.litter, t = levelFor( 1 - GROVES.cover );
	const v = groveNoise( x, z ) - t;
	if ( v < L.thin[ 0 ] - L.fray ) return true;
	const bare = ( 1 - L.inside ) * smoothstep( L.thin[ 0 ], L.thin[ 1 ], v + L.fray * frayNoise( x, z ) );
	return hash3i( Math.round( x * 64 ), Math.round( z * 64 ), 7177 ) >= bare;

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
	const S = P.size;
	const height = P.height * ( 0.85 + 0.15 * d ) * 0.95 * ( 1 + S.cv * cutNormal( rng(), S.cut / S.cv ) );
	const radius = height / P.slender / 2 * ( height / ( 0.95 * P.height ) ) ** ( S.power - 1 ) * Math.exp( S.spread * cutNormal( rng(), 3 ) - S.spread * S.spread / 2 );
	const k = rng();
	const age = k < 0.2 ? 0 : k < 0.42 ? 0.35 + 0.4 * rng() : 1;
	const lean = P.lean[ 0 ] + ( P.lean[ 1 ] - P.lean[ 0 ] ) * open * open + ( rng() - 0.5 ) * 0.06;
	const bow = height * ( P.bow[ 0 ] + ( P.bow[ 1 ] - P.bow[ 0 ] ) * open ) * ( 0.6 + 0.8 * rng() );
	const seed = ( rng() * 4294967296 ) >>> 0;
	return { x, y: groundAt( x, z ), z, grove: d, height, radius, age, outX: Math.cos( turn ), outZ: Math.sin( turn ), lean, bow, seed };

}

/** The quantile at `u` (0..1) of a standard normal cut at -a and a: the normal's quantile of u
 * spread over the cut's share of its distribution. */
function cutNormal( u: number, a: number ): number {

	const lo = normalCdf( - a );
	return normalQuantile( lo + u * ( 1 - 2 * lo ) );

}

/** The standard normal's distribution function (erfc by Abramowitz and Stegun's 7.1.26, an error
 * under 1.5e-7). */
function normalCdf( x: number ): number {

	const t = 1 / ( 1 + 0.3275911 * Math.abs( x ) / Math.SQRT2 );
	const erfc = t * ( 0.254829592 + t * ( - 0.284496736 + t * ( 1.421413741 + t * ( - 1.453152027 + t * 1.061405429 ) ) ) ) * Math.exp( - x * x / 2 );
	return x >= 0 ? 1 - erfc / 2 : erfc / 2;

}

/** The standard normal's quantile function (P. J. Acklam's rational approximation, a relative
 * error under 1.2e-9). */
function normalQuantile( p: number ): number {

	const a = [ - 39.69683028665376, 220.9460984245205, - 275.9285104469687, 138.357751867269, - 30.66479806614716, 2.506628277459239 ];
	const b = [ - 54.47609879822406, 161.5858368580409, - 155.6989798598866, 66.80131188771972, - 13.28068155288572 ];
	const c = [ - 0.007784894002430293, - 0.3223964580411365, - 2.400758277161838, - 2.549732539343734, 4.374664141464968, 2.938163982698783 ];
	const d = [ 0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416 ];
	const tail = ( q: number ) => ( ( ( ( ( c[ 0 ] * q + c[ 1 ] ) * q + c[ 2 ] ) * q + c[ 3 ] ) * q + c[ 4 ] ) * q + c[ 5 ] ) / ( ( ( ( d[ 0 ] * q + d[ 1 ] ) * q + d[ 2 ] ) * q + d[ 3 ] ) * q + 1 );
	if ( p < 0.02425 ) return tail( Math.sqrt( - 2 * Math.log( p ) ) );
	if ( p > 1 - 0.02425 ) return - tail( Math.sqrt( - 2 * Math.log( 1 - p ) ) );
	const q = p - 0.5, r = q * q;
	return ( ( ( ( ( a[ 0 ] * r + a[ 1 ] ) * r + a[ 2 ] ) * r + a[ 3 ] ) * r + a[ 4 ] ) * r + a[ 5 ] ) * q / ( ( ( ( ( b[ 0 ] * r + b[ 1 ] ) * r + b[ 2 ] ) * r + b[ 3 ] ) * r + b[ 4 ] ) * r + 1 );

}
