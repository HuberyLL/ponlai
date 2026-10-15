import * as THREE from 'three/webgpu';
import {
	Fn, attribute, positionLocal, normalViewGeometry, vec2, vec3, vec4, float, mix, max, dot, pow, clamp, fract, sin, select, normalize,
	length, cameraPosition, cameraViewMatrix, cameraProjectionMatrix, screenSize, varying, varyingProperty, uniform,
	smoothstep as smoothstepN, instanceIndex, vertexIndex, normalLocal, transformNormal, instanceColor, sign, abs, cos, step, specularColor, specularColorBlended, specularF90,
	positionGeometry, cross, If,
} from 'three/tsl';
import { sampleRimGround, rimGrassCover } from './RimGround.ts';
import type { RimGroundField } from './types.ts';
import { mulberry32, noise3, smoothstep } from './noise.ts';
import { anchorStream, cellStream } from './Anchors.ts';
import { SWARD_HEIGHT, meadowColor, meadowMoisture, meadowTurf, supportsMeadow } from '../materials/Meadow.ts';
import { soilUniforms } from '../materials/Soil.ts';
import { rootHash } from '../weather/Wind.ts';
import { bendBlade, bladePhase, drown, swayFade } from './vegetation/Deform.ts';
import { CANOPY_TOP, TURF_CANOPY_DEPTH, meadowCanopyLight } from '../lighting/MeadowCanopy.ts';
import { puddleCover } from '../weather/Puddles.ts';
import { VEGETATION_STRIDE as STRIDE } from './types.ts';
import { ALPHA_TO_COVERAGE } from './vegetation/Coverage.ts';
import { backlight, forwardLight, vegetationMaterial, type VegetationOptions } from './vegetation/Material.ts';
import { debugFlags } from '../debug/DebugFlags.ts';
import { TEMPORAL } from '../post/Antialiasing.ts';
import { VegetationCull, poolBuffers, poolSteps, type CullBatchInput, type CullBuffers, type CullPayload, type CullPool, type CullRange } from './vegetation/VegetationCull.ts';
import { AttributeType, uploadSteps } from './Upload.ts';
import { screenShare, screenShareNode } from './vegetation/Lod.ts';
import type { VegetationKind } from './vegetation/Registry.ts';
import type { Shared } from '../shared.ts';
import type { SunShadow } from '../lighting/SunShadow.ts';

// The meadow on the island top: a lawn even as a whole and of blades each its own, one instanced
// tuft on every planting anchor and a second on about a quarter of them, so it reads as a dense,
// even sward that sways with the wind as one. The blades are sword-shaped, wide to two thirds up
// and running to a point; each takes its own height, facing, lean and arc and its own value and
// tint, all hashed from the blade and its anchor, most standing nearly upright and a few leaning
// over. One grass colour (Meadow.ts), a deeper, cooler green at the root and a lighter, yellower
// one at the tip, where the key light shines through the blade,
// with a faint gloss along it and little of a dielectric's specular; soft upward normals join the
// blades to the turf rather than lighting every tuft as a cushion, and each blade is folded along
// its midrib, one half turned to the light and the other from it, with a thin lighter edge.
// Anchors come from
// the world worker (x, y, z, normal, rim distance, kind and local sky visibility); every choice
// below is a seeded hash of the anchor, so the meadow grows with the island's footprint and needs
// no placed features.
//
// Rules (the look is in docs/art-direction.md; the reasons are below, where each is built):
// - An even lawn: no clumps, tall islands or bare patches (from the overview they read as dark
//   blotches). What varies is per blade (`restBlade`, the tints), far finer than any patch, with
//   its mean kept: the lawn's average height and colour stay those of the field. Each tuft spreads its blades over about its anchor's share of the ground. The extra
//   tufts fold away beyond about 35 m and are not drawn past their fold, 42 m. Toward the coast the
//   tufts grow taller and lean out over the lip instead of thinning (RimGround).
// - Blades do not cast into the sun's shadow map (narrower than a texel, they flicker as the sun
//   moves): the meadow shades itself and its turf through MeadowCanopy. What the larger casters
//   (rock, the islanders, the game's props) throw onto the blades is soft and light: a few bilinear lookups
//   of the sun's map around each vertex (`SunShadow.softVisibility`), no penumbra search, taken in
//   the vertex stage and handed to the sun's filter in place of its own (`userData.sunVisibility`);
//   the clouds' shade multiplies in as on every surface (SolarShadow's `installOpenShadow`).
// - On screen a blade stays at least two pixels wide (0.75 on the outer rim, where partly covered
//   pixels show a pale fringe over the sea), so the meadow does not crawl as the camera moves, and
//   the coverage the widening would lower is kept by whole blades instead: a widened blade draws
//   solid as far up as its coverage stays above its own hash. No pixel of a blade is partly
//   covered (alpha to coverage drew its sample patterns as a grid of dots along the blades). Close
//   up blades render unchanged. Single-sampled (`msaa=1`) blades stay one pixel wide.
// - Each tuft draws fewer blades the farther it stands from the view camera: on high every one of
//   its 16 within 25 m, easing to 8 at 45 m and to 4 at 70 m (GrassQuality), and beyond that as
//   vegetation/Lod.ts's rule has it, by ( 70 m / distance )^2 (2 at about 100 m), never
//   fewer than two (LEAST_BLADES). A dropped blade narrows to nothing over a short distance of its
//   own, and the kept ones widen and cover for it (`tuftLod`, `pixelWideBlade`), so density and
//   brightness hold. The island view sees its whole meadow from 120 to 200 m: it drew 4 blades a
//   tuft there, so the meadow's cost grew with the island's area (its vertex stage: hiding it saved
//   as much at 1080p as at 1440p), and draws two now. A blade standing in for several of
//   the 70 m blades draws as that many strips, each its own fold and tint, so the far lawn keeps
//   its grain (`bladeStrips`). It is a function of the
//   tuft's distance from the camera's position alone (no hysteresis), so a paused frame does not
//   depend on the camera's path; other cameras draw every blade. The cull sorts the view's tufts
//   into bands by the blades they keep and draws each band with only those (`bandCaps`,
//   vegetation/VegetationCull.ts), so the narrowed blades cost no vertex work either.
// - The view camera's draws are culled per tuft on the GPU (vegetation/VegetationCull.ts, the
//   tufts' payload and spheres `GRASS_PAYLOAD`); every other draw over
//   the same geometry draws every tuft. Tufts bend with the wind field at their root and their
//   normals turn with the bend, so a gust shows as a sheen (vegetation/Deform.ts `bendBlade`, its
//   numbers GRASS_WIND, which the wind probe reads too).
// - A tuft's sway and shiver fade out as it shrinks to a few pixels on screen, its head with it,
//   while its lean in the gusts stays (Deform.ts `swayFade`): far off, a swinging flower head or
//   blade under a pixel crosses the multisamples and flashes from frame to frame, and the slow
//   lean alone shows the gusts sweeping the meadow. A function of the tuft's root and the current
//   camera, so a paused frame repeats; tufts large on screen sway to the bit as before.
// - Under the temporal modes a blade's previous position (motion vectors) is its bend under the
//   previous frame's wind from the same rooted point, widened by this frame's offset: the culled
//   list keeps each tuft's own slot, so the tuft is the same whichever instance draws it.
// - The meadow's wildflowers are part of it: some lawn tufts carry one flower head about at their
//   blades' tips, some partly hidden among them. Six species of a warm temperate coast, each in
//   patches of its own where its habitat is (the moisture and turf fields of Meadow.ts, the rim
//   distance), dense at a patch's centre and thinning to its edge, almost none between the
//   patches (`FlowerPatches`, the species and their habitats at SPECIES), and none on the stacks
//   or on the islander's walking loop. The flowering tufts are a batch of their own
//   over the lawn's blades and a head (`flowerTuftGeometry`), so the other tufts run no head
//   vertices; the head's indices come first, so every band keeps it whole while its tuft drops
//   blades. A head goes through the blades' stages (placed by its tuft, bent by the wind as a tip,
//   shaded by the larger casters, out of the sun's map), taking its own pose, petal colour and
//   light in a blend by its vertex flag (`headPose`, `headShape`: no new varying, the head's
//   values ride in the blade's; its species by the tuft's flower code). Far off it widens to a
//   least size on screen and is drawn whole by its hash, as the blades are, and rises above its
//   tuft's widened blades as they thin (HEAD_LIFT), so the island view shows the meadow's flowers
//   as fine coloured specks gathered in patches.

interface TuftShape {
	blades: number; segs: number;
	r0: [ number, number ]; // base offset from the tuft's axis
	h: [ number, number ]; // blade height
	lean: [ number, number ];
	w: [ number, number ]; // blade width at the root
	droop: number; // how far a leaning blade's tip falls back
	reachPow: number; // < 2 bends the blade out sooner, from lower down
}

// Lawn: 16 sword-shaped blades, standing almost upright in the shared geometry (a lean of at most
// about 15 degrees at the tuft's scale, PLANT_SPREAD by SWARD_HEIGHT; each blade's own height,
// facing and lean come in the vertex stage, `restBlade`), their roots spread evenly over a disc of
// about twice the anchors' spacing (r0 is drawn by area), so neighbouring tufts meet in one sward
// instead of rosettes. Two segments are enough for blades this short: the arc's one bend sits at
// their upper level. Their widths keep the lawn's cover with the pointed tips.
const LAWN: TuftShape = { blades: 16, segs: 2, r0: [ 0, 0.2 ], h: [ 0.9, 1 ], lean: [ 0.02, 0.08 ], w: [ 0.034, 0.048 ], droop: 0.15, reachPow: 2 };
// Each blade's own rest pose, a hash of the blade and its tuft's anchor (`restBlade`): its height
// times 0.75 to 1.25 (and one in twelve a fifth taller, the mean kept at 1), its width axis turned
// by up to FACING / 2 either way, and a lean of LEAN_MIN to LEAN_MAX of its height toward any side,
// growing with the square of the way up, so the blade arcs. The lean is the hash to LEAN_POWER, so
// most blades stand nearly upright (at the sward's height 16 degrees at least, half of them under
// 20, four in five under 28) and a few lean well over (to 38): from the game's 62 degree view a leaning blade turns
// its face to the camera, and with the lean spread evenly over the range the lawn read at 60 m as
// a cover of broad leaves, without the upright grain of grass; the few that lean far cross the
// upright ones here and there. Leaner still (LEAN_MIN toward 0) stands the tufts up as clumps with
// turf between them, which the 32 px block contrast of the lawn picks up. HEIGHT_MAX and LEAN_MAX
// bound the cull's box (`restBox`).
const TALL_SHARE = 1 / 12, TALL = 1.2;
const HEIGHT_MAX = 1.25 * TALL / ( 1 + TALL_SHARE * ( TALL - 1 ) );
const FACING = Math.PI, LEAN_MIN = 0.08, LEAN_MAX = 0.22, LEAN_POWER = 3;
// The tuft's scale across (its local x and z, m per unit) about which its own jitter varies.
const PLANT_SPREAD = 1;
// The share of the anchors that take a second tuft (the extra tufts, folded away by distance):
// as many as the growth field's thick patches gave before, so the lawn keeps its blade budget.
const THIN_SHARE = 0.28;
// The meadow's wildflowers are heads on some of its lawn tufts (`flowerTuftGeometry`), grown as
// the wildflowers of a warm temperate coast grow: each species in patches of its own where its
// habitat is, dense at a patch's centre and thinning to its edge, and almost none between the
// patches. Pinks (Dianthus chinensis) in loose clumps along the cliff's edge, where the soil is thin
// and dry, and on dry ground inland; wild chrysanthemums in dense clusters of small heads, mostly
// yellow and a few white, on the grassy ground in from the edge and in the taller sward; daylilies
// in loose clumps where the ground is damp; dandelions and violets in small, low patches of short
// turf; a few balloon flowers on dry ground (the habitat fields, `meadowMoisture` and `meadowTurf`,
// Meadow.ts). They flower from spring to autumn; here they all flower at once, the year round,
// which is the island's sign of an immortals' land. From the game's camera a scatter of five
// colours read as confetti strewn over the lawn; patches of one colour read as the meadow's own
// flowers. Each species' patch (`SPECIES`): its radius (m, a range), the share of its tufts that
// flower at its centre (`peak`, falling by 1 - u^2 at u of its radius), and its weight in a
// habitat (`habitat`).
type Species = { radius: [ number, number ]; peak: number };
const DIANTHUS = 0, CHRYSANTHEMUM = 1, DAYLILY = 2, DANDELION = 3, VIOLET = 4, BALLOON = 5;
// (a head of its own: the white wild chrysanthemum, WHITE_SHARE of that species' patches)
const CHRYSANTHEMUM_WHITE = 6, WHITE_SHARE = 0.25;
/** The flower heads by number (a flowering tuft's code is 1.5 + its number), for probes. */
export const FLOWER_SPECIES = [ 'dianthus', 'chrysanthemum', 'daylily', 'dandelion', 'violet', 'balloon-flower', 'chrysanthemum-white' ];
const SPECIES: Species[] = [
	{ radius: [ 0.45, 0.9 ], peak: 0.85 }, // pinks: loose clumps
	{ radius: [ 0.4, 1 ], peak: 0.95 }, // wild chrysanthemum: dense clusters
	{ radius: [ 0.6, 1.6 ], peak: 0.55 }, // daylily: loose clumps
	{ radius: [ 0.3, 0.8 ], peak: 0.75 }, // dandelion: small patches
	{ radius: [ 0.3, 0.8 ], peak: 0.75 }, // violet: low patches
	{ radius: [ 0.3, 0.7 ], peak: 0.5 }, // balloon flower: a few
];
// The inland patches: a world-anchored lattice of PATCH_CELL (m), each cell offering PATCH_SLOTS
// patch centres jittered over it, each taken with PATCH_SHARE times a broad field's factor
// (PATCH_FIELD cycles per metre, its noise turning over between PATCH_EDGE: stretches of the meadow
// with many patches, stretches with a fifth as many, PATCH_FLOOR) and the habitat's total weight
// there. The species is drawn by its habitat weights at the centre. A patch reaches no farther than
// PATCH_CELL from its centre, so a tuft looks at its own cell and the eight round it. None outward
// of INLAND_RIM (rim distance, m: fading from its first value to its second), where the edge's
// own patches take over.
const PATCH_CELL = 4.5, PATCH_SLOTS = 3, PATCH_SHARE = 0.7, PATCH_FIELD = 0.05, PATCH_EDGE = [ - 0.3, 0.3 ], PATCH_FLOOR = 0.2;
const INLAND_RIM = [ - 4, - 2.8 ];
// The edge's patches: a finer lattice of EDGE_CELL (m), one patch a cell for EDGE_SHARE of them
// times a field along the coast (EDGE_FIELD cycles per metre, turning over between EDGE_EDGE), so
// they make a broken band with gaps; a patch is pinks for EDGE_DIANTHUS of them, else wild
// chrysanthemums. Each grows only in its own band of rim distance (m, in from the first two values,
// out to the last two): the pinks on the outer edge (DIANTHUS_BAND), the chrysanthemums on the
// grass in from it (CHRYSANTHEMUM_BAND).
const EDGE_CELL = 1.1, EDGE_SHARE = 0.9, EDGE_FIELD = 0.12, EDGE_EDGE = [ - 0.45, 0.1 ], EDGE_DIANTHUS = 0.75;
const DIANTHUS_BAND = [ - 3.2, - 2.2, - 0.6, - 0.35 ], CHRYSANTHEMUM_BAND = [ - 5.5, - 4.2, - 1.6, - 1 ];
// Between the patches STRAY of the tufts flower alone, of the species their own spot favours. None
// on the rock stacks or within FLOWER_CLEAR (m) of the islander's walking loop (WalkLoop.ts),
// where the walker's legs pass.
const STRAY = 0.004, FLOWER_CLEAR = 0.5;

const band = ( b: number[], rim: number ) => smoothstep( b[ 0 ], b[ 1 ], rim ) * ( 1 - smoothstep( b[ 2 ], b[ 3 ], rim ) );

/** The inland species' weights in the habitat of moisture `wet` and sward `tall` (Meadow.ts):
 * daylilies where it is damp, pinks and a few balloon flowers where it is dry, dandelions and
 * violets where the turf is short, wild chrysanthemums where it is tall. */
function habitat( wet: number, tall: number, out: number[] ): number[] {

	const short = 1 - 0.8 * tall, dry = smoothstep( 0.4, 0.2, wet );
	out[ DIANTHUS ] = 0.8 * dry;
	out[ CHRYSANTHEMUM ] = 0.4 * tall;
	out[ DAYLILY ] = 2 * smoothstep( 0.55, 0.75, wet );
	out[ DANDELION ] = 1.2 * short;
	out[ VIOLET ] = 0.9 * short;
	out[ BALLOON ] = 0.9 * dry;
	return out;

}

/** The species a habitat's weights `w` give the draw `u` (0 to 1). */
function pickSpecies( w: number[], u: number ): number {

	let at = u * w.reduce( ( a, b ) => a + b, 0 );
	for ( let s = 0; s < w.length; s ++ ) {

		if ( at < w[ s ] ) return s;
		at -= w[ s ];

	}
	return w.length - 1;

}

interface Patch { x: number; z: number; r: number; species: number; head: number }

/** The meadow's flower patches, each lattice cell's computed once per planting (every value a
 * function of the cell alone). */
class FlowerPatches {

	private inland = new Map<number, Patch[]>();
	private edge = new Map<number, Patch[]>();
	private weights = SPECIES.map( () => 0 );

	private patch( x: number, z: number, species: number, size: number, white: number ): Patch {

		const [ r0, r1 ] = SPECIES[ species ].radius;
		return { x, z, r: r0 + size * ( r1 - r0 ), species, head: species === CHRYSANTHEMUM && white < WHITE_SHARE ? CHRYSANTHEMUM_WHITE : species };

	}

	private inlandCell( i: number, j: number ): Patch[] {

		const key = i * 65536 + j;
		let list = this.inland.get( key );
		if ( list ) return list;
		list = [];
		for ( let k = 0; k < PATCH_SLOTS; k ++ ) {

			const rng = cellStream( i, j, 401 + k );
			const take = rng(), x = ( i + rng() ) * PATCH_CELL, z = ( j + rng() ) * PATCH_CELL, pick = rng(), size = rng(), white = rng();
			const field = PATCH_FLOOR + ( 1 - PATCH_FLOOR ) * smoothstep( PATCH_EDGE[ 0 ], PATCH_EDGE[ 1 ], noise3( x * PATCH_FIELD - 7.7, 3.4, z * PATCH_FIELD + 5.1 ) );
			const w = habitat( meadowMoisture( x, z ), meadowTurf( x, z, - Infinity ), this.weights );
			if ( take >= PATCH_SHARE * field * Math.min( w.reduce( ( a, b ) => a + b, 0 ), 1 ) ) continue;
			list.push( this.patch( x, z, pickSpecies( w, pick ), size, white ) );

		}
		this.inland.set( key, list );
		return list;

	}

	private edgeCell( i: number, j: number ): Patch[] {

		const key = i * 65536 + j;
		let list = this.edge.get( key );
		if ( list ) return list;
		list = [];
		const rng = cellStream( i, j, 409 );
		const take = rng(), x = ( i + rng() ) * EDGE_CELL, z = ( j + rng() ) * EDGE_CELL, pick = rng(), size = rng(), white = rng();
		const field = smoothstep( EDGE_EDGE[ 0 ], EDGE_EDGE[ 1 ], noise3( x * EDGE_FIELD + 2.9, 8.6, z * EDGE_FIELD - 4.4 ) );
		if ( take < EDGE_SHARE * field ) list.push( this.patch( x, z, pick < EDGE_DIANTHUS ? DIANTHUS : CHRYSANTHEMUM, size, white ) );
		this.edge.set( key, list );
		return list;

	}

	/** The flower head of the patch strongest at ( x, z ), `rim` m from the edge (no colours mixed
	 * where patches overlap), and the share of its tufts that flower there, 0 between the patches. */
	strongest( x: number, z: number, rim: number ): { head: number; share: number } {

		let head = - 1, share = 0;
		const inland = 1 - smoothstep( INLAND_RIM[ 0 ], INLAND_RIM[ 1 ], rim );
		const edge = [ band( DIANTHUS_BAND, rim ), band( CHRYSANTHEMUM_BAND, rim ) ];
		const visit = ( cell: number, lists: ( i: number, j: number ) => Patch[], weight: ( p: Patch ) => number ) => {

			const ci = Math.floor( x / cell ), cj = Math.floor( z / cell );
			for ( let j = cj - 1; j <= cj + 1; j ++ ) for ( let i = ci - 1; i <= ci + 1; i ++ ) for ( const p of lists.call( this, i, j ) ) {

				const u2 = ( ( x - p.x ) ** 2 + ( z - p.z ) ** 2 ) / ( p.r * p.r );
				if ( u2 >= 1 ) continue;
				const s = SPECIES[ p.species ].peak * ( 1 - u2 ) * weight( p );
				if ( s > share ) { share = s; head = p.head; }

			}

		};
		if ( inland > 0 ) visit( PATCH_CELL, this.inlandCell, () => inland );
		if ( edge[ 0 ] + edge[ 1 ] > 0 ) visit( EDGE_CELL, this.edgeCell, ( p ) => edge[ p.species === DIANTHUS ? 0 : 1 ] );
		return { head, share };

	}

	/** The head a stray flower at ( x, z ), `rim` m from the edge, takes by its own spot's habitat
	 * (draws `u`, `v`), or -1 where no flower grows. */
	stray( x: number, z: number, rim: number, u: number, v: number ): number {

		const inland = 1 - smoothstep( INLAND_RIM[ 0 ], INLAND_RIM[ 1 ], rim );
		const dianthus = band( DIANTHUS_BAND, rim ), chrysanthemum = band( CHRYSANTHEMUM_BAND, rim );
		const most = Math.max( inland, dianthus, chrysanthemum );
		if ( most <= 0 ) return - 1;
		const species = inland === most ? pickSpecies( habitat( meadowMoisture( x, z ), meadowTurf( x, z, rim ), this.weights ), u )
			: dianthus === most ? DIANTHUS : CHRYSANTHEMUM;
		return species === CHRYSANTHEMUM && v < WHITE_SHARE ? CHRYSANTHEMUM_WHITE : species;

	}

}

/** The meadow's cost knobs for a quality tier. They shape the meshes and shaders, so they apply
 * when the grass is planted and built (set them before `plantGrass`); the defaults are the high tier's. */
export interface GrassQuality {
	/** Lawn blades drawn per tuft (of 16) at the camera distances `bladeBands`: the first count up
	 * to the first distance, easing linearly to the second count at the second distance and to the
	 * third at the third, and the third beyond (see `tuftLod`). The counts change the cost only:
	 * the kept blades cover for the rest at every count. */
	lawnBlades: [ number, number, number ];
	/** Camera distances (m) from a tuft where its blade counts `lawnBlades` apply. */
	bladeBands: [ number, number, number ];
	/** Whether the extra tufts of thick patches exist at all (they fold away beyond 42 m). */
	thinTufts: boolean;
	/** Light through the canopy per vertex instead of per pixel: the dapple inside a blade is
	 * lost close up, so it suits the lower tiers only. */
	canopyPerVertex: boolean;
	/** The least width of a blade on screen (render pixels, see `pixelWideBlade`) under the
	 * temporal modes; 4x multisampling keeps 2 and one sample outside them 1. */
	minWidth: number;
}
const grassQuality: GrassQuality = { lawnBlades: [ 16, 8, 4 ], bladeBands: [ 25, 45, 70 ], thinTufts: true, canopyPerVertex: false, minWidth: 2 };

export function setGrassQuality( quality: Partial<GrassQuality> ): void {

	Object.assign( grassQuality, quality );

}

function tuftGeometry( shape: TuftShape, seed = 3 ) {

	const rng = mulberry32( seed );
	const range = ( [ a, b ]: [ number, number ] ) => a + rng() * ( b - a );
	const { blades, segs } = shape;
	// blade: its parameter along its length, the angle of its width axis in the tuft's plane, its
	// half width there and its side ( -1, 1 ) times one plus its hash within the tuft (the vertex
	// stage turns the width axis and reads the side for the fold, `grassMaterial`)
	const P: number[] = [], N: number[] = [], T: number[] = [], I: number[] = [];
	for ( let b = 0; b < blades; b ++ ) {

		const a = rng() * Math.PI * 2;
		const r0 = shape.r0[ 0 ] + Math.sqrt( rng() ) * ( shape.r0[ 1 ] - shape.r0[ 0 ] ); // even over the disc
		const ox = Math.cos( a ) * r0, oz = Math.sin( a ) * r0;
		const h = range( shape.h );
		const lean = range( shape.lean );
		const w = range( shape.w );
		const id = rng();
		const dx = Math.cos( a ), dz = Math.sin( a );
		const tw = a + Math.PI / 2 + ( rng() - 0.5 ) * 1.0; // width axis, a little twisted
		const wx = Math.cos( tw ), wz = Math.sin( tw );
		const base = P.length / 3;
		for ( let i = 0; i <= segs; i ++ ) {

			// Sword-shaped: the levels crowd toward the tip ( 0, 0.7, 1 at two segments), the blade
			// keeps most of its width (0.7) to the upper level and runs to a point; holding more of it
			// there read as broad leaves from the overview.
			const t = 1 - Math.pow( 1 - i / segs, 1.32 );
			const reach = lean * h * Math.pow( t, shape.reachPow );
			const cx = ox + dx * reach, cz = oz + dz * reach;
			const cy = h * t * ( 1.0 - shape.droop * lean * t );
			const hw = w * 0.5 * Math.sqrt( Math.max( 1 - t * t, 0 ) );
			for ( const sg of [ - 1, 1 ] ) {

				const px = cx + wx * hw * sg, pz = cz + wz * hw * sg;
				P.push( px, cy, pz );
				const nx = px, nz = pz, l = Math.hypot( nx, 0.9, nz );
				N.push( nx / l, 0.9 / l, nz / l );
				T.push( t, tw, hw, sg * ( 1 + id ) );

			}

		}

		for ( let i = 0; i < segs; i ++ ) {

			const k = base + i * 2;
			I.push( k, k + 1, k + 2, k + 1, k + 3, k + 2 );

		}

	}

	const g = new THREE.BufferGeometry();
	g.setAttribute( 'position', new THREE.Float32BufferAttribute( P, 3 ) );
	g.setAttribute( 'normal', new THREE.Float32BufferAttribute( N, 3 ) );
	g.setAttribute( 'blade', new THREE.Float32BufferAttribute( T, 4 ) );
	g.setIndex( I );
	// The box of every rest pose the vertex stage gives a blade (`restBlade`): the cull bounds a tuft
	// by it (`tuftSphere`).
	g.computeBoundingBox();
	const box = g.boundingBox!.clone();
	const top = box.max.y * HEIGHT_MAX, out = top * LEAN_MAX;
	box.max.y = top;
	box.min.x -= out; box.min.z -= out; box.max.x += out; box.max.z += out;
	g.userData.restBox = box;
	// The root half width of the widest blade, which the cull pads for the widening.
	g.userData.halfWidth = shape.w[ 1 ] * 0.5 + 0.004;
	return g;

}

// A flowering tuft: the lawn tuft's blades and one flower head, a flat disc of HEAD_SECTORS
// triangles round a centre. The head's vertices follow the blades' (so a blade's index by vertex,
// `tuftLod`, is unchanged), and its indices come first: every draw range and band of the batch
// starts with the head (`baseIndices`), so a far tuft that drops blades always keeps its flower.
// A head vertex carries `blade` = ( 1, its angle, its radius 0 or 1, HEAD_FLAG ) and in its
// position's x its place across a petal: 0 at the centre, -1 and 1 on alternate rim vertices, so
// the fragment stage reads where it lies across its sector's petal (`headShape`) without an atan.
const HEAD_SECTORS = 10;
const HEAD_FLAG = 3;
function flowerTuftGeometry( lawn: THREE.BufferGeometry ): THREE.BufferGeometry {

	const P = Array.from( lawn.getAttribute( 'position' ).array as Float32Array );
	const N = Array.from( lawn.getAttribute( 'normal' ).array as Float32Array );
	const T = Array.from( lawn.getAttribute( 'blade' ).array as Float32Array );
	const centre = P.length / 3;
	P.push( 0, 0, 0 ); N.push( 0, 1, 0 ); T.push( 1, 0, 0, HEAD_FLAG );
	for ( let i = 0; i < HEAD_SECTORS; i ++ ) {

		P.push( i % 2 === 0 ? - 1 : 1, 0, 0 ); N.push( 0, 1, 0 ); T.push( 1, i / HEAD_SECTORS * Math.PI * 2, 1, HEAD_FLAG );

	}
	const head: number[] = [];
	for ( let i = 0; i < HEAD_SECTORS; i ++ ) head.push( centre, centre + 1 + i, centre + 1 + ( i + 1 ) % HEAD_SECTORS );
	const g = new THREE.BufferGeometry();
	g.setAttribute( 'position', new THREE.Float32BufferAttribute( P, 3 ) );
	g.setAttribute( 'normal', new THREE.Float32BufferAttribute( N, 3 ) );
	g.setAttribute( 'blade', new THREE.Float32BufferAttribute( T, 4 ) );
	g.setIndex( [ ...head, ...Array.from( lawn.getIndex()!.array ) ] );
	// the head rises past the blades' box (`headPose`: at most 0.6 of the tuft's height, a daylily's
	// disc 0.14 m across near the camera and a widened one about 0.3 m far off) by less than the
	// box's bounding sphere and the cull's pad leave (WIDEN_REACH, about 0.7 m far off, and SWAY_PAD)
	g.userData.restBox = lawn.userData.restBox;
	g.userData.halfWidth = lawn.userData.halfWidth;
	g.userData.baseIndices = head.length;
	return g;

}

// Thin blades alias. Their tips are a few millimetres wide, a fraction of a pixel from the
// overview, so 4x MSAA catches them on some frames and misses them on others and the meadow
// crawls as the camera moves. Each blade is kept at least `minWidth` pixels wide on screen,
// widened across the view, and its coverage falls by the same factor, so it hides as much of the
// ground as the thin blade did at every distance. This is the treatment of thin wires after Emil
// Persson ("Phone-wire AA", Humus, 2012). Two pixels brought a slow orbit's meadow flicker most of
// the way to a supersampled render's; narrower widths left more of it, wider ones soften the
// blades further for little gain. The coverage is not drawn as partly covered pixels but as whole
// blades (`grassMaterial`'s opacity): a blade draws solid where its coverage is above its own hash.
// Without multisampling a blade keeps one pixel (a blade dithered at half its pixels across two
// read as a dotted line, sharpened further by the upscale, and one pixel kept the meadow's
// brightness as at two). Under the temporal modes a blade keeps its two pixels
// (`GrassQuality.minWidth`, set by `buildGrass`), as at 4x: one pixel darkened the meadow and lost
// the flower heads between the blades.
const grassUniforms = {
	minWidth: uniform( ALPHA_TO_COVERAGE ? 2 : 1 ), // render-target pixels
	rimMinWidth: uniform( 0.75 ), // on the outer rim, see `rimEdge` in plantGrass
	// The extra lawn tufts of thick patches fold away between these view distances (m): beyond
	// them a blade is under a pixel wide and the widened blades of the remaining tufts already
	// cover the turf, so the extras would only cost vertices.
	thinNear: uniform( 30 ),
	thinFar: uniform( 42 ),
};
// Beyond this the blade is seen nearly edge on; widening further would only smear it.
const MAX_WIDEN = 8;
const bladeCoverage = varyingProperty( 'float', 'vGrassBladeCoverage' );
// A tuft drawing c of its n blades (`tuftLod`) widens and covers with each kept blade n / c times
// as much (its gain), so the meadow hides as much ground as with every blade: a kept blade stands
// in for the dropped ones beside it. 1 with every blade drawn. The stand-in only holds where a
// blade is a few pixels across: a blade seen 16 or more pixels wide keeps its own width and
// coverage (gain 1), or near tufts with fewer blades would draw each one several times as broad
// and solid. Between 16 and 4 pixels the gain eases in.
const GAIN_FULL_PIXELS = 4;
const GAIN_NONE_PIXELS = 16;

type V3 = THREE.Node<'vec3'>;
type F = THREE.Node<'float'>;

// Per object: whether this draw thins the tufts by distance (`grassLod`, set by `selectBatch` for
// the view camera's draws and copied onto the prepass's depth copy), and per geometry the tuft's
// blades and the vertices of one blade (its blades follow one another in the index order).
const lodOn = uniform( 0 ).onObjectUpdate( ( { object } ) => object?.userData.grassLod === true ? 1 : 0 );
const tuftBlades = uniform( 16 ).onObjectUpdate( ( { object } ) => ( object as THREE.Mesh | undefined )?.geometry?.userData.grassBlades ?? 16 );
const tuftFloor = uniform( 0 ).onObjectUpdate( ( { object } ) => ( object as THREE.Mesh | undefined )?.geometry?.userData.grassFloor ?? 0 );
const bladeVerts = uniform( 6, 'uint' ).onObjectUpdate( ( { object } ) => ( object as THREE.Mesh | undefined )?.geometry?.userData.grassBladeVerts ?? 6 );
// The blade-count curve (`GrassQuality.lawnBlades` over `bladeBands`), the counts as shares of
// the lawn's 16; set by `buildGrass`.
const lodUniforms = { bands: uniform( new THREE.Vector3( 25, 45, 70 ) ), shares: uniform( new THREE.Vector3( 1, 0.5, 0.25 ) ) };
// Beyond the curve's last distance a tuft keeps its last count times vegetation/Lod.ts's share by
// distance, but never fewer than this many blades: one widened blade, even drawn as strips, read
// at the island view as long parallel streaks where the four blades showed a fine grain; two keep
// the grain at about half the four's cost.
const LEAST_BLADES = 2;
// Each tuft's cutoffs move out by up to this share of its distance (a hash of its anchor), so
// neighbouring tufts drop a given blade at different distances and no ring of half-narrowed
// blades forms around the camera; never in, so a tuft within the first band keeps every blade.
const LOD_STAGGER = 0.1;
// The cull's view of the curve: it bands the tufts by the same count (`bladeCount`); `on` follows
// `flags.grassLod` for the view's draws, `bands` `flags.grassBands` (false: every tuft in its
// batch's first band, the one draw of before, for A/Bs).
// `pad` is how much farther than its sphere's pad (WIDEN_REACH) a far tuft's widened blades reach.
const cullLod = {
	count: ( origin: V3, camera: V3, blades: F, floor: F, on: F ) => bladeCount( origin, camera, blades, floor, on ), on: uniform( 1 ), bands: uniform( 1, 'uint' ),
	pad: ( count: F, blades: F ) => max( blades.div( count ).sub( NEAR_GAIN ), 0 ).mul( MAX_WIDEN * PAD_HALF_WIDTH ),
};

/** The share of its blades a tuft of floor `floor` keeps at `distance` (m) from the view camera,
 * the curve `tuftLod` follows ( 1 near on high ); the batches' draw ranges take it at their nearest
 * tuft. */
function bladeShare( distance: number, floor: number ): number {

	const [ b0, b1, b2 ] = grassQuality.bladeBands, [ c0, c1, c2 ] = grassQuality.lawnBlades;
	const s = ( x: number ) => Math.min( Math.max( x, 0 ), 1 );
	const near = ( c0 + ( c1 - c0 ) * s( ( distance - b0 ) / ( b1 - b0 ) ) + ( c2 - c1 ) * s( ( distance - b1 ) / ( b2 - b1 ) ) ) / LAWN.blades;
	return Math.max( near * screenShare( distance, b2 ), floor, LEAST_BLADES / LAWN.blades );

}

// The cull's bands as shares of a tuft's blades (vegetation/VegetationCull.ts): a visible tuft draws in the band of
// the least cap at or above the blades it keeps. Six bands of a lawn tuft (16, 12, 8, 6, 4 and,
// from the least a tuft keeps, LEAST_BLADES, 2 on high) leave about a blade and a half of waste
// in the 25 to 45 m ring and one beyond, a blade at most past 70 m; each band is a draw of its own
// (and one of the depth prepass), most of them nearly empty in close views.
const BAND_SHARES = [ 1, 0.75, 0.5, 0.375, 0.25 ];

/** A batch's band caps (blades, descending): its most at the tier's nearest share (all its blades
 * without `grassLod`, through the first band's draw range), the shares above between, and its
 * least at the fewest a visible tuft of it keeps (`minShare`: the curve's last, or the thin tufts'
 * share at their fold). */
function bandCaps( blades: number, floor: number, minShare: number ): number[] {

	const top = Math.min( blades, Math.ceil( blades * Math.max( ...grassQuality.lawnBlades.map( ( c ) => c / LAWN.blades ), floor ) - 1e-6 ) );
	const least = Math.min( top, Math.ceil( blades * Math.max( minShare, floor ) - 1e-6 ) );
	const caps = [ top ];
	for ( const share of BAND_SHARES ) {

		const cap = Math.ceil( blades * share - 1e-6 );
		if ( cap < caps[ caps.length - 1 ] && cap > least ) caps.push( cap );

	}
	if ( least < caps[ caps.length - 1 ] ) caps.push( least );
	return caps;

}

// The blades a tuft keeps (`tuftLod`), as a node: also the cull's, which bands the tufts by it
// (VegetationCull's `CullLod`), so both compute it alike.
function bladeCount( origin: V3, camera: V3, blades: F, floor: F, on: F ): F {

	const stagger = fract( sin( dot( origin.xz, vec2( 39.3468, 11.1351 ) ) ).mul( 24634.6345 ) );
	const d = length( camera.sub( origin ) ).mul( float( 1 ).sub( stagger.mul( LOD_STAGGER ) ) );
	const { bands, shares } = lodUniforms;
	const share = mix( shares.x, shares.y, clamp( d.sub( bands.x ).div( bands.y.sub( bands.x ) ), 0, 1 ) )
		.add( shares.z.sub( shares.y ).mul( clamp( d.sub( bands.y ).div( bands.z.sub( bands.y ) ), 0, 1 ) ) );
	// (the share by distance is exactly 1 within the last band and the least count under the
	// curve's there, so a tuft within 70 m keeps the count it had to the bit)
	const far = share.mul( screenShareNode( d, bands.z ) );
	return mix( blades, blades.mul( max( far, max( floor, float( LEAST_BLADES ).div( blades ) ) ) ), on );

}

// A tuft's blades by distance, after tidewater's GrassField tier fade (Daniel Greenheck, MIT;
// the technique only): the tuft keeps c of its n blades, c falling with its distance from the view
// camera along the curve above (never below its floor, `tuftFloor`), and blade b (blades are
// generated in a random order, so any first ones are a fair subset) keeps the share
// clamp( c - b, 0, 1 ) of its width: each blade narrows to nothing over the distance in which c
// falls by one, at its own distance, rather than a batch stepping between counts. A blade of zero
// width is a degenerate triangle pair, never rasterised, and the cull's bands leave out the blades
// at or past their cap (`bandCaps`).
// The kept widths sum to c, and the gain n / c widens them back to the tuft's whole width
// (`pixelWideBlade`). Off (other cameras, `flags.grassLod = false`) every blade keeps its width
// and the gain is 1. Returns the blade's width share and the tuft's gain.
function tuftLod( origin: V3 ): { keep: F; gain: F } {

	const count = bladeCount( origin, cameraPosition, tuftBlades, tuftFloor, lodOn ).toVar();
	const blade = float( vertexIndex.div( bladeVerts ) );
	return { keep: clamp( count.sub( blade ), 0, 1 ), gain: tuftBlades.div( count ) };

}

// Returns the widened vertex and passes its coverage to the fragment stage. Positions are world
// positions: the meadow mesh stays at the origin, untransformed. `keep` narrows the blade (the
// share of its width it keeps, `tuftLod`) and `bladeGain` is its tuft's gain. A flower head's
// vertex (`head` 1) has no half width and keeps its place; its coverage is the head's own
// (`headPose`).
function pixelWideBlade( position: V3, halfWidth: V3, minWidth: F, keep: F, bladeGain: F, head: F, headCoverage: F ): V3 {

	return Fn( () => {

		const p = position.toVar();
		const toCamera = cameraPosition.sub( p ).toVar();
		const view = toCamera.div( max( length( toCamera ), 1e-4 ) ).toVar();
		// The half width as the view sees it: the part along the line of sight does not show.
		const seen = halfWidth.sub( view.mul( dot( halfWidth, view ) ) ).toVar();
		// Metres per pixel at this depth; ( 1, 1 ) of the projection is 1 / tan( fov / 2 ).
		const depth = max( cameraViewMatrix.mul( vec4( p, 1 ) ).z.negate(), 1e-3 );
		const p11 = ( cameraProjectionMatrix as unknown as { element( i: number ): { element( i: number ): F } } ).element( 1 ).element( 1 );
		const pixel = depth.mul( 2 ).div( p11.mul( screenSize.y ) );
		const halfSeen = max( length( seen ), 1e-6 ).toVar();
		// The blade's own width on screen in pixels sets how much of the tuft's gain applies;
		// written as 1 + ( gain - 1 ) * s so a gain of 1 stays exactly 1.
		const gainShare = float( 1 ).sub( smoothstepN( GAIN_FULL_PIXELS, GAIN_NONE_PIXELS, halfSeen.mul( 2 ).div( pixel ) ) );
		const gain = bladeGain.sub( 1 ).mul( gainShare ).add( 1 ).toVar();
		// A narrowing blade is widened from its narrowed width, so it keeps its coverage share
		// (keep 1 leaves every term as it was).
		const narrowed = max( halfSeen.mul( keep ), 1e-6 );
		const widen = clamp( minWidth.mul( 0.5 ).mul( pixel ).div( narrowed ), gain, gain.mul( MAX_WIDEN ) ).toVar();
		bladeCoverage.assign( mix( gain.div( widen ), headCoverage, head ) );
		return p.add( seen.mul( keep.mul( widen ).sub( 1 ) ) );

	} )() as V3;

}

// The tuft a vertex belongs to. The meadow's instance data lives in the cull's storage buffers,
// one slot per tuft (each batch from its own first slot, `grassBase`): the view camera's draws read
// the slot from the culled list it wrote, every other draw (the rain's collision bake, a draw with
// the cull switched off) takes each slot in turn, as an instanced draw of every tuft did.
const cullBase = uniform( 0, 'uint' ).onObjectUpdate( ( { object } ) => ( object as THREE.Mesh | undefined )?.geometry?.userData.grassBase ?? 0 );
const cullOn = uniform( 0, 'uint' ).onObjectUpdate( ( { object } ) => object?.userData.grassCulled === true ? 1 : 0 );

const TAU = Math.PI * 2;

// A hash of a blade (its id within the tuft, `restBlade`) and its tuft's anchor (`pick`), one per
// `k`: every choice a blade makes, fixed to the world as the anchors are.
function bladeHash( id: F, pick: F, k: number ): F {

	return fract( sin( id.mul( 91.7 + k * 17.3 ).add( pick.mul( 37.3 + k * 11.1 ) ) ).mul( 43758.5453 ) );

}

// A blade's own rest pose, before the tuft's transform: the shared tuft geometry's blade (attribute
// `blade`, tuftGeometry) taller or shorter, its width axis turned and the blade leaning toward its
// own side in an arc (the lean grows with the square of the way up, the height shrinking to keep
// the length), all by hashes of the blade and its anchor (HEIGHT_MAX, FACING, LEAN_*). So the lawn
// stays even as a whole while no two neighbouring blades stand alike, and a grown island draws each
// blade as a fresh load does. The wind bends this pose (`bendBlade`). Returns the local position,
// the half-width offset and the width axis (local x, z), the lean (local x, z, a share of the
// blade's height), the side of the blade's centreline the vertex lies on, the blade's id and the
// hash it is kept by where it is widened (`grassMaterial`'s opacity).
function restBlade( blade: THREE.Node<'vec4'>, pick: F ) {

	const t = blade.x;
	const side = sign( blade.w );
	const id = abs( blade.w ).sub( 1 );
	const tall = select( bladeHash( id, pick, 1 ).lessThan( TALL_SHARE ), float( TALL ), float( 1 ) );
	const height = bladeHash( id, pick, 0 ).mul( 0.5 ).add( 0.75 ).mul( tall ).div( 1 + TALL_SHARE * ( TALL - 1 ) );
	const turn = bladeHash( id, pick, 2 ).sub( 0.5 ).mul( FACING );
	const leanAngle = bladeHash( id, pick, 3 ).mul( TAU );
	const leanAmount = pow( bladeHash( id, pick, 4 ), LEAN_POWER ).mul( LEAN_MAX - LEAN_MIN ).add( LEAN_MIN );
	const half = blade.z.mul( side );
	const offset0 = vec2( cos( blade.y ), sin( blade.y ) ).mul( half );
	const axis = vec2( cos( blade.y.add( turn ) ), sin( blade.y.add( turn ) ) ).toVar();
	const offset = axis.mul( half );
	const lean = vec2( cos( leanAngle ), sin( leanAngle ) ).mul( leanAmount );
	const y = positionLocal.y.mul( height );
	const arc = leanAmount.mul( t );
	const centre = positionLocal.xz.sub( offset0 ).add( lean.mul( y.mul( t ) ) );
	const position = vec3( centre.x.add( offset.x ), y.mul( float( 1 ).sub( arc.mul( arc ).mul( 0.5 ) ) ), centre.y.add( offset.y ) );
	return { position, offset, axis, lean, side, id, hash: bladeHash( id, pick, 7 ) };

}

// What the larger casters throw onto the blades (`SunShadow.softVisibility`): its ring's radius
// (m), so a caster's shade ends in a soft edge a few decimetres wide; how deep it shades
// (a share of the direct light), lighter than on the ground, as light scatters through the blades;
// and how far above its root a vertex looks up, so the root does not take the ground it stands in.
const SHADE_RADIUS = 0.3, SHADE_DEPTH = 0.8, SHADE_LIFT = 0.08;
// The blades' colour and light (grassMaterial): the root's colour against the lawn's, the key light
// left at the root, the sky's at the root, light through the upper blades (a broad lobe toward the
// sun and a floor from any side, tinted against the albedo), the gloss along them (its colour and the sine's power) and their
// specular against a plain dielectric's (see `grassMaterial`).
const ROOT = new THREE.Vector3( 0.42, 0.7, 0.56 ), TIP = new THREE.Vector3( 1.2, 1.17, 0.88 );
// The blades' own tints (grassMaterial): the share at each end of the tint hash that turns yellow
// green or deep green, and the mean of all the shifts (the middle ones average 1), divided out.
const BLADE_TINT_SHARE = 0.15;
const BLADE_TINTS = ( () => {

	const yellow = new THREE.Vector3( 1.08, 1.02, 0.8 ), deep = new THREE.Vector3( 0.88, 0.96, 0.98 );
	const mean = yellow.clone().add( deep ).multiplyScalar( BLADE_TINT_SHARE ).addScalar( 1 - 2 * BLADE_TINT_SHARE );
	return { yellow, deep, mean };

} )();
const ROOT_KEY = 0.45, ROOT_SKY = 0.55;
const TRANSLUCENT_FLOOR = 0.6, TRANSLUCENT_FORWARD = 1, FORWARD_POWER = 3;
const TRANSLUCENT_TINT = new THREE.Vector3( 1.2, 1.2, 0.8 );
const SHEEN = new THREE.Vector3( 0.03, 0.0325, 0.0225 ), SHEEN_POWER = 2, SPECULAR = 0.35;
// The blade's fold (how far each half's normal turns toward its edge), how far its own lean tilts
// its normal, and the lift of its thin bright edge (on the outer share EDGE_FROM of each half).
const FOLD = 0.6, LEAN_NORMAL = 1.0, EDGE = 0.25, EDGE_FROM = 0.7;
// The ring's lookups besides the centre: each costs 0.05 - 0.08 ms a frame in the island views
// (every blade vertex takes them), and two keep the shade's cost near half the per-pixel filter's.
const SHADE_TAPS = 2;

// A far blade's strips (fragment stage): `side` runs from -1 to 1 across the blade, `strips` is
// how many blades it stands for. Returns the side within the fragment's strip and the strip's own
// value and tint hashes; a blade of one strip keeps its own, unchanged.
function bladeStrips( side: F, jitter: F, tint: F, strips: F ) {

	const across = side.mul( 0.5 ).add( 0.5 ).mul( strips ).toVar();
	const k = across.floor();
	const far = strips.greaterThan( 1 );
	return {
		side: select( far, fract( across ).mul( 2 ).sub( 1 ), side ),
		jitter: select( far, fract( sin( jitter.mul( 91.7 ).add( k.mul( 37.3 ) ) ).mul( 43758.5453 ) ), jitter ),
		tint: select( far, fract( sin( tint.mul( 73.1 ).add( k.mul( 19.7 ) ) ).mul( 43758.5453 ) ), tint ),
	};

}

// The flower heads (`headPose`, `headShape`), each its own (`HEADS`, by head number: the species
// in the order of `SPECIES`, then the white chrysanthemum). A head is a disc of HEAD_RADIUS times its
// `size` times 0.8 to 1.25 (a hash of its tuft). The sizes keep the species' order of size (violets
// the smallest, then the wild chrysanthemums, pinks and dandelions, balloon flowers, daylilies the
// largest) at about twice the small flowers' real size and less for the large ones: at half that
// the game's 22 m view showed the small heads as dots, not flowers, and the large ones need no help.
// It stands at its `height` of its tuft's height (local units): daylilies and balloon flowers over
// the grass, pinks and chrysanthemums about at the blades' tips, dandelions and violets low among
// them, many partly hidden (yellow and white heads standing clear of the lawn were the brightest
// things in the near view). It sits a few centimetres off its tuft's axis (HEAD_OFFSET), tilted from
// upright toward the tuft's own facing by HEAD_TILT (rad), as an open flower turns: from the game's
// low view a level disc showed as a sliver, one turned up to the sky as a round speck. A head is
// kept at least HEAD_MIN_PIXELS times the blades' least width across on screen (a smaller least
// size left the mid view's far meadow plain green), at most HEAD_MAX_WIDEN times its own size, its
// coverage falling by the square of the widening: as with the blades, the widened heads are drawn
// whole where their coverage is above their own hash, so the far meadow keeps as much colour as
// the near. As its tuft thins its blades with distance (its gain from 1 to NEAR_GAIN, 25 to 70 m) a
// head rises by up to HEAD_LIFT of its tuft's height: the widened far blades hid nearly every head
// at 70 m.
const HEAD_RADIUS = 0.064, HEAD_OFFSET = 0.1, HEAD_TILT = [ 0.35, 1.0 ];
const HEAD_MIN_PIXELS = 2, HEAD_MAX_WIDEN = 4, HEAD_LIFT = 0.35;
// Each head: its petals' colour and its inner colour (linear albedo, soft rather than vivid: the
// first heads' saturated colours read as confetti on the lawn, and yellow and white ones at their
// real albedo outshone it), the radii over which the inner colour gives way to the petals' (`inner`,
// from, to), its size and height range, and its outline (`headShape`): `lobe` scallops each sector
// round, `point` runs it to a point, `fringe` cuts teeth into its tip, `rays` makes it a ray round
// a disc of the inner colour (a daisy's form).
type Head = { petal: [ number, number, number ]; centre: [ number, number, number ]; inner: [ number, number ];
	size: number; height: [ number, number ]; lobe: number; point: number; fringe: number; rays: number };
const HEADS: Head[] = [
	// pinks: rose petals, fringed, round a dark eye
	{ petal: [ 0.5, 0.15, 0.24 ], centre: [ 0.24, 0.03, 0.07 ], inner: [ 0.22, 0.4 ], size: 0.95, height: [ 0.75, 1.1 ], lobe: 0.25, point: 0, fringe: 0.14, rays: 0 },
	// wild chrysanthemum: small yellow rays round a golden disc
	{ petal: [ 0.52, 0.36, 0.03 ], centre: [ 0.4, 0.24, 0.02 ], inner: [ 0.32, 0.34 ], size: 0.75, height: [ 0.7, 1.05 ], lobe: 0, point: 0, fringe: 0, rays: 1 },
	// daylily: an orange trumpet, its pointed tepals yellow in the throat
	{ petal: [ 0.52, 0.17, 0.02 ], centre: [ 0.52, 0.3, 0.03 ], inner: [ 0.08, 0.5 ], size: 1.5, height: [ 1.15, 1.45 ], lobe: 0.3, point: 0.25, fringe: 0, rays: 0 },
	// dandelion: a dense yellow head, deeper at its middle, its rim finely toothed
	{ petal: [ 0.54, 0.37, 0.02 ], centre: [ 0.4, 0.25, 0.012 ], inner: [ 0, 0.55 ], size: 1.0, height: [ 0.5, 0.9 ], lobe: 0.1, point: 0, fringe: 0.08, rays: 0 },
	// violet: small, deep violet, its throat pale
	{ petal: [ 0.2, 0.08, 0.38 ], centre: [ 0.4, 0.38, 0.44 ], inner: [ 0.08, 0.2 ], size: 0.6, height: [ 0.35, 0.7 ], lobe: 0.35, point: 0, fringe: 0, rays: 0 },
	// balloon flower: a blue-violet star, paler at its centre
	{ petal: [ 0.15, 0.13, 0.45 ], centre: [ 0.3, 0.3, 0.5 ], inner: [ 0.05, 0.3 ], size: 1.35, height: [ 1.1, 1.4 ], lobe: 0, point: 0.5, fringe: 0, rays: 0 },
	// white wild chrysanthemum
	{ petal: [ 0.5, 0.49, 0.45 ], centre: [ 0.4, 0.24, 0.02 ], inner: [ 0.32, 0.34 ], size: 0.75, height: [ 0.7, 1.05 ], lobe: 0, point: 0, fringe: 0, rays: 1 },
];

/** A value of each head (`values`, by head number) for the head number `h`. */
function perHead( values: number[], h: F ): F {

	let v: F = float( values[ 0 ] );
	for ( let i = 1; i < values.length; i ++ ) v = mix( v, float( values[ i ] ), step( i - 0.5, h ) );
	return v;

}

function perHead3( values: [ number, number, number ][], h: F ): V3 {

	let v: V3 = vec3( ...values[ 0 ] );
	for ( let i = 1; i < values.length; i ++ ) v = mix( v, vec3( ...values[ i ] ), step( i - 0.5, h ) );
	return v;

}

// A flowering tuft's head, in the vertex stage: its centre in the tuft's local space (placed by
// the tuft's transform as a blade's vertex is), the vertex's offset from it in world space (the
// disc's plane from the tuft's own axes `xAxis`, `zAxis`, tilted), its normal and its radius; all
// hashes of the tuft (`pick`) and its head number (`kind`), so a grown island draws each head as a
// fresh load does.
function headPose( blade: THREE.Node<'vec4'>, pick: F, kind: F, xAxis: V3, zAxis: V3, gain: F ) {

	const hash = ( k: number ) => bladeHash( float( 16 ), pick, k );
	const away = hash( 9 ).mul( HEAD_OFFSET ), turn = hash( 10 ).mul( TAU );
	const lift = clamp( gain.sub( 1 ).div( NEAR_GAIN - 1 ), 0, 1 ).mul( HEAD_LIFT );
	const low = perHead( HEADS.map( ( h ) => h.height[ 0 ] ), kind ), high = perHead( HEADS.map( ( h ) => h.height[ 1 ] ), kind );
	const centre = vec3( cos( turn ).mul( away ), hash( 8 ).mul( high.sub( low ) ).add( low ).add( lift ), sin( turn ).mul( away ) );
	const x = normalize( xAxis ), z = normalize( zAxis ), y = cross( z, x );
	const tilt = hash( 11 ).mul( HEAD_TILT[ 1 ] - HEAD_TILT[ 0 ] ).add( HEAD_TILT[ 0 ] );
	const across = z.mul( cos( tilt ) ).add( y.mul( sin( tilt ) ) );
	const radius = hash( 12 ).mul( 0.45 ).add( 0.8 ).mul( perHead( HEADS.map( ( h ) => h.size * HEAD_RADIUS ), kind ) );
	const offset = x.mul( cos( blade.y ) ).add( across.mul( sin( blade.y ) ) ).mul( blade.z.mul( radius ) );
	return { centre, offset, normal: y.mul( cos( tilt ) ).sub( z.mul( sin( tilt ) ) ), radius, hash: hash( 13 ) };

}

// How far a head at `centre` (world) widens to stay HEAD_MIN_PIXELS blade widths across, and the
// coverage that leaves it.
function headWiden( centre: V3, radius: F, minWidth: F ): { widen: F; coverage: F } {

	const depth = max( cameraViewMatrix.mul( vec4( centre, 1 ) ).z.negate(), 1e-3 );
	const p11 = ( cameraProjectionMatrix as unknown as { element( i: number ): { element( i: number ): F } } ).element( 1 ).element( 1 );
	const pixel = depth.mul( 2 ).div( p11.mul( screenSize.y ) );
	const widen = clamp( minWidth.mul( HEAD_MIN_PIXELS * 0.5 ).mul( pixel ).div( radius ), 1, HEAD_MAX_WIDEN ).toVar();
	return { widen, coverage: float( 1 ).div( widen.mul( widen ) ) };

}

// A head's petals and colour, in the fragment stage, from where the fragment lies on the disc
// (`radius`, 0 at the centre to 1 at the rim, and `across`, -1 to 1 across its sector) and the
// head's number (`kind`): each sector is a petal, its outline and colours the head's (`HEADS`).
// Returns the colour and whether the fragment is on a petal (0 or 1).
function headShape( across: F, radius: F, kind: F ): { colour: V3; mask: F } {

	// (blends of 0 / 1 weights rather than select(): see AGENTS.md, a select of built nodes)
	const h = kind.toVar();
	const get = ( key: 'lobe' | 'point' | 'fringe' | 'rays' ) => perHead( HEADS.map( ( head ) => head[ key ] ), h );
	const rays = get( 'rays' );
	const side = abs( across ).div( max( radius, 1e-3 ) );
	// a petal's outline: scalloped, pointed and toothed by the head's measures
	const teeth = fract( side.mul( 2.5 ).add( radius.mul( 3 ) ) );
	const outline = float( 1 ).sub( side.mul( side ).mul( get( 'lobe' ) ) ).sub( side.mul( get( 'point' ) ) ).sub( teeth.mul( get( 'fringe' ) ) );
	const ray = step( side, mix( float( 0.8 ), float( 0.25 ), radius.mul( radius ) ) );
	const inner0 = perHead( HEADS.map( ( head ) => head.inner[ 0 ] ), h ), inner1 = perHead( HEADS.map( ( head ) => head.inner[ 1 ] ), h );
	const disc = step( radius, inner1 ).mul( rays );
	const mask = mix( step( radius, outline ), max( ray, disc ), rays );
	const petal = perHead3( HEADS.map( ( head ) => head.petal ), h ), centre = perHead3( HEADS.map( ( head ) => head.centre ), h );
	return { colour: mix( centre, petal, smoothstepN( inner0, inner1, radius ) ), mask };

}

// A head's light, wrapped round the blades' light hook (the hook's own lines stay the blades'): its
// petals take light through them as the old wildflowers' did, untinted and a little from any side,
// in place of the blades' yellow translucency, and no gloss; the canopy's light is the blades' at
// the head's height (about their tips'). `head` is 1 on a head's fragments.
function withHeadLight( head: F, options: VegetationOptions ): VegetationOptions {

	const light = options.light;
	return { ...options, light: ( rest ) => {

		const blades = typeof light === 'function' ? light( rest ) : light;
		const extra = blades.extra!, sheen = blades.sheen!;
		return {
			scale: blades.scale,
			extra: ( L, V, N ) => mix( extra( L, V, N ) as V3, vec3( backlight( L, V, 3 ).mul( 0.6 ).add( 0.12 ) ), head ),
			sheen: ( L, V, N ) => sheen( L, V, N ).mul( float( 1 ).sub( head ) ),
		};

	} };

}

function grassMaterial( shared: Shared, cull: GrassCull, sunShadow: SunShadow ): THREE.MeshStandardNodeMaterial {

	// The blades' opacity is 0 or 1 (whole blades, below): the factory's 'blade' family draws a
	// fragment or drops it whole, by alpha to coverage or, without multisampling, by
	// `coverageDither`'s threshold (vegetation/Material.ts).
	const slot = instanceIndex.add( cullBase );
	const tuftSlot = select( cullOn.equal( 1 ), cull.node( 'visible', 'uint', true ).element( slot ), slot ).toVar( 'grassTuft' );
	const input = tuftInputs( cull, tuftSlot );
	// The tuft's instance data, read as the instanced attributes were: what the fragment stage
	// reads passes as a varying, as an attribute did.
	const ground0 = input.ground( 0 ), ground1 = input.ground( 1 ), ground2 = input.ground( 2 );
	const skyVisibility = varying( ground0.x, 'vGrassSkyVisibility' );
	const tuftOrigin = varying( input.origin, 'vGrassTuftOrigin' );
	const blade = attribute<'vec4'>( 'blade', 'vec4' );
	const t = blade.x;
	const t2 = t.mul( t );
	const tuft = tuftOrigin;
	const origin = tuft.xyz;
	const pick = rootHash( origin.xz );
	const pose = restBlade( blade, pick );
	// A flowering tuft's head (`flowerTuftGeometry`): its vertices take the head's pose, colour and
	// light in place of a blade's, through the same stages.
	// (1 on a head's vertex; every choice between the two is a blend by it, exact for the blades)
	const isHead = step( HEAD_FLAG - 0.5, abs( blade.w ) );
	const lod = tuftLod( origin );
	const head = headPose( blade, pick, ground0.y.sub( 1.5 ), ground1.xyz, ground2.xyz, lod.gain );
	// Whole blades instead of partial coverage (after tidewater's GrassField, Daniel Greenheck, MIT;
	// the technique only): a widened blade's fragment is drawn solid where the blade's coverage
	// there (`pixelWideBlade`) is at or above the blade's own hash and not at all below it. A blade
	// then ends where it narrows past its hash and the meadow covers as much on average as with
	// partial coverage, while no pixel of a blade takes a share of the samples: partial coverage
	// drew alpha to coverage's fixed sample patterns as a grid of dots along the narrow upper
	// blades, plainest on the lit tips. In a wind-still clip at the game camera's close end the
	// meadow flickers as much as with partial coverage (a little less in its high-pass part);
	// drawing the widened blades solid near the camera instead raised it by about a third and
	// brightened the lawn.
	// What the fragment stage reads of the blade, in one varying (the meadow's varyings are near
	// WebGPU's limit): its keep hash, the side of its centreline, and its value and tint hashes
	// (taken per vertex: the blade's id comes from its attribute's magnitude, whose sign flips
	// across the blade, so interpolated it is the id only at the edges).
	// A head's vertex passes instead its keep hash, its place across its petal and from the centre,
	// and 2 + its flower code, which tells it apart in the fragment stage (blade hashes are below 1).
	const bladeVarying = varying( mix(
		vec4( pose.hash, pose.side, bladeHash( pose.id, pick, 5 ), bladeHash( pose.id, pick, 6 ) ),
		vec4( head.hash, positionGeometry.x, blade.z, ground0.y.add( 1 ) ), isHead ), 'vGrassBlade' );
	// sway: gusts travel across the meadow, the tips move most. `p` is the vertex of the blade's
	// rest pose placed by the tuft's transform, i.e. in world space (the mesh itself stays
	// untransformed), computed as three's instancing did; held in a variable as three's was,
	// which keeps the rounding of every expression built on it.
	const placed = input.matrix.mul( vec4( mix( pose.position, head.centre, isHead ), 1 ) ).xyz.toVar( 'grassPlaced' );
	const minWidth = mix( grassUniforms.minWidth, grassUniforms.rimMinWidth, ground0.w );
	// a head's vertex: its centre placed, then its offset on the disc, widened about the centre
	const headSize = headWiden( placed, head.radius, minWidth );
	const p = placed.add( head.offset.mul( headSize.widen.mul( isHead ) ) );
	// Folding a thinned tuft into its root: a scale about the anchor, applied like the drowning.
	const thin = ground1.w;
	const kept = float( 1 ).sub( thin.mul( smoothstepN( grassUniforms.thinNear, grassUniforms.thinFar, length( cameraPosition.sub( origin ) ) ) ) );
	// Standing water drowns the blades: the tufts sink below the waterline (the ground, which
	// carries the water's surface, hides them). About a third keep a few centimetres of their
	// tips above it, so sparse drowned spikes stand in an open sheet of water rather than a
	// meadow that hides it. Which tufts and how much is a hash of the planting anchor, fixed.
	const pool = puddleCover( origin.xz, shared.wetness );
	const drowned = float( 1 ).sub( pool.mul( 0.15 ) ).mul( kept );
	const tip = select( pick.greaterThan( 0.66 ), pick.sub( 0.66 ).mul( 0.25 ).add( 0.03 ), float( - 0.03 ) );
	// The tallest blade of a tuft reaches about 0.9 of its height ( tuft.w / CANOPY_TOP ).
	const sink = max( tuft.w.div( CANOPY_TOP ).mul( drowned ).mul( 0.9 ).sub( tip ), 0 );
	const rooted = drown( p.sub( origin ).mul( drowned ).add( origin ), origin.xz, sink, shared.wetness, pool );
	const phase = bladePhase( pose.id, pick );
	// The blade's half width at this vertex in world space: its local offset from the centreline
	// through the instance's own axes, then the same drowning scale as `rooted` (an affine map of
	// the position, so it scales offsets alike; the bend barely varies across a blade).
	const across = ground1.xyz.mul( pose.offset.x ).add( ground2.xyz.mul( pose.offset.y ) ).mul( drowned ).mul( float( 1 ).sub( isHead ) );
	// a head is always kept whole, whatever its tuft keeps of its blades
	const keep = mix( lod.keep, 1, isHead ), gain = mix( lod.gain, 1, isHead );
	// The tuft's sway fades out as it shrinks to a few pixels on screen, its gusts' lean kept
	// (`swayFade`); one share for the whole tuft, its head with it, and the same for the previous
	// frame's bend below, so the motion vectors carry only the wind's change.
	const fade = swayFade( origin, tuft.w ).toVar( 'grassSwayFade' );
	const bend = bendBlade( shared.wind, rooted, origin, tuft.w, t2, phase, fade );
	// A blade of a tuft past 70 m stands for as many of the blades it drew there as its gain over
	// NEAR_GAIN (exactly 1 within 70 m) and is drawn as that many strips side by side, each with its
	// own fold, edge and tint (`bladeStrips`): one plain blade 16 times as wide read at the island
	// view as a cover of broad leaves, coarser than the blades a few pixels wide it stands for. The
	// count rides with the rim cover in one varying (the meadow's varyings are near WebGPU's limit).
	const rimVarying = varying( vec2( ground0.z, max( gain.div( NEAR_GAIN ), 1 ) ), 'vGrassRimCover' );
	// dark, shaded roots to the tuft's own colour at the tips (the instance colour multiplies in)
	const cover = rimVarying.x;
	const strip = bladeStrips( bladeVarying.y, bladeVarying.z, bladeVarying.w, rimVarying.y );
	// Each blade shifts its value by up to +/-10 % and its hue a hint toward yellow or blue green,
	// and about one in seven turns a clear yellow green and as many a deep green (BLADE_TINTS): a
	// hash of the blade and its tuft's anchor, so no two neighbouring blades match. Divided by the
	// shifts' mean, so the lawn's average colour stays; the blades are far finer than the lawn's
	// colour field, so they tell apart close up without mottling it.
	const jitter = strip.jitter, tint = strip.tint;
	const yellow = step( tint, BLADE_TINT_SHARE ), deep = step( 1 - BLADE_TINT_SHARE, tint );
	const hue = mix( vec3( 0.98, 1, 1.03 ), vec3( 1.02, 1, 0.97 ), tint ).mul( float( 1 ).sub( yellow ).sub( deep ) )
		.add( vec3( BLADE_TINTS.yellow ).mul( yellow ) ).add( vec3( BLADE_TINTS.deep ).mul( deep ) );
	const bladeShift = hue.mul( jitter.mul( 0.2 ).add( 0.9 ) ).div( vec3( BLADE_TINTS.mean ) );
	// A deeper, cooler green at the root to a light, fresh green at the tip (the instance colour
	// multiplies in), so the gaps between blades read as a deeper green, never near black (that
	// read as holes in a bright lawn), and the sward has depth without looking dirty. The light
	// through the tips (below) adds the yellow. At the rim's soil pockets the roots take the soil's
	// colour.
	const root = mix( vec3( ROOT ), vec3( 0.55, 0.38, 0.23 ), float( 1 ).sub( cover ).mul( 0.55 ).mul( soilUniforms.strength ) );
	// The blade's side and width axis, for the edge here and the fold below. The edge is a lighter
	// rim along the blade's margins, only seen where a blade is several pixels wide.
	const side = strip.side;
	const axisView = varying( cameraViewMatrix.mul( vec4( normalize( ground1.xyz.mul( pose.axis.x ).add( ground2.xyz.mul( pose.axis.y ) ) ), 0 ) ).xyz, 'vGrassAxis' );
	const edge = smoothstepN( EDGE_FROM, 1, abs( side ) ).mul( EDGE ).add( 1 );
	// A blade's depth in the canopy is its share of the way down its own tuft times the turf's one
	// canopy depth (MeadowCanopy.ts TURF_CANOPY_DEPTH), not its metres below the tuft's top: tall
	// and short tufts then shade alike, so the growth field does not show as drifts of darker
	// sward, and every root meets the turf's own shade.
	// The head's fragments: its petals' colour and shape (`headShape`), lit as a petal.
	const onHead = step( 1.5, bladeVarying.w );
	// (only a head's fragments work out its shape and colour: a blade's take zeros, which the blends
	// by `onHead` drop; worked out for every fragment, the six species' measures cost the whole meadow)
	const headLook = Fn( () => {

		const look = vec4( 0 ).toVar( 'grassHeadLook' );
		If( onHead.greaterThan( 0.5 ), () => {

			const shape = headShape( bladeVarying.y, bladeVarying.z, bladeVarying.w.sub( 2.5 ) );
			look.assign( vec4( shape.colour, shape.mask ) );

		} );
		return look;

	} )();
	const headFragment = { colour: headLook.xyz, mask: headLook.w };
	const bladeOnly = float( 1 ).sub( onHead );
	const canopyDepth = ( at: THREE.Node<'vec3'> ) => max( float( 1 ).sub( at.y.sub( origin.y ).div( tuft.w ) ), 0 ).mul( TURF_CANOPY_DEPTH );
	const mat = vegetationMaterial( shared, withHeadLight( onHead, {
		family: 'blade', roughness: 0.86,
		wet: { tint: 0.92, roughness: 0.76 },
		color: ( wet ) => mix( mix( root, vec3( TIP ), smoothstepN( 0.12, 1, t ) ).mul( bladeShift ).mul( edge ), headFragment.colour, onHead ).mul( wet ),
		rest: rooted,
		// Short growth needs a smaller world-space sway to keep its tips above the soil.
		// The widening and the narrowing by distance (`pixelWideBlade`, `tuftLod`) follow the current
		// camera: a previous frame's pose from the registered displacement keeps them as they are now.
		displacement: ( state ) => pixelWideBlade(
			state === shared.wind ? bend.position : bendBlade( state, rooted, origin, tuft.w, t2, phase, fade ).position, across, minWidth, keep, gain, isHead, headSize.coverage ),
		// Motion vectors (temporal modes): the blade bent by the previous frame's wind from the same
		// rooted point, widened by the offset the current pose took (the widening follows the camera,
		// whose motion Motion.ts adds): swayed - ( bent now - bent before ).
		previous: ( swayed ) => TEMPORAL ? swayed.sub( bend.position ).add( bendBlade( shared.wind.previous, rooted, origin, tuft.w, t2, phase, fade ).position ) : undefined,
		// The rest of three's instancing: the normal and the instance colour, before the blade moves.
		beforePosition: () => {

			// A bent blade's normal turns with it, so a gust shows as it sweeps by, as a sheen.
			// The blade's own lean tilts it too, so blades leaning apart take the light apart.
			const normal = transformNormal( normalLocal, input.matrix );
			const leanWorld = ground1.xyz.mul( pose.lean.x ).add( ground2.xyz.mul( pose.lean.y ) );
			normalLocal.assign( mix( normalize( normal.add( bend.lean.mul( t.mul( 1.5 ) ) ).add( leanWorld.mul( t.mul( LEAN_NORMAL ) ) ) ), normalize( head.normal.add( bend.lean.mul( 1.5 ) ) ), isHead ) );
			// (a head takes its own colour, not the lawn's)
			instanceColor.assign( mix( input.color, vec3( 1 ), isHead ) );

		},
		sway: () => bend.lean.xz,
		// The tuft's envelope, the same from both sides, folded: each half of a blade turns its normal
		// toward its own edge, so one half takes the light and the other turns from it (FOLD), as a
		// leaf folded along its midrib does.
		// A head is not folded.
		normal: normalize( normalViewGeometry.add( axisView.mul( clamp( side.mul( 4 ), - 1, 1 ).mul( FOLD ).mul( bladeOnly ) ) ) ),
		// The static visibility affects indirect illumination only; sunlight keeps its own shadows.
		// Both the sky's light (here) and the key light (`VegetationLighting` below) fall off toward
		// the root.
		ao: mix( float( ROOT_SKY ), float( 1 ), smoothstepN( 0.08, 0.85, t ) ).mul( skyVisibility ),
		// Light through the blades: strongest when the grass stands against the sun. Blades do not
		// cast into the sun's shadow map; see MeadowCanopy. Per vertex (lower tiers) it takes the
		// rest pose before the widening, as the shadows do; the mesh is untransformed, so `rooted`
		// is that pose in world space.
		light: ( rest ) => {

			const canopy = grassQuality.canopyPerVertex
				? varying( meadowCanopyLight( canopyDepth( rooted ), shared.sunDir ) )
				: meadowCanopyLight( canopyDepth( rest ), shared.sunDir );
			// Light through the upper blades, yellower than the light off them (it crosses the
			// leaf): over the whole half of the view that faces the sun, strongest looking into it
			// (`forwardLight`; the game camera looks down, so a narrow lobe round the sun never met
			// the lawn by day), and some from any side, so lit tips glow yellow-green over roots the
			// key reaches at ROOT_KEY, below the canopy's own shade. A soft gloss along the blades (`SHEEN`): a blade is a thin strip standing
			// along its envelope's normal, so it reflects as a fibre about that axis (Kajiya and
			// Kay's sine of the half vector), broad and faint, brightest on the tips toward a low
			// sun; at half its first strength, as with the specular it paled the lawn toward a coated
			// look. Both follow the key light alone, so by night they stay as faint as the moon.
			return {
				scale: () => mix( float( ROOT_KEY ), float( 1 ), t ).mul( canopy ),
				extra: ( L, V ) => forwardLight( L, V, FORWARD_POWER ).mul( TRANSLUCENT_FORWARD ).add( TRANSLUCENT_FLOOR ).mul( t2 ).mul( vec3( TRANSLUCENT_TINT ) ),
				sheen: ( L, V, N ) => {

					const along = dot( N, normalize( L.add( V ) ) );
					const facing = clamp( dot( N, L ).add( 0.35 ), 0, 1 );
					return vec3( SHEEN ).mul( pow( clamp( float( 1 ).sub( along.mul( along ) ), 0, 1 ), SHEEN_POWER ).mul( facing ).mul( t2 ) );

				},
			};

		},
	} ) );
	mat.opacityNode = step( bladeVarying.x, bladeCoverage ).mul( mix( float( 1 ), headFragment.mask, onHead ) );
	// A blade's specular at SPECULAR of a plain dielectric's (F0 0.04, F90 1): seen edge on, as the
	// game camera sees upright blades, the full Fresnel term laid a pale sky reflection over the
	// whole meadow, a grey veil that read as plastic and took a quarter of its saturation.
	( mat as unknown as { setupSpecular: () => void } ).setupSpecular = () => {

		specularColor.assign( vec3( 0.04 * SPECULAR ) );
		specularColorBlended.assign( vec3( 0.04 * SPECULAR ) );
		specularF90.assign( SPECULAR );

	};
	// The larger casters' shade on the blades, soft and light (SHADE_*), at the rest pose like
	// every vegetation shadow (VegetationShadow.ts), per vertex: the sun's filter takes it in place
	// of its own (SunShadow `install`).
	const shade = sunShadow.softVisibility( rooted.add( vec3( 0, SHADE_LIFT, 0 ) ), SHADE_RADIUS, SHADE_TAPS );
	mat.userData.sunVisibility = varying( mix( float( 1 ), shade, SHADE_DEPTH ), 'vGrassSunVisibility' );
	mat.userData.wind = shared.wind.direction;
	return mat;

}

export interface Tuft { m: THREE.Matrix4; col: THREE.Color; visibility: number; cover: number; rimEdge: number; thin: number; top: number; origin: THREE.Vector3; flower: number }

type GrassCull = VegetationCull<Tuft>;

// The cull's bounds of a tuft (`tuftSphere`). Its widened blades reach out by at most WIDEN_REACH
// times their half width (`MAX_WIDEN` times the blade gain at 70 m, NEAR_GAIN: a tuft there keeps
// a quarter of its blades, less the blade itself), see `pixelWideBlade` and `tuftLod`; a tuft
// farther out keeps fewer and widens them further, and the cull adds that reach in its kernel
// (`cullLod.pad`, 0 up to NEAR_GAIN, so the near tufts' test is the one before). SWAY_PAD is slack
// (m) for rounding: 0.2, wider than the rounding needs, since a tighter sphere changes the visible
// list and with it a few isolated meadow pixels behind the prepass (VegetationCull's rules); a
// smaller pad is a performance step of its own. The wind's bend (Deform.ts `bendBlade`) keeps
// every vertex at its distance from the tuft's origin, so it stays inside the sphere when that is
// padded by twice the origin's distance from the sphere's centre, whatever the wind. The thin
// tufts are culled FOLD_PAD past their fold, so the test never takes a tuft the vertex stage would
// still draw a sliver of.
const NEAR_GAIN = 4;
const WIDEN_REACH = MAX_WIDEN * NEAR_GAIN - 1;
// The most a blade's root half width can be in world space, for the far pad: the widest blade's
// (`tuftGeometry`'s halfWidth) at the widest tuft's scale (PLANT_SPREAD, 1.1 at most).
const PAD_HALF_WIDTH = ( LAWN.w[ 1 ] * 0.5 + 0.004 ) * PLANT_SPREAD * 1.1;
const SWAY_PAD = 0.2;
const FOLD_PAD = 0.01;

const _corner = new THREE.Vector3(), _world = new THREE.Box3(), _sphere = new THREE.Sphere();

// A tuft's sphere: the box of its blades' rest poses (its geometry's `restBox`) in world space,
// extended down by its own height (standing water sinks the blades below their anchor), then
// padded for the widening and the sway.
function tuftSphere( t: Tuft, geometry: THREE.BufferGeometry, spheres: Float32Array, i: number ): void {

	const box = geometry.userData.restBox as THREE.Box3, e = t.m.elements;
	_world.makeEmpty();
	for ( let c = 0; c < 8; c ++ ) {

		_corner.set( c & 1 ? box.max.x : box.min.x, c & 2 ? box.max.y : box.min.y, c & 4 ? box.max.z : box.min.z ).applyMatrix4( t.m );
		_world.expandByPoint( _corner );

	}
	_world.min.y -= _world.max.y - _world.min.y;
	_world.getBoundingSphere( _sphere );
	const axisScale = Math.max( Math.hypot( e[ 0 ], e[ 1 ], e[ 2 ] ), Math.hypot( e[ 8 ], e[ 9 ], e[ 10 ] ) );
	_sphere.center.toArray( spheres, i * 4 );
	// Every vertex lies in the box, so within the box's radius plus the origin's offset from its
	// centre of the origin; a vertex turned about the origin stays that close to it, so within the
	// radius plus twice the offset of the centre.
	const bend = 2 * _sphere.center.distanceTo( t.origin );
	spheres[ i * 4 + 3 ] = _sphere.radius + bend + WIDEN_REACH * ( geometry.userData.halfWidth as number ) * axisScale + SWAY_PAD;

}

// The tufts' data in the cull's storage buffers, a slot each: the instance transform, the colour,
// the ground inputs (three vec4s) and the planting anchor with the tuft's height.
const GRASS_PAYLOAD: CullPayload<Tuft> = {
	buffers: [ { name: 'matrices', floats: 16, itemSize: 16 }, { name: 'colors', floats: 4, itemSize: 4 }, { name: 'ground', floats: 12, itemSize: 4 }, { name: 'origins', floats: 4, itemSize: 4 } ],
	origin: 'origins',
	matrices: 'matrices',
	write( t, i, { matrices, colors, ground, origins } ) {

		t.m.toArray( matrices, i * 16 );
		colors[ i * 4 ] = t.col.r; colors[ i * 4 + 1 ] = t.col.g; colors[ i * 4 + 2 ] = t.col.b;
		const e = t.m.elements;
		// x: sky visibility, y: the flower code of a flowering tuft (1.5 + its head, `FLOWER_SPECIES`, else 0), z: rim cover, w: rim edge (1 on the plateau's outer rim,
		// where blades stand against the sea and stay narrower: the opaque pass's MSAA edge pixels
		// there resolve against the sky-coloured clear, so every partly covered pixel a widened
		// blade adds shows as a pale fringe over the sea); then the instance's local x axis with the
		// thin flag (1 for the extra tufts that fold away with distance), and its local z axis. A
		// blade's width lies in the plane of those axes: the vertex stage keeps thin blades a
		// minimum width on screen in world space.
		ground.set( [ t.visibility, t.flower, t.cover, t.rimEdge, e[ 0 ], e[ 1 ], e[ 2 ], t.thin, e[ 8 ], e[ 9 ], e[ 10 ], 0 ], i * 12 );
		t.origin.toArray( origins, i * 4 );
		origins[ i * 4 + 3 ] = t.top;

	},
	sphere: tuftSphere,
	// the thin extra tufts have folded into their roots beyond thinFar
	fold: {
		far: grassUniforms.thinFar,
		folded: ( slot, origin, camera, node ) => node( 'ground' ).element( slot.mul( 3 ).add( 1 ) ).w.greaterThan( 0.5 ).and( length( camera.sub( origin ) ).greaterThanEqual( grassUniforms.thinFar.add( FOLD_PAD ) ) ),
	},
};

/** The vertex stage's view of the culled buffers: `index` is the drawn tuft's slot. */
function tuftInputs( cull: GrassCull, index: THREE.Node<'uint'> ) {

	const ground = cull.node( 'ground', 'vec4', true );
	return {
		matrix: cull.node( 'matrices', 'mat4', true ).element( index ),
		color: cull.node( 'colors', 'vec4', true ).element( index ).xyz,
		ground: ( k: number ) => ground.element( index.mul( 3 ).add( k ) ),
		origin: cull.node( 'origins', 'vec4', true ).element( index ),
	};

}

// One instanced mesh per batch of tufts of one kind, over its own geometry (the draw range and the
// indirect arguments belong to it) that shares the tuft's vertex buffers. Its instance data (the
// transform, colour, ground inputs and anchor) live in the cull's storage buffers from the
// batch's first slot on, read by the material through the drawn tuft's slot; `instanceMatrix`
// and `instanceColor` point at those buffers for code that looks for them, and since neither is an
// instanced attribute three leaves the instancing to the material.
function tuftMesh( source: THREE.BufferGeometry, shape: TuftShape, floor: number, material: THREE.Material, cull: GrassCull, range: CullRange, name: string ): THREE.InstancedMesh {

	const geometry = new THREE.BufferGeometry();
	for ( const key of [ 'position', 'normal', 'blade' ] ) geometry.setAttribute( key, source.getAttribute( key ) );
	geometry.setIndex( source.getIndex() );
	geometry.userData.grassBase = range.start;
	geometry.userData.grassBlades = shape.blades;
	geometry.userData.grassFloor = floor;
	geometry.userData.grassBladeVerts = ( shape.segs + 1 ) * 2;
	const mesh = new THREE.InstancedMesh( geometry, material, Math.max( range.count, 1 ) );
	mesh.instanceMatrix.array = new Float32Array( 16 ); // replaced below; drop the copy InstancedMesh allocates
	( mesh as unknown as { instanceMatrix: THREE.BufferAttribute } ).instanceMatrix = cull.buffer( 'matrices' );
	( mesh as unknown as { instanceColor: THREE.BufferAttribute } ).instanceColor = cull.buffer( 'colors' );
	mesh.count = range.count;
	// its whole count (it picks its count per view draw): the rain's collision bake draws them all
	mesh.userData.bakeCount = range.count;
	mesh.frustumCulled = false;
	mesh.castShadow = false; // see MeadowCanopy
	mesh.receiveShadow = true;
	mesh.name = name;
	mesh.renderOrder = - 1; // before the terrain: the turf it covers then fails the depth test
	return mesh;

}

// Every draw of the meadow chooses what it needs as it is rendered, from the view camera's
// distance to the box of the batch's planting anchors. It is a function of the camera's
// position alone, never of the path it came by, so a paused frame repeats exactly:
// - the thin extra tufts are skipped once the camera is beyond `thinFar` of every one of them,
//   where all of them have folded into their roots (the fold is the shader's, unchanged);
// - each tuft keeps its blades by its own distance in the vertex stage (`tuftLod`); the batch's
//   draw range ends after the blades its nearest possible tuft keeps (the box's nearest point,
//   at the least staggered distance), so blades no tuft keeps are not even run through the vertex
//   stage. Culled, that range is the first band's index count, and the cull draws every other
//   band with its own cap's blades (`bandCaps`), so a far tuft runs only the blades it keeps (and
//   at most a band's step more).
// A batch is one per kind, holding every chunk's tufts in the chunks' order (the cull's pool),
// not one per chunk: that would add render objects per meadow chunk. Its bands are draws of the
// one render object (the geometry's indirect offsets), and so are its depth copy's.
// Other cameras (the rain's collision bake looks straight down, orthographic) see every tuft
// with all its blades, as before.
// The view camera's draws are then culled per tuft on the GPU (`VegetationCull`): one compute pass
// for all batches, before the first of them draws, and only when the view or the selection
// changed; each batch draws its surviving tufts through indirect arguments, set on its geometry
// for that draw alone, so any other mesh over the same geometry (the collision bake's proxies)
// draws every tuft.
const _cameraPosition = new THREE.Vector3();

// (`base`: the indices drawn before the blades, a flowering tuft's head)
interface Batch { mesh: THREE.InstancedMesh; box: THREE.Box3; shape: TuftShape; floor: number; thin: boolean; count: number; range: CullRange; base: number }

function selectBatch( batch: Batch, camera: THREE.Camera ): void {

	const { mesh, shape } = batch;
	const full = batch.base + shape.blades * shape.segs * 6;
	if ( ! ( camera as THREE.PerspectiveCamera ).isPerspectiveCamera ) {

		mesh.count = batch.count;
		mesh.geometry.drawRange.count = full;
		mesh.userData.grassLod = false;
		return;

	}

	const d = batch.box.distanceToPoint( _cameraPosition.setFromMatrixPosition( camera.matrixWorld ) );
	mesh.count = batch.thin && debugFlags.grassThinCull !== false && d >= grassUniforms.thinFar.value ? 0 : batch.count;
	const lod = debugFlags.grassLod !== false;
	// (the shader's count rounds a little differently: a blade it keeps a sliver of past the range
	// is a hair's width, and the full range at the first band is exact)
	const blades = lod ? Math.min( shape.blades, Math.ceil( shape.blades * bladeShare( d * ( 1 - LOD_STAGGER ), batch.floor ) - 1e-6 ) ) : shape.blades;
	mesh.geometry.drawRange.count = batch.base + blades * shape.segs * 6;
	mesh.userData.grassLod = lod;

}

function drawBatch( batches: Batch[], cull: GrassCull, batch: Batch, renderer: THREE.Renderer, camera: THREE.Camera ): void {

	// Off (`flags.grassCull = false`): every tuft, as an instanced draw of all of them.
	const culled = ( camera as THREE.PerspectiveCamera ).isPerspectiveCamera && debugFlags.grassCull !== false;
	if ( ! culled ) {

		selectBatch( batch, camera );
		batch.mesh.userData.grassCulled = false;
		return;

	}
	// The first batch drawn for this view selects every batch and culls them all at once.
	if ( batch === batches.find( ( b ) => b.range.count > 0 ) ) {

		for ( const b of batches ) {

			selectBatch( b, camera );
			b.range.indexCount.value = b.mesh.geometry.drawRange.count;

		}
		cullLod.on.value = debugFlags.grassLod !== false ? 1 : 0;
		cullLod.bands.value = debugFlags.grassBands !== false ? 1 : 0;
		cull.update( renderer, camera );

	} else selectBatch( batch, camera );
	batch.mesh.userData.grassCulled = true;
	// a draw per band (three issues one for each offset)
	( batch.mesh.geometry as unknown as { setIndirect( a: THREE.IndirectStorageBufferAttribute, offsets: number[] ): void } ).setIndirect( cull.indirect, batch.range.indirectOffsets );

}

function batchOf( source: THREE.BufferGeometry, shape: TuftShape, floor: number, material: THREE.Material, cull: GrassCull, range: CullRange, tufts: Tuft[], name: string, thin = false ): Batch {

	const mesh = tuftMesh( source, shape, floor, material, cull, range, name );
	const box = new THREE.Box3();
	for ( const t of tufts ) box.expandByPoint( t.origin );
	return { mesh, box, shape, floor, thin, count: tufts.length, range, base: source.userData.baseIndices ?? 0 };

}

/** The meadow's tufts of each kind, one record per instance: the lawn, its thin extra tufts and
 * its flowering tufts. */
export interface GrassTufts { lawn: Tuft[]; lawnThin: Tuft[]; lawnFlower: Tuft[] }

/** The tufts grown on the anchors `veg` (any of them: each anchor's tufts depend on that anchor
 * alone); `walkDistance` (m from a point to the islander's loop) keeps the flowers off the path. */
export function plantGrass( veg: Float32Array, rimGround?: RimGroundField, walkDistance?: ( x: number, z: number ) => number ): GrassTufts {

	const n = veg.length / STRIDE;
	const lawn: Tuft[] = [], lawnThin: Tuft[] = [], lawnFlower: Tuft[] = [];
	const patches = new FlowerPatches();
	const draws = new Float32Array( 8 );
	const q = new THREE.Quaternion(), qy = new THREE.Quaternion();
	const up = new THREE.Vector3( 0, 1, 0 ), dir = new THREE.Vector3(), pos = new THREE.Vector3(), scl = new THREE.Vector3();
	const out = new THREE.Vector3();
	const col = new THREE.Color();
	const plant = ( list: Tuft[], at: THREE.Vector3, rotation: THREE.Quaternion, scale: THREE.Vector3, color: THREE.Color,
		k: number, cover: number, rimEdge: number, thin: number, flower = 0 ) => list.push( {
		m: new THREE.Matrix4().compose( at, rotation, scale ), col: color.clone(), visibility: veg[ k + 8 ], cover, rimEdge, thin,
		top: scale.y * CANOPY_TOP, origin: at.clone(), flower,
	} );

	for ( let i = 0; i < n; i ++ ) {

		const k = i * STRIDE;
		const x = veg[ k ], y = veg[ k + 1 ], z = veg[ k + 2 ];
		const rim = veg[ k + 6 ];
		// Two streams of the anchor's own cell, the lawn's and one for everything added since (a
		// fixed count of draws), so no anchor's planting depends on another's.
		const rng = anchorStream( x, z, 99 ), more = anchorStream( x, z, 131 );
		// stand with the ground, leaning out a little more over the rim
		dir.set( veg[ k + 3 ], veg[ k + 4 ], veg[ k + 5 ] ).lerp( up, 0.3 ).normalize();
		q.setFromUnitVectors( up, dir );
		qy.setFromAxisAngle( up, rng() * Math.PI * 2 );
		q.multiply( qy );

		// One height for the whole lawn, within a few per cent (the blades' own spread adds a
		// little more), lower on the rock stacks' thin soil.
		const onStack = veg[ k + 7 ] > 0;
		const h = SWARD_HEIGHT * ( 0.96 + rng() * 0.08 ) * ( onStack ? 0.55 : 1 );
		pos.set( x, y - 0.018, z );
		scl.set( PLANT_SPREAD * ( 0.9 + rng() * 0.2 ), h, PLANT_SPREAD * ( 0.9 + rng() * 0.2 ) );

		// The lawn's one colour, as the turf under it shows it (Meadow.ts).
		meadowColor( x, z, col );
		for ( let d = 0; d < draws.length; d ++ ) draws[ d ] = more();
		if ( ! supportsMeadow( y, veg[ k + 4 ] ) ) continue;
		const rimEdge = smoothstep( - 1.5, - 0.3, rim );

		// The meadow spills to the lip. Toward the coast the tufts grow taller and lean out over
		// it, along the coast field's gradient (any coast line, wherever the footprint puts it),
		// so they drape the root soil instead of stopping short of it. Where that field exposes a
		// soil pocket the tufts narrow only a little: the pocket shows between leaning blades.
		let cover = 1, spill = 0;
		if ( rimGround ) {

			const g = sampleRimGround( rimGround, x, z );
			cover = rimGrassCover( g );
			spill = smoothstep( - 0.95, - 0.1, g.distance );
			const e = 0.2;
			out.set( sampleRimGround( rimGround, x + e, z ).distance - sampleRimGround( rimGround, x - e, z ).distance, 0,
				sampleRimGround( rimGround, x, z + e ).distance - sampleRimGround( rimGround, x, z - e ).distance );

		} else {

			spill = smoothstep( - 1.1, - 0.2, rim );
			out.set( veg[ k + 3 ], 0, veg[ k + 5 ] );

		}
		if ( out.lengthSq() > 1e-8 ) out.normalize();
		if ( spill > 0 && ! onStack ) {

			dir.addScaledVector( out, spill * ( 0.3 + 0.45 * draws[ 0 ] ) ).normalize();
			q.setFromUnitVectors( up, dir ).multiply( qy );
			scl.y *= 1 + spill * ( 0.3 + 0.5 * draws[ 1 ] );

		}
		scl.x *= 0.65 + 0.35 * cover;
		scl.z *= 0.65 + 0.35 * cover;
		scl.y *= 0.8 + 0.2 * cover;
		// Whether the tuft flowers, and which head, from a stream of its own (the lawn's draws stay
		// as they were): by the patch strongest at it, or now and then alone between the patches.
		const bloom = anchorStream( x, z, 211 );
		const b0 = bloom(), b1 = bloom(), b2 = bloom();
		let flower = 0;
		if ( ! onStack && ( ! walkDistance || walkDistance( x, z ) >= FLOWER_CLEAR ) ) {

			const patch = patches.strongest( x, z, rim );
			const head = patch.share > 0 ? ( b0 < patch.share ? patch.head : - 1 ) : b0 < STRAY ? patches.stray( x, z, rim, b1, b2 ) : - 1;
			if ( head >= 0 ) flower = 1.5 + head;

		}
		plant( flower > 0 ? lawnFlower : lawn, pos, q, scl, col, k, cover, rimEdge, 0, flower );

		// About a quarter of the anchors take a second lawn tuft beside the first, picked by the
		// anchor's own hash (no field: a field made patches of denser sward). Clear of the rim,
		// where an offset root could leave the turf.
		if ( draws[ 2 ] < THIN_SHARE * ( 1 - smoothstep( - 0.7, - 0.35, rim ) ) && ! onStack ) {

			pos.set( x + ( draws[ 3 ] - 0.5 ) * 0.3, y - 0.018, z + ( draws[ 4 ] - 0.5 ) * 0.3 );
			dir.set( veg[ k + 3 ], veg[ k + 4 ], veg[ k + 5 ] ).lerp( up, 0.3 ).normalize();
			q.setFromUnitVectors( up, dir ).multiply( qy.setFromAxisAngle( up, draws[ 5 ] * Math.PI * 2 ) );
			scl.set( PLANT_SPREAD * ( 0.9 + draws[ 6 ] * 0.2 ), h * ( 0.96 + draws[ 7 ] * 0.08 ), PLANT_SPREAD * ( 0.9 + draws[ 6 ] * 0.2 ) );
			if ( grassQuality.thinTufts ) plant( lawnThin, pos, q, scl, col, k, cover, rimEdge, 1 );

		}

	}
	return { lawn, lawnThin, lawnFlower };

}

/** The meadow: its lawn meshes in one group, drawing the tufts `plantGrass` grew; `sunShadow`
 * gives the blades the larger casters' soft shade. */
export function buildGrass( { lawn, lawnThin, lawnFlower }: GrassTufts, shared: Shared, sunShadow: SunShadow ): THREE.Group {

	// (the tier's least blade width applies under the temporal modes only: 4x and one sample keep
	// theirs, see `grassUniforms`)
	if ( TEMPORAL ) grassUniforms.minWidth.value = grassQuality.minWidth;
	lodUniforms.bands.value.fromArray( grassQuality.bladeBands );
	lodUniforms.shares.value.fromArray( grassQuality.lawnBlades ).divideScalar( LAWN.blades );
	const group = new THREE.Group();
	group.name = 'grass';
	const lawnGeometry = tuftGeometry( LAWN, 3 );
	// The extra tufts of thick patches draw on their own, so they can be skipped as a whole.
	// The least share a visible tuft keeps: two blades far away (LEAST_BLADES), or a thin tuft's at its
	// fold (the cull drops it past thinFar).
	const minShare = LEAST_BLADES / LAWN.blades;
	const thinShare = bladeShare( grassUniforms.thinFar.value + 0.01, 0 );
	const kinds: { geometry: THREE.BufferGeometry; shape: TuftShape; floor: number; tufts: Tuft[]; name: string; key: keyof GrassTufts; thin: boolean; minShare: number }[] = [
		{ geometry: lawnGeometry, shape: LAWN, floor: 0, tufts: lawn, name: 'grass-lawn', key: 'lawn', thin: false, minShare },
	];
	// (the thin batch exists whenever the tier grows thin tufts, even with none yet, and the
	// flowering batch always: a grown island's meadow then fills the same batches, and the cull's
	// kernels stay the same)
	if ( grassQuality.thinTufts ) kinds.push( { geometry: lawnGeometry, shape: LAWN, floor: 0, tufts: lawnThin, name: 'grass-lawn-thin', key: 'lawnThin', thin: true, minShare: thinShare } );
	// The flowering tufts draw on their own, over the lawn's blades and a head, so the tufts without
	// a flower run no head vertices.
	kinds.push( { geometry: flowerTuftGeometry( lawnGeometry ), shape: LAWN, floor: 0, tufts: lawnFlower, name: 'grass-lawn-flower', key: 'lawnFlower', thin: false, minShare } );
	const cull: GrassCull = new VegetationCull( { name: 'Grass', payload: GRASS_PAYLOAD, lod: cullLod }, kinds.map( ( k ) => ( {
		records: k.tufts, geometry: k.geometry, blades: k.shape.blades, floor: k.floor,
		caps: bandCaps( k.shape.blades, k.floor, k.minShare ), bladeIndices: k.shape.segs * 6, baseIndices: k.geometry.userData.baseIndices ?? 0,
	} ) ) );
	const material = grassMaterial( shared, cull, sunShadow );
	const batches = kinds.map( ( k, i ) => batchOf( k.geometry, k.shape, k.floor, material, cull, cull.ranges[ i ], k.tufts, k.name, k.thin ) );
	for ( const b of batches ) {

		b.mesh.onBeforeRender = ( renderer, _scene, camera ) => drawBatch( batches, cull, b, renderer as unknown as THREE.Renderer, camera );
		// the indirect arguments belong to this draw alone
		b.mesh.onAfterRender = () => {

			b.mesh.geometry.indirect = null;

		};
		group.add( b.mesh );

	}
	// for probes and tuning from the console ( __PONLAI__.grass )
	group.userData.minWidth = grassUniforms.minWidth;
	group.userData.rimMinWidth = grassUniforms.rimMinWidth;
	group.userData.thinNear = grassUniforms.thinNear;
	group.userData.thinFar = grassUniforms.thinFar;
	group.userData.batches = batches;
	group.userData.cull = cull;
	group.userData.kinds = kinds.map( ( k ) => ( { geometry: k.geometry, key: k.key } ) );
	// the flowering tufts' anchors on the land shown, [ x, y, z ] each (the parity views find the
	// flowers by them: tools/parity/views.mjs)
	group.userData.flowerHeads = () => {

		const range = cull.ranges[ kinds.findIndex( ( k ) => k.key === 'lawnFlower' ) ], origins = cull.buffer( 'origins' ).array as Float32Array;
		return Array.from( { length: range.count }, ( _, i ) => Array.from( origins.subarray( ( range.start + i ) * 4, ( range.start + i ) * 4 + 3 ) ) );

	};
	return group;

}

/** A meadow grown on another land, ready for `setGrass`: the pool of its tufts in the meadow's
 * batches, the buffers made for it (to be uploaded before the swap), and each batch's planting box
 * and count. */
export interface GrassPrepared { pool: CullPool; buffers: CullBuffers; boxes: THREE.Box3[]; counts: number[] }

/** The pool of `tufts` for the meadow `group` (buildGrass), in steps (VegetationCull's `poolSteps`): the
 * growth (Growth.ts) takes them in idle time. */
function* grassSteps( group: THREE.Group, tufts: GrassTufts, per = 4000 ): Generator<void, GrassPrepared> {

	const kinds = group.userData.kinds as { geometry: THREE.BufferGeometry; key: keyof GrassTufts }[];
	const inputs: CullBatchInput<Tuft>[] = kinds.map( ( k ) => ( { records: tufts[ k.key ], geometry: k.geometry } ) );
	const pool = yield* poolSteps( GRASS_PAYLOAD, inputs, per );
	const boxes: THREE.Box3[] = [];
	for ( const b of inputs ) {

		const box = new THREE.Box3();
		for ( let k = 0; k < b.records.length; k ++ ) {

			box.expandByPoint( b.records[ k ].origin );
			if ( k % ( per * 4 ) === per * 4 - 1 ) yield;

		}
		boxes.push( box );
		yield;

	}
	return { pool, buffers: poolBuffers( GRASS_PAYLOAD, pool ), boxes, counts: inputs.map( ( b ) => b.records.length ) };

}

/** Swaps the meadow `group` to a prepared one in place: the same meshes, materials and kernels over
 * the new pool's buffers. Returns the buffers it replaced (dispose of them once drawn no more). */
function setGrass( group: THREE.Group, prepared: GrassPrepared ): CullBuffers {

	const cull = group.userData.cull as GrassCull, batches = group.userData.batches as Batch[];
	const old = cull.setPool( prepared.pool, prepared.buffers );
	batches.forEach( ( b, k ) => {

		b.box.copy( prepared.boxes[ k ] );
		b.count = prepared.counts[ k ];
		b.mesh.count = b.count;
		b.mesh.userData.bakeCount = b.count;
		b.mesh.geometry.userData.grassBase = b.range.start;
		( b.mesh as unknown as { instanceMatrix: THREE.BufferAttribute } ).instanceMatrix = cull.buffer( 'matrices' );
		( b.mesh as unknown as { instanceColor: THREE.BufferAttribute } ).instanceColor = cull.buffer( 'colors' );
		for ( const child of b.mesh.children ) if ( ( child as THREE.InstancedMesh ).isInstancedMesh ) ( child as unknown as { instanceMatrix: THREE.BufferAttribute } ).instanceMatrix = cull.buffer( 'matrices' );

	} );
	return old;

}

// The meadow as a vegetation kind (vegetation/Registry.ts): a grown island's meadow is planted a
// slice of anchors at a step and its cull pool filled and uploaded ahead; the swap points the
// pool's storage nodes at the new buffers (`setGrass`, no pipeline), and the old buffers leave the
// renderer's attributes once nothing draws them. It stays out of the sun's caster box, as it
// always has.
export function grassKind( group: THREE.Group, renderer: THREE.WebGPURenderer ): VegetationKind<GrassPrepared> {

	return {
		name: 'grass', root: group, prepass: true, shadowFilter: 'vegetation', sunCaster: false, rainBake: true,
		growth: {
			*prepare( input ) {

				const veg = input.data.vegetation, anchors = veg.length / STRIDE;
				const tufts: GrassTufts = { lawn: [], lawnThin: [], lawnFlower: [] };
				for ( let a = 0; a < anchors; a += 16 ) {

					const part = plantGrass( veg.subarray( a * STRIDE, Math.min( anchors, a + 16 ) * STRIDE ), input.data.rimGround, ( x, z ) => input.walkDistance( x, z ) );
					tufts.lawn.push( ...part.lawn );
					tufts.lawnThin.push( ...part.lawnThin );
					tufts.lawnFlower.push( ...part.lawnFlower );
					yield;

				}
				const grass = yield* grassSteps( group, tufts, 256 );
				yield;
				for ( const buffer of Object.values( grass.buffers ) ) yield* uploadSteps( input.renderer, buffer, AttributeType.STORAGE );
				return grass;

			},
			swap( prepared ) {

				const old = setGrass( group, prepared );
				return () => {

					const attributes = ( renderer as unknown as { _attributes?: { delete( attribute: unknown ): void } } )._attributes;
					for ( const buffer of Object.values( old ) ) attributes?.delete( buffer );

				};

			},
		},
	};

}
