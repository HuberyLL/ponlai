// The ambient light's probes: a world-anchored lattice of points, each holding how much of the sky
// it sees and how much sky light the world round it bounces to it, by direction, baked per chunk
// in the world's workers (Chunks.ts `buildChunk`) from the chunk's window alone. Plain numbers and
// no three.js, so the workers and node run it. The page uploads the merged lattice
// (lighting/AmbientVolume.ts), which relights it with the sky's colour every frame
// (lighting/AmbientRelight.ts).
//
// The method is the probe grid of Jasmin Patry, "Real-Time Samurai Cinema: Lighting, Atmosphere,
// and Tonemapping in Ghost of Tsushima" (SIGGRAPH 2021 Advances in Real-Time Rendering in Games): a
// regular grid of degree-2 harmonics probes (p. 16), each holding its sky visibility (mono),
// multiplied at run time by the sky's own harmonics (p. 24), and its bounced sky visibility, the
// world lit by a uniform white sky, multiplied at run time by the sky's average colour (p. 25). The
// relocation of probes caught in a solid, or their marking as invalid, is DDGI's (Majercik et al.,
// "Scaling Probe-Based Real-Time Dynamic Global Illumination for Production", JCGT 2021); the
// harmonics' basis and their cosine lobe are Ramamoorthi and Hanrahan's ("An efficient
// representation for irradiance environment maps", SIGGRAPH 2001).
//
// - The lattice: SPACING (2 m) apart on all three axes, columns at ( ( I + 0.5 ) 2, ( K + 0.5 ) 2 ),
//   LEVELS levels from Y0 (2 m under the sea's mean level) to the bamboo's crowns over the plateau
//   and a cell more (ISLAND_TOP + the default groves' height + two cells: 13 levels, up to 22 m).
//   A chunk owns the 8 x 8 columns its square holds. Only the chunks with land within PROBE_NEAR of
//   their square bake theirs (Chunks.ts); everywhere else the probe is the open sea's
//   (`openSeaProbe`), which depends on the level alone.
// - A probe's data (PROBE_STRIDE floats, twenty vec4): for each of the nine coefficients i, ( sky
//   visibility c_i, bounced r c_i, g c_i, b c_i ); then the groves' in-scatter alone, the part of
//   the bounced light the medium scatters (below), as r c_i, g c_i, b c_i for each i in turn (27
//   floats and a spare 0 in seven vec4, from SCATTER_VEC4), which the relight's key bounce takes
//   apart from the solids' (AmbientRelight.ts); then the sea's visibility c_i (nine floats and three
//   spare 0 in three vec4, from SEA_VEC4); then ( relocation dx, dy, dz, valid ) (META_VEC4).
//   The coefficients are the functions' projections in three.js's SphericalHarmonics3 basis and
//   order (y up), not convolved: the relight applies the cosine lobe ( pi, 2 pi / 3, pi / 4 ). A probe
//   within half a cell of the outside of a solid is moved to the nearest free point (0.25 m steps)
//   and baked there; one deeper is invalid (all zeros, `valid` 0), and the merge fills it from its
//   neighbours (`mergeProbes`, FILL_PASSES). A chunk's probes run in rows of its columns ( K, then the level J, then I ).
// - The rays: RAYS directions of a spherical Fibonacci set, each weighted 4 pi / RAYS, summed in
//   their fixed order (so a probe's bits never depend on threads or order). A ray ends at a solid,
//   at the sea's surface (from above it), or at REACH (20 m, 6 m under the water) measured
//   horizontally, so a ray straight down always finds the ground or the sea; beyond, it is open sky
//   above the horizon and open sea below it. Sky visibility: the ray's transmittance if it reaches
//   the sky, else 0. Bounced: at a solid, the transmittance times the solid's albedo times its own
//   sky visibility toward its normal (cosine weighted, SECONDARY rays to HIT_REACH, 10 m; 3 m under
//   the water): one bounce of a uniform white sky. Plus what the groves' medium scatters along the
//   ray. A ray that reaches the sea from above it (at its surface, or below the horizon beyond
//   REACH) counts as sea visibility, its transmittance: the relight lights it as a level bounce
//   surface, the sea's diffuse albedo times the sky's and the key's irradiance at its surface over
//   pi, the same radiance in every such direction (AmbientRelight.ts), and the sky's harmonics hold
//   the sky above the horizon only. (Baked as bounced light, the sea's Fresnel reflection, which
//   nears 1 at the grazing angles a probe on the plateau sees it at beyond the cliff, was the
//   brightest thing in the lower hemisphere, a thin band under the horizon that the harmonics
//   spread over the upper half; the diffuse bounce stays dim.) The bright shallows' bounce of the
//   key is GroundBounce.ts's sea.
//   Under the water a ray down finds the floor or, beyond its reach, the water's body.
// - The solids: the island (the window's SDF; away from the coast its side from the footprint,
//   `solidSide`), the stones round the chunk (Chunks.ts CONTACT_STONES: with the under-water
//   reach their bounds cover every stone the rays meet) and the rendered floor, voxelised lazily
//   on a world-anchored 0.5 m lattice (each voxel by its centre, evaluated when a ray first asks).
//   Primary reach plus a hit's reach (30 m) stays inside the chunk's 32 m window, so everything is
//   a function of the window. The floor's height depends on the coast up to LAND_REACH (24 m) from
//   it, so the rays read it only within 9 m of a probe (the reaches under the water; a ray above
//   the water ends at its surface): every read of the land lies within 34 m of the chunk, the
//   dirty rule's bound (tools/verify-world-chunks.mjs D4, D5: with the floor read to 20 m, land
//   placed 35 m out changed coastal chunks). The march starts from a fixed CEILING, so where its
//   samples fall is the same whatever the groves round the chunk.
// - The groves are a participating medium over the land (Beer-Lambert), on a world-anchored 1 m grid:
//   from the ground to the culms' mean height, culms as vertical cylinders (their density and
//   diameter from GROVES and `groveAt` at the cell: extinction n D sin theta), and from where the
//   branches start (Bamboo.ts BAMBOO.branches) up, a crown where the culms' crowns stand. Each culm
//   the lattice draws (BambooGroves.ts `culmAt`, its foot where the medium is) spreads its crown
//   along its axis, leaning and bowing out as Bamboo.ts bends it, and its branches' reach round it;
//   a cell's crown is that density over a grove's deep inside (at most 1), its vertical
//   transmittance the canopy's `groveSky` at that density. A grove's crowns lean out over its edge
//   by a few metres (the culms lean out to the light), so the edge's ground sees them overhead.
//   It scatters (single scattering, isotropic) the culms' or the leaves' albedo times the sky light
//   reaching that point: half the sphere times its crown's vertical transmittance above it. That
//   in-scatter is kept apart as well (the probe's data): lit by the sky alone, it does not know
//   which crowns the sun lights, so the relight weighs its share of the key's bounce by the probe's
//   view of the sky toward the key.
// - Albedos: averages of our own materials' linear albedos (below). The meadow's grass is no
//   occluder, but it colours the ground under it.
// - The bounce's sun and the sky's colour are the relight's; under the water the light is
//   Underwater.ts's, and the probes there carry only the geometry (the water's surface lets the sky
//   through, no attenuation).

import { CULM, LEAF_COLOURS, LEAF_SHARE, PURPLE_CULMS } from './BambooColours.ts';
import { GROVES, culmAt, groveAt } from './BambooGroves.ts';
import { islandSurfaceHeight, solidSide, ISLAND_BOTTOM, ISLAND_PEAK, ISLAND_TOP, type Bounds, type Footprint, type HeightFn } from './WorldShapes.ts';
import { FLOOR_ALBEDO, SEABED_TILE } from './SeabedTile.ts';
import { smoothstep } from './noise.ts';
import { bodyReflectance } from '../ocean/SeaOptics.ts';
import type { SolidBounds } from '../lighting/SkyOcclusion.ts';
import type { AmbientLattice, SDF } from './types.ts';

// ------------------------------------------------------------------ the lattice

/** The lattice's spacing (m), on all three axes. */
export const SPACING = 2;
/** The lowest level (m): 2 m under the sea's mean level. */
export const Y0 = - 2;
/** The levels, up to the bamboo's crowns over the plateau and two cells more. Fixed when the
 * module loads, from the default groves (the workers plant those: docs/reference/tools.md, `bamboo=`). */
export const LEVELS = Math.ceil( ( ISLAND_TOP + GROVES.height + 2 * SPACING - Y0 ) / SPACING ) + 1;
/** The columns along a chunk's side. */
export const COLUMNS = SEABED_TILE / SPACING;
/** Floats per probe: nine vec4 of ( sky, bounced rgb ) coefficients, seven of the groves'
 * in-scatter (rgb per coefficient in turn, then a spare 0), three of the sea's visibility (nine
 * coefficients, then three spare 0), then ( offset xyz, valid ). */
export const PROBE_STRIDE = 80;
/** The vec4 a probe's in-scatter starts at, its sea visibility's, and its ( offset xyz, valid ). */
export const SCATTER_VEC4 = 9, SEA_VEC4 = 16, META_VEC4 = 19;
/** A chunk bakes probes when land lies within this of its square (m). */
export const PROBE_NEAR = 8;

// ------------------------------------------------------------------ albedos (linear)

// the meadow seen from above: the blades' mean albedo (Meadow.ts LAWN x LAWN_GAIN), their own,
// whose blue is about a ninth of their green (Grass.ts meadowMean)
const LAWN_TOP = [ 0.0700 * 0.926, 0.0978 * 0.926, 0.0109 * 0.926 ];
// a grove's floor: its ground scan's mean as TerrainMaterial.ts shows it (GROUND_SCANS.grove:
// saturation 0.8, gain 0.355)
const GROVE_FLOOR = scanLook( [ 0.2918, 0.2482, 0.1198 ], 0.8, 0.355 );
// the cliff's stone: TerrainMaterial.ts's rock at its mean tint, above the water times the
// rock's gain (shared.ts rockGain)
const ROCK = [ ( 0.124 + 0.188 ) / 2, ( 0.13 + 0.19 ) / 2, ( 0.126 + 0.176 ) / 2 ], ROCK_GAIN = 1.6;
// the floor: pale sand, the cliff foot's rubble, at the floor's gain (SeabedTile.ts FLOOR_ALBEDO),
// the sand its `sandGain` on top
const SAND = FLOOR_ALBEDO.sand.map( c => c * FLOOR_ALBEDO.gain * FLOOR_ALBEDO.sandGain ), RUBBLE = FLOOR_ALBEDO.rubble.map( c => c * FLOOR_ALBEDO.gain );
// the water's body seen from under its surface: the deep water's irradiance reflectance just under
// it, R( 0- ) = 0.33 bb / ( a + bb ), of the sea's own water (ocean/SeaOptics.ts; GroundBounce.ts takes
// the same through the surface)
const WATER_BODY = bodyReflectance();
// the culms: BambooColours.ts CULM, green to the age's end by the groves' age mix (BambooGroves.ts
// plantCulms: a fifth new, a fifth and more between, the rest old), the end dull green on most
// culms and dusty purple on PURPLE_CULMS of them
const AGED_SHARE = 0.22 * 0.55 + 0.58;
const CULM_MEAN = [ 0, 1, 2 ].map( ( c ) => CULM.green[ c ] * ( 1 - AGED_SHARE ) + ( CULM.dull[ c ] * ( 1 - PURPLE_CULMS ) + CULM.purple[ c ] * PURPLE_CULMS ) * AGED_SHARE );
// the leaves: BambooColours.ts LEAF_COLOURS (sRGB) by LEAF_SHARE, in linear; a bamboo leaf lets
// through about a third of what it reflects in the visible, so its scattering albedo is its
// reflectance times 1.3
const LEAF = leafAlbedo( LEAF_COLOURS, LEAF_SHARE ).map( ( v ) => 1.3 * v );
// where a culm's branches start, of its height (Bamboo.ts BAMBOO.branches), and its longest
// branch (BAMBOO.branch): a crown's leaves stand about 0.6 of that round its axis
const BRANCHES = 0.55, BRANCH = 0.12;

function scanLook( mean: number[], saturation: number, gain: number ): number[] {

	const luma = 0.2126 * mean[ 0 ] + 0.7152 * mean[ 1 ] + 0.0722 * mean[ 2 ];
	return mean.map( ( v ) => ( luma + ( v - luma ) * saturation ) * gain );

}

function leafAlbedo( colours: readonly ( readonly number[] )[], share: readonly number[] ): number[] {

	const linear = ( v: number ) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : Math.pow( ( c + 0.055 ) / 1.055, 2.4 ); };
	return [ 0, 1, 2 ].map( ( c ) => colours.reduce( ( sum, rgb, k ) => sum + linear( rgb[ c ] ) * share[ k ], 0 ) );

}

// ------------------------------------------------------------------ the rays

/** Primary rays per probe. */
export const RAYS = 128;
// a hit's cosine-weighted rays toward the sky
const SECONDARY = 16;
// how far a ray reaches, measured horizontally (m): a probe's, a hit's; under the water
const REACH = 20, HIT_REACH = 10, REACH_UNDER = 6, HIT_REACH_UNDER = 3;
// the march's step and the solids' voxel (m)
const STEP = 0.375, VOXEL = 0.5;
// the voxels' vertical range (m): below the deepest floor the rays reach, above the plateau's peak
const VOX_LOW = - 12, VOX_HIGH = ISLAND_PEAK + 1;
// above this nothing stops or scatters a ray (m): the voxels' top, or the tallest grove's crowns on
// the plateau's peak (a culm's mean height is at most 0.95 GROVES.height, below)
const CEILING = Math.max( VOX_HIGH, ISLAND_PEAK + 0.95 * GROVES.height );
// the medium's grid (m), and the points along a crown's axis it spreads a crown over
const MEDIUM_CELL = 1, CROWN_STEPS = 10;
// the relocation's search: 0.25 m steps within half a cell
const RELOCATE_STEP = 0.25, RELOCATE_REACH = SPACING / 2;
// the sea's mean level (m)
const SEA = 0;

// the spherical Fibonacci directions and their basis values
const GOLDEN = Math.PI * ( 3 - Math.sqrt( 5 ) );
const DIRS = new Float64Array( RAYS * 3 ), BASIS = new Float64Array( RAYS * 9 );
for ( let k = 0; k < RAYS; k ++ ) {

	const y = 1 - 2 * ( k + 0.5 ) / RAYS, r = Math.sqrt( 1 - y * y ), phi = k * GOLDEN;
	const x = r * Math.cos( phi ), z = r * Math.sin( phi );
	DIRS[ k * 3 ] = x; DIRS[ k * 3 + 1 ] = y; DIRS[ k * 3 + 2 ] = z;
	shBasis( x, y, z, BASIS, k * 9 );

}
// a hit's directions in its normal's frame (x, up, z): Fibonacci points on the disc lifted to the
// hemisphere (Malley's method), so each carries the same cosine-weighted share
const HEMI = new Float64Array( SECONDARY * 3 );
for ( let k = 0; k < SECONDARY; k ++ ) {

	const r = Math.sqrt( ( k + 0.5 ) / SECONDARY ), phi = k * GOLDEN;
	HEMI[ k * 3 ] = r * Math.cos( phi ); HEMI[ k * 3 + 1 ] = Math.sqrt( 1 - r * r ); HEMI[ k * 3 + 2 ] = r * Math.sin( phi );

}
// the relocation's candidate offsets, nearest first (ties in the scan's order)
const OFFSETS: number[][] = [];
{

	const n = Math.round( RELOCATE_REACH / RELOCATE_STEP );
	for ( let k = - n; k <= n; k ++ ) for ( let j = - n; j <= n; j ++ ) for ( let i = - n; i <= n; i ++ ) {

		const d = Math.hypot( i, j, k ) * RELOCATE_STEP;
		if ( d > 0 && d <= RELOCATE_REACH ) OFFSETS.push( [ i * RELOCATE_STEP, j * RELOCATE_STEP, k * RELOCATE_STEP, d ] );

	}
	OFFSETS.sort( ( a, b ) => a[ 3 ] - b[ 3 ] );

}

/** The nine real spherical harmonics up to degree 2 at a unit direction, in three.js's
 * SphericalHarmonics3 order and normalisation (y up), into out[ o .. o + 8 ]. */
export function shBasis( x: number, y: number, z: number, out: Float64Array | Float32Array, o: number ): void {

	out[ o ] = 0.282095;
	out[ o + 1 ] = 0.488603 * y;
	out[ o + 2 ] = 0.488603 * z;
	out[ o + 3 ] = 0.488603 * x;
	out[ o + 4 ] = 1.092548 * x * y;
	out[ o + 5 ] = 1.092548 * y * z;
	out[ o + 6 ] = 0.315392 * ( 3 * z * z - 1 );
	out[ o + 7 ] = 1.092548 * x * z;
	out[ o + 8 ] = 0.546274 * ( x * x - y * y );

}

// ------------------------------------------------------------------ the scene

/** What a chunk's bake reads, all from its window (Chunks.ts `setup`). */
export interface AmbientScene {
	fp: Footprint;
	// the island's SDF over the window
	sdf: SDF;
	// the rendered floor's height
	floor: HeightFn;
	// the stones round the chunk, with their bounds
	stones: readonly SolidBounds[];
}

// voxel kinds
const UNKNOWN = 0, EMPTY = 1, ISLAND = 2, STONE = 3, FLOOR = 4;

// The rock's albedo at height y: wet and dark under the water, its gain above (TerrainMaterial.ts).
function rock( y: number, out: number[] ): void {

	const g = 1 + ( ROCK_GAIN - 1 ) * smoothstep( - 0.5, 0.5, y );
	for ( let c = 0; c < 3; c ++ ) out[ c ] = ROCK[ c ] * g;

}

// One chunk's tracer: the lazily voxelised solids and the groves' medium over the chunk and what
// its rays reach round it.
class Tracer {

	// ray results: sky visibility, sea visibility and bounced light, and the groves' in-scatter
	// among the latter
	vis = 0;
	sea = 0;
	r = 0;
	g = 0;
	b = 0;
	scatterR = 0;
	scatterG = 0;
	scatterB = 0;

	private readonly scene: AmbientScene;
	// voxels: origin (in voxels), size
	private readonly vi0: number;
	private readonly vk0: number;
	private readonly vj0: number;
	private readonly nx: number;
	private readonly ny: number;
	private readonly nz: number;
	private readonly kind: Uint8Array;
	// per column: the island's side (2: not yet), the plateau's height, the floor's height, the stones
	private readonly side: Int8Array;
	private readonly top: Float32Array;
	private readonly floorAt: Float32Array;
	private readonly columnStones: ( Int32Array | null )[];
	private readonly stoneTop: number;
	// a hit voxel's bounced radiance: its index into `hits` (-1: not yet)
	private readonly hitIndex: Int32Array;
	private hits = new Float32Array( 3 * 4096 );
	private hitCount = 0;
	// the medium: per 1 m cell the ground, the culms' top, the crown's foot, the culms' and the
	// leaves' extinction (per m)
	private readonly mi0: number;
	private readonly mk0: number;
	private readonly mn: number;
	private readonly ground: Float32Array;
	private readonly mediumTop: Float32Array;
	private readonly crown: Float32Array;
	private readonly culms: Float32Array;
	private readonly leaves: Float32Array;
	private readonly albedo = [ 0, 0, 0 ];

	constructor( scene: AmbientScene, box: Bounds ) {

		this.scene = scene;
		const pad = REACH + HIT_REACH + 2 * VOXEL;
		this.vi0 = Math.floor( ( box.x0 - pad ) / VOXEL ); this.vk0 = Math.floor( ( box.z0 - pad ) / VOXEL );
		this.nx = Math.ceil( ( box.x1 + pad ) / VOXEL ) - this.vi0; this.nz = Math.ceil( ( box.z1 + pad ) / VOXEL ) - this.vk0;
		this.vj0 = Math.floor( VOX_LOW / VOXEL ); this.ny = Math.ceil( VOX_HIGH / VOXEL ) - this.vj0;
		const columns = this.nx * this.nz;
		this.kind = new Uint8Array( columns * this.ny );
		this.hitIndex = new Int32Array( columns * this.ny ).fill( - 1 );
		this.side = new Int8Array( columns ).fill( 2 );
		this.top = new Float32Array( columns );
		this.floorAt = new Float32Array( columns );
		this.columnStones = new Array( columns ).fill( null );
		this.stoneTop = scene.stones.reduce( ( m, s ) => Math.max( m, s.max[ 1 ] ), - Infinity );

		// the medium over the land
		const mpad = REACH + HIT_REACH + 2;
		this.mi0 = Math.floor( ( box.x0 - mpad ) / MEDIUM_CELL ); this.mk0 = Math.floor( ( box.z0 - mpad ) / MEDIUM_CELL );
		const mn = this.mn = Math.ceil( ( box.x1 - box.x0 + 2 * mpad ) / MEDIUM_CELL ) + 1;
		this.ground = new Float32Array( mn * mn ); this.mediumTop = new Float32Array( mn * mn ).fill( - Infinity );
		this.crown = new Float32Array( mn * mn ); this.culms = new Float32Array( mn * mn ); this.leaves = new Float32Array( mn * mn );
		const P = GROVES, outside = ( x: number, z: number ) => scene.fp.dist( x, z ) > - P.inset;
		const crowns = this.plantCrowns( outside );
		for ( let k = 0; k < mn; k ++ ) for ( let i = 0; i < mn; i ++ ) {

			const x = ( this.mi0 + i + 0.5 ) * MEDIUM_CELL, z = ( this.mk0 + k + 0.5 ) * MEDIUM_CELL, c = k * mn + i;
			if ( outside( x, z ) ) continue;
			const d = groveAt( x, z ), g = islandSurfaceHeight( x, z ), crowned = Math.min( crowns[ c ], 1 );
			// a culm's mean height and diameter at this density (BambooGroves.ts culmAt), and the
			// crowns' mean height at theirs
			const H = P.height * ( 0.85 + 0.15 * d ) * 0.95, D = H / P.slender;
			const crownH = P.height * ( 0.85 + 0.15 * crowned ) * 0.95;
			this.ground[ c ] = g;
			this.mediumTop[ c ] = g + Math.max( H, crownH );
			this.crown[ c ] = g + BRANCHES * crownH;
			// culms per m^2 times their diameter: a level ray's extinction (per m)
			this.culms[ c ] = ( P.stray + ( P.dense - P.stray ) * d ) / ( P.cell * P.cell ) * D;
			// the crown's: its depth's optical thickness leaves the canopy's groveSky straight up
			this.leaves[ c ] = - Math.log( 1 - P.shade * crowned ) / ( ( 1 - BRANCHES ) * crownH );

		}

	}

	// The crowns' density on the medium's cells, over a grove's deep inside: every culm the lattice
	// draws with its foot in the medium's square (and not `outside` the land), its crown from
	// BRANCHES of its height to its top in CROWN_STEPS points along its axis (the
	// instances' lean and bow, vegetation/PlantInstances.ts `stemAxis`, level offset only), each spread over its centre and 8 points round it at the leaves' reach.
	private plantCrowns( outside: ( x: number, z: number ) => boolean ): Float32Array {

		const P = GROVES, mn = this.mn, x0 = this.mi0 * MEDIUM_CELL, z0 = this.mk0 * MEDIUM_CELL, side = mn * MEDIUM_CELL;
		const crowns = new Float32Array( mn * mn ), share = 1 / ( CROWN_STEPS * 9 ) / ( P.dense / ( P.cell * P.cell ) ) / ( MEDIUM_CELL * MEDIUM_CELL );
		const stands = ( x: number, z: number ) => ! outside( x, z ), level = () => 0;
		const i0 = Math.floor( x0 / P.cell ), i1 = Math.ceil( ( x0 + side ) / P.cell );
		const j0 = Math.floor( z0 / P.cell ), j1 = Math.ceil( ( z0 + side ) / P.cell );
		for ( let j = j0; j < j1; j ++ ) for ( let i = i0; i < i1; i ++ ) {

			const culm = culmAt( i, j, stands, level );
			if ( culm === null || culm.x < x0 || culm.x >= x0 + side || culm.z < z0 || culm.z >= z0 + side ) continue;
			const h = culm.height, reach = 0.6 * BRANCH * h, sin = Math.sin( culm.lean );
			for ( let a = 0; a < CROWN_STEPS; a ++ ) {

				const s = BRANCHES + ( 1 - BRANCHES ) * ( a + 0.5 ) / CROWN_STEPS, off = s * h * sin + culm.bow * Math.pow( s, 2.5 );
				const cx = culm.x + culm.outX * off, cz = culm.z + culm.outZ * off;
				for ( let b = 0; b < 9; b ++ ) {

					const r = b === 0 ? 0 : reach, t = b * Math.PI / 4;
					const mi = Math.floor( ( cx + r * Math.cos( t ) ) / MEDIUM_CELL ) - this.mi0, mk = Math.floor( ( cz + r * Math.sin( t ) ) / MEDIUM_CELL ) - this.mk0;
					if ( mi >= 0 && mk >= 0 && mi < mn && mk < mn ) crowns[ mk * mn + mi ] += share;

				}

			}

		}
		return crowns;

	}

	// ---------------------------------------------------------------- the solids

	/** The solid at a point (a voxel kind), exact (no voxel). */
	solidAt( x: number, y: number, z: number ): number {

		const { fp, sdf, stones, floor } = this.scene;
		const side = solidSide( fp, x, z );
		if ( y > ISLAND_BOTTOM - 0.3 && y < ISLAND_PEAK + 0.6 ) {

			if ( side < 0 ? y > ISLAND_BOTTOM && y < islandSurfaceHeight( x, z ) : side === 0 && sdf( x, y, z ) < 0 ) return ISLAND;

		}
		if ( y < this.stoneTop ) for ( const s of stones ) {

			if ( x < s.min[ 0 ] || x > s.max[ 0 ] || y < s.min[ 1 ] || y > s.max[ 1 ] || z < s.min[ 2 ] || z > s.max[ 2 ] ) continue;
			if ( s.field( x, y, z ) < 0 ) return STONE;

		}
		return y < floor( x, z ) ? FLOOR : EMPTY;

	}

	// A voxel's kind, by its centre, evaluated once (as `solidAt`, the column's values cached).
	private voxel( v: number ): number {

		const known = this.kind[ v ];
		if ( known !== UNKNOWN ) return known;
		const nx = this.nx, column = v % ( nx * this.nz ), j = ( v - column ) / ( nx * this.nz );
		const i = column % nx, k = ( column - i ) / nx;
		const x = ( this.vi0 + i + 0.5 ) * VOXEL, y = ( this.vj0 + j + 0.5 ) * VOXEL, z = ( this.vk0 + k + 0.5 ) * VOXEL;
		const { fp, sdf, stones, floor } = this.scene;
		if ( this.side[ column ] === 2 ) {

			this.side[ column ] = solidSide( fp, x, z );
			this.top[ column ] = islandSurfaceHeight( x, z );
			this.floorAt[ column ] = floor( x, z );

		}
		let kind = EMPTY;
		const side = this.side[ column ];
		if ( y > ISLAND_BOTTOM - 0.3 && y < ISLAND_PEAK + 0.6 && ( side < 0 ? y > ISLAND_BOTTOM && y < this.top[ column ] : side === 0 && sdf( x, y, z ) < 0 ) ) kind = ISLAND;
		if ( kind === EMPTY && y < this.stoneTop ) {

			let list = this.columnStones[ column ];
			if ( list === null ) {

				const own: number[] = [];
				stones.forEach( ( s, n ) => { if ( x >= s.min[ 0 ] && x <= s.max[ 0 ] && z >= s.min[ 2 ] && z <= s.max[ 2 ] ) own.push( n ); } );
				list = this.columnStones[ column ] = Int32Array.from( own );

			}
			for ( let n = 0; n < list.length; n ++ ) {

				const s = stones[ list[ n ] ];
				if ( y >= s.min[ 1 ] && y <= s.max[ 1 ] && s.field( x, y, z ) < 0 ) { kind = STONE; break; }

			}

		}
		if ( kind === EMPTY && y < this.floorAt[ column ] ) kind = FLOOR;
		this.kind[ v ] = kind;
		return kind;

	}

	// The voxel holding a point (-1 outside the voxels' range: above them nothing is solid; below,
	// the caller treats it as the floor).
	private voxelOf( x: number, y: number, z: number ): number {

		const i = Math.floor( x / VOXEL ) - this.vi0, j = Math.floor( y / VOXEL ) - this.vj0, k = Math.floor( z / VOXEL ) - this.vk0;
		if ( i < 0 || i >= this.nx || k < 0 || k >= this.nz || j < 0 || j >= this.ny ) return - 1;
		return ( j * this.nz + k ) * this.nx + i;

	}

	// ---------------------------------------------------------------- the rays

	/**
	 * One ray from ( ox, oy, oz ) along the unit ( dx, dy, dz ), `reach` m measured horizontally.
	 * Sets `vis` (the sky's share it sees: its transmittance if it reaches the sky) and, with
	 * `bounce`, `r g b` (what the world bounces along it of a uniform white sky) and `scatter*`
	 * (the groves' in-scatter among it); a hit's own visibility takes no bounce. The voxel it
	 * starts in never stops it.
	 */
	trace( ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, reach: number, bounce: boolean ): void {

		this.vis = 0; this.sea = 0; this.r = 0; this.g = 0; this.b = 0; this.scatterR = 0; this.scatterG = 0; this.scatterB = 0;
		const level = Math.sqrt( dx * dx + dz * dz );
		let end = level > 1e-9 ? reach / level : Infinity;
		if ( oy >= SEA && dy < 0 ) end = Math.min( end, ( oy - SEA ) / - dy );
		let t = 0;
		const ceiling = CEILING;
		if ( oy > ceiling ) {

			if ( dy >= 0 ) { this.vis = 1; return; }
			t = ( oy - ceiling ) / - dy;

		}
		const start = this.voxelOf( ox, oy, oz );
		const { mi0, mk0, mn, ground, mediumTop, crown, culms, leaves } = this;
		let T = 1, sr = 0, sg = 0, sb = 0, hit = - 1, floorBelow = false;
		for ( t += STEP * 0.5; t < end; t += STEP ) {

			const x = ox + dx * t, y = oy + dy * t, z = oz + dz * t;
			if ( y > ceiling ) break;
			if ( y < VOX_HIGH ) {

				const v = this.voxelOf( x, y, z );
				if ( v < 0 ) { if ( y < VOX_LOW ) { floorBelow = true; break; } } else if ( v !== start && this.voxel( v ) !== EMPTY ) { hit = v; break; }

			}
			// the groves' medium
			const mi = Math.floor( x / MEDIUM_CELL ) - mi0, mk = Math.floor( z / MEDIUM_CELL ) - mk0;
			if ( mi < 0 || mk < 0 || mi >= mn || mk >= mn ) continue;
			const c = mk * mn + mi;
			if ( y >= mediumTop[ c ] || y <= ground[ c ] ) continue;
			const sc = culms[ c ] * level, sl = y > crown[ c ] ? leaves[ c ] : 0, st = sc + sl;
			if ( st <= 0 ) continue;
			const a = 1 - Math.exp( - st * STEP );
			if ( bounce ) {

				// isotropic single scattering of the sky light reaching the point: half the sphere,
				// through the crown above it
				const sky = 0.5 * Math.exp( - leaves[ c ] * ( mediumTop[ c ] - Math.max( y, crown[ c ] ) ) );
				const w = T * a * sky / st;
				sr += w * ( sc * CULM_MEAN[ 0 ] + sl * LEAF[ 0 ] );
				sg += w * ( sc * CULM_MEAN[ 1 ] + sl * LEAF[ 1 ] );
				sb += w * ( sc * CULM_MEAN[ 2 ] + sl * LEAF[ 2 ] );

			}
			T *= 1 - a;

		}
		if ( ! bounce ) {

			if ( hit < 0 && ! floorBelow && dy >= 0 ) this.vis = T;
			return;

		}
		// a hit lit for the first time traces its own rays, which reset this ray's results: take its
		// radiance before setting them
		const h = hit >= 0 ? this.hitRadiance( hit ) * 3 : - 1;
		this.vis = 0; this.sea = 0; this.r = sr; this.g = sg; this.b = sb;
		this.scatterR = sr; this.scatterG = sg; this.scatterB = sb;
		if ( hit >= 0 ) {

			this.r += T * this.hits[ h ]; this.g += T * this.hits[ h + 1 ]; this.b += T * this.hits[ h + 2 ];

		} else if ( floorBelow ) {

			this.r += T * SAND[ 0 ]; this.g += T * SAND[ 1 ]; this.b += T * SAND[ 2 ];

		} else if ( dy >= 0 ) {

			// the sky
			this.vis = T;

		} else if ( oy >= SEA ) {

			// the sea from above its surface: a level bounce surface the relight lights (the header)
			this.sea = T;

		}
		else { this.r += T * WATER_BODY[ 0 ]; this.g += T * WATER_BODY[ 1 ]; this.b += T * WATER_BODY[ 2 ]; }

	}

	// A hit voxel's bounced radiance under a uniform white sky (its albedo times its cosine-weighted
	// sky visibility toward its normal), once per voxel: its index into `hits`.
	private hitRadiance( v: number ): number {

		const known = this.hitIndex[ v ];
		if ( known >= 0 ) return known;
		const nx = this.nx, nxz = nx * this.nz, column = v % nxz, j = ( v - column ) / nxz;
		const i = column % nx, k = ( column - i ) / nx;
		const x = ( this.vi0 + i + 0.5 ) * VOXEL, y = ( this.vj0 + j + 0.5 ) * VOXEL, z = ( this.vk0 + k + 0.5 ) * VOXEL;
		// the normal: toward the free voxels round it
		let ax = 0, ay = 0, az = 0;
		for ( let c = - 1; c <= 1; c ++ ) for ( let b = - 1; b <= 1; b ++ ) for ( let a = - 1; a <= 1; a ++ ) {

			if ( a === 0 && b === 0 && c === 0 ) continue;
			const ii = i + a, jj = j + b, kk = k + c;
			if ( ii < 0 || ii >= nx || kk < 0 || kk >= this.nz ) continue;
			const free = jj >= this.ny ? true : jj < 0 ? false : this.voxel( ( jj * this.nz + kk ) * nx + ii ) === EMPTY;
			if ( ! free ) continue;
			const l = 1 / Math.hypot( a, b, c );
			ax += a * l; ay += b * l; az += c * l;

		}
		let l = Math.hypot( ax, ay, az );
		if ( l < 1e-6 ) { ax = 0; ay = 1; az = 0; l = 1; }
		const nX = ax / l, nY = ay / l, nZ = az / l;
		// its sky visibility: cosine-weighted rays from a voxel out along the normal
		const sx = x + nX * VOXEL, sy = y + nY * VOXEL, sz = z + nZ * VOXEL, reach = sy < SEA ? HIT_REACH_UNDER : HIT_REACH;
		// an orthonormal frame round the normal (Duff et al. 2017)
		const sign = nY >= 0 ? 1 : - 1, A = - 1 / ( sign + nY ), B = nZ * nX * A;
		const t1x = 1 + sign * nX * nX * A, t1y = - sign * nX, t1z = sign * B;
		const t2x = B, t2y = - nZ, t2z = sign + nZ * nZ * A;
		let seen = 0;
		for ( let s = 0; s < SECONDARY; s ++ ) {

			const u = HEMI[ s * 3 ], w = HEMI[ s * 3 + 1 ], q = HEMI[ s * 3 + 2 ];
			const dx = t1x * u + nX * w + t2x * q, dy = t1y * u + nY * w + t2y * q, dz = t1z * u + nZ * w + t2z * q;
			this.trace( sx, sy, sz, dx, dy, dz, reach, false );
			// (the sea seen from a hit stays sky to it, as before the sea had a channel of its own:
			// the hit's light is one bounce of a uniform white sky)
			seen += this.vis + this.sea;

		}
		const visibility = seen / SECONDARY;
		// its albedo
		const albedo = this.albedo, kind = this.kind[ v ], { fp } = this.scene;
		if ( kind === ISLAND && y > islandSurfaceHeight( x, z ) - 0.75 ) {

			// the plateau's ground: the meadow or a grove's floor, the cliff's stone over its last
			// metre and a half (GroundBounce.ts)
			const grove = groveAt( x, z ), stone = smoothstep( - 1.5, 0, fp.dist( x, z ) );
			rock( y, albedo );
			for ( let c = 0; c < 3; c ++ ) {

				const ground = LAWN_TOP[ c ] + ( GROVE_FLOOR[ c ] - LAWN_TOP[ c ] ) * grove;
				albedo[ c ] = ground + ( albedo[ c ] - ground ) * stone;

			}

		} else if ( kind === FLOOR ) {

			const rubble = smoothstep( 6.5, 0.5, fp.dist( x, z ) ) * 0.5;
			for ( let c = 0; c < 3; c ++ ) albedo[ c ] = SAND[ c ] + ( RUBBLE[ c ] - SAND[ c ] ) * rubble;

		} else rock( y, albedo );
		const n = this.hitCount ++;
		if ( n * 3 + 3 > this.hits.length ) {

			const grown = new Float32Array( this.hits.length * 2 );
			grown.set( this.hits );
			this.hits = grown;

		}
		for ( let c = 0; c < 3; c ++ ) this.hits[ n * 3 + c ] = albedo[ c ] * visibility;
		this.hitIndex[ v ] = n;
		return n;

	}

	/** Bakes the probe at ( x, y, z ) into out[ o .. o + PROBE_STRIDE ). */
	probe( x: number, y: number, z: number, out: Float32Array, o: number ): void {

		// caught in a solid: the nearest free point within half a cell, else invalid
		let px = x, py = y, pz = z;
		if ( this.solidAt( x, y, z ) !== EMPTY ) {

			const free = OFFSETS.find( ( d ) => this.solidAt( x + d[ 0 ], y + d[ 1 ], z + d[ 2 ] ) === EMPTY );
			if ( ! free ) { out.fill( 0, o, o + PROBE_STRIDE ); return; }
			px = x + free[ 0 ]; py = y + free[ 1 ]; pz = z + free[ 2 ];

		}
		const reach = py < SEA ? REACH_UNDER : REACH;
		project( ( k ) => this.trace( px, py, pz, DIRS[ k * 3 ], DIRS[ k * 3 + 1 ], DIRS[ k * 3 + 2 ], reach, true ), this, out, o );
		const m = o + META_VEC4 * 4;
		out[ m ] = px - x; out[ m + 1 ] = py - y; out[ m + 2 ] = pz - z; out[ m + 3 ] = 1;

	}

}

// a ray's results, as `Tracer` sets them
interface RayResult { vis: number; sea: number; r: number; g: number; b: number; scatterR: number; scatterG: number; scatterB: number }

// The rays' results projected on the harmonics, in their fixed order (`ray( k )` sets `result`),
// into the probe's coefficients, its in-scatter's and its sea visibility's at
// out[ o .. o + SEA_VEC4 * 4 + 9 ).
function project( ray: ( k: number ) => void, result: RayResult, out: Float32Array, o: number ): void {

	const sum = new Float64Array( 72 );
	for ( let k = 0; k < RAYS; k ++ ) {

		ray( k );
		const { vis, sea, r, g, b, scatterR, scatterG, scatterB } = result;
		for ( let i = 0; i < 9; i ++ ) {

			const y = BASIS[ k * 9 + i ];
			sum[ i * 4 ] += vis * y; sum[ i * 4 + 1 ] += r * y; sum[ i * 4 + 2 ] += g * y; sum[ i * 4 + 3 ] += b * y;
			sum[ 36 + i * 3 ] += scatterR * y; sum[ 37 + i * 3 ] += scatterG * y; sum[ 38 + i * 3 ] += scatterB * y;
			sum[ 63 + i ] += sea * y;

		}

	}
	const w = 4 * Math.PI / RAYS;
	for ( let i = 0; i < 36; i ++ ) out[ o + i ] = sum[ i ] * w;
	for ( let i = 0; i < 27; i ++ ) out[ o + SCATTER_VEC4 * 4 + i ] = sum[ 36 + i ] * w;
	for ( let i = 0; i < 9; i ++ ) out[ o + SEA_VEC4 * 4 + i ] = sum[ 63 + i ] * w;

}

// ------------------------------------------------------------------ the bakes

/** The probes of the chunk whose square is `box` (COLUMNS x COLUMNS columns of LEVELS levels, in
 * rows: K, then the level, then I), PROBE_STRIDE floats each. */
export function bakeProbes( scene: AmbientScene, box: Bounds ): Float32Array {

	const tracer = new Tracer( scene, box ), out = new Float32Array( COLUMNS * COLUMNS * LEVELS * PROBE_STRIDE );
	const I0 = Math.round( box.x0 / SPACING ), K0 = Math.round( box.z0 / SPACING );
	let o = 0;
	for ( let k = 0; k < COLUMNS; k ++ ) for ( let j = 0; j < LEVELS; j ++ ) for ( let i = 0; i < COLUMNS; i ++ ) {

		tracer.probe( ( I0 + i + 0.5 ) * SPACING, Y0 + j * SPACING, ( K0 + k + 0.5 ) * SPACING, out, o );
		o += PROBE_STRIDE;

	}
	return out;

}

/** The open sea's probe at a level (PROBE_STRIDE floats): above the water the sky above the
 * horizon and the sea below it (a level bounce surface the relight lights); under it the sky
 * through the surface above and the water's body below. */
export function openSeaProbe( level: number ): Float32Array {

	const y = Y0 + level * SPACING, out = new Float32Array( PROBE_STRIDE ), result = { vis: 0, sea: 0, r: 0, g: 0, b: 0, scatterR: 0, scatterG: 0, scatterB: 0 };
	project( ( k ) => {

		const dy = DIRS[ k * 3 + 1 ];
		result.vis = 0; result.sea = 0; result.r = 0; result.g = 0; result.b = 0;
		if ( dy >= 0 ) { result.vis = 1; return; }
		if ( y >= SEA ) { result.sea = 1; return; }
		result.r = WATER_BODY[ 0 ]; result.g = WATER_BODY[ 1 ]; result.b = WATER_BODY[ 2 ];

	}, result, out, 0 );
	out[ META_VEC4 * 4 + 3 ] = 1;
	return out;

}

// ------------------------------------------------------------------ the merge

/** The chunks' probes merged into one lattice over the box of the chunks that baked them
 * (ChunkMerge.ts, in its steps: a yield per chunk of the box). Each chunk's rows are copied into
 * its square, a square without probes (no chunk there, or one without land near) takes the open
 * sea's, and the open sea's probe per level follows the lattice. A function of the chunks' set,
 * whatever order they come in. */
export function* mergeProbes( chunks: readonly { ci: number; cj: number; ambient: Float32Array }[] ): Generator<void, AmbientLattice> {

	const baked = chunks.filter( ( c ) => c.ambient.length > 0 );
	const sea = Array.from( { length: LEVELS }, ( _, j ) => openSeaProbe( j ) );
	const ci0 = Math.min( ...baked.map( ( c ) => c.ci ) ), ci1 = Math.max( ...baked.map( ( c ) => c.ci ) );
	const cj0 = Math.min( ...baked.map( ( c ) => c.cj ) ), cj1 = Math.max( ...baked.map( ( c ) => c.cj ) );
	const wide = baked.length > 0 ? ci1 - ci0 + 1 : 0, deep = baked.length > 0 ? cj1 - cj0 + 1 : 0;
	const nx = wide * COLUMNS, ny = LEVELS, nz = deep * COLUMNS;
	const probes = new Float32Array( ( nx * ny * nz + ny ) * PROBE_STRIDE );
	sea.forEach( ( probe, j ) => probes.set( probe, ( nx * ny * nz + j ) * PROBE_STRIDE ) );
	const byKey = new Map( baked.map( ( c ) => [ ( c.cj - cj0 ) * wide + c.ci - ci0, c.ambient ] ) );
	yield;
	const row = COLUMNS * PROBE_STRIDE;
	for ( let cz = 0; cz < deep; cz ++ ) for ( let cx = 0; cx < wide; cx ++ ) {

		const own = byKey.get( cz * wide + cx );
		for ( let k = 0; k < COLUMNS; k ++ ) for ( let j = 0; j < ny; j ++ ) {

			const o = ( ( ( cz * COLUMNS + k ) * ny + j ) * nx + cx * COLUMNS ) * PROBE_STRIDE;
			if ( own ) probes.set( own.subarray( ( k * ny + j ) * row, ( k * ny + j + 1 ) * row ), o );
			else for ( let i = 0; i < COLUMNS; i ++ ) probes.set( sea[ j ], o + i * PROBE_STRIDE );

		}
		yield;

	}
	yield* fillInvalid( probes, nx, ny, nz );
	// the probe ( 0, 0, 0 )'s column is the box's first chunk's first (none: an empty box at 0)
	const side = COLUMNS * SPACING;
	return {
		x0: wide > 0 ? ci0 * side + SPACING / 2 : 0, y0: Y0, z0: deep > 0 ? cj0 * side + SPACING / 2 : 0,
		spacing: SPACING, nx, ny, nz, probes,
	};

}

/** The passes of the invalid probes' fill: each reaches a cell farther into a solid. A surface's
 * lookup reads the probes of its cell, which a relocation leaves at most a cell into the solid. */
export const FILL_PASSES = 3;

// The invalid probes' fill (a yield per slice of the box): FILL_PASSES passes of a dilation, in
// which an invalid probe not yet filled takes the mean of its six neighbours that are valid or were
// filled in an earlier pass (summed in a fixed order, in doubles), so a pass never reads its own
// writes and the result is a function of the lattice alone. Valid probes are left as they are; a
// filled one keeps `valid` 0 and no offset, so the debug view still shows where the bake found a
// solid, and one deeper than the passes reach stays zero.
function* fillInvalid( probes: Float32Array, nx: number, ny: number, nz: number ): Generator<void> {

	const VALID = 255, COEFFICIENTS = PROBE_STRIDE - 4;
	const pass = new Uint8Array( nx * ny * nz );
	for ( let p = 0; p < pass.length; p ++ ) pass[ p ] = probes[ p * PROBE_STRIDE + PROBE_STRIDE - 1 ] > 0 ? VALID : 0;
	const sum = new Float64Array( COEFFICIENTS );
	const steps = [ - 1, 1, - nx, nx, - nx * ny, nx * ny ];
	for ( let t = 1; t <= FILL_PASSES; t ++ ) {

		for ( let k = 0; k < nz; k ++ ) {

			for ( let j = 0; j < ny; j ++ ) for ( let i = 0; i < nx; i ++ ) {

				const p = ( k * ny + j ) * nx + i;
				if ( pass[ p ] !== 0 ) continue;
				const inside = [ i > 0, i < nx - 1, j > 0, j < ny - 1, k > 0, k < nz - 1 ];
				sum.fill( 0 );
				let n = 0;
				for ( let s = 0; s < 6; s ++ ) {

					if ( ! inside[ s ] ) continue;
					const q = p + steps[ s ], state = pass[ q ];
					if ( state === 0 || ( state !== VALID && state >= t ) ) continue;
					for ( let c = 0; c < COEFFICIENTS; c ++ ) sum[ c ] += probes[ q * PROBE_STRIDE + c ];
					n ++;

				}
				if ( n === 0 ) continue;
				for ( let c = 0; c < COEFFICIENTS; c ++ ) probes[ p * PROBE_STRIDE + c ] = sum[ c ] / n;
				pass[ p ] = t;

			}
			yield;

		}

	}

}
