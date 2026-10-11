import * as THREE from 'three/webgpu';
import {
	Fn, attribute, positionLocal, normalViewGeometry, vec2, vec3, vec4, float, mix, max, dot, pow, clamp, fract, sin, select, normalize,
	length, cameraPosition, cameraViewMatrix, cameraProjectionMatrix, screenSize, screenCoordinate, ivec2, varying, varyingProperty, uniform,
	smoothstep as smoothstepN, storage, instanceIndex, normalLocal, transformNormal, instanceColor, int,
} from 'three/tsl';
import { sampleRimGround, rimGrassCover } from './RimGround.ts';
import type { RimGroundField } from './types.ts';
import { mulberry32, noise3, smoothstep } from './noise.ts';
import { sampleMeadow, meadowColor, supportsMeadow } from '../materials/Meadow.ts';
import { sampleMeadowSoil, soilUniforms } from '../materials/Soil.ts';
import { VegetationLighting, useLighting } from './VegetationLighting.ts';
import { useRestPoseShadows } from './VegetationShadow.ts';
import { setWindDisplacement, wave, windGust, windField, type WindState } from '../weather/Wind.ts';
import { keepLegacyWind } from './WindVariants.ts';
import { CANOPY_TOP, meadowCanopyLight } from '../lighting/MeadowCanopy.ts';
import { puddleCover } from '../weather/Puddles.ts';
import { VEGETATION_STRIDE as STRIDE } from './types.ts';
import { ALPHA_TO_COVERAGE, markVegetation } from './Foliage.ts';
import { debugFlags } from '../debug/DebugFlags.ts';
import { TEMPORAL } from '../post/Antialiasing.ts';
import { jitter } from '../post/Jitter.ts';
import { GrassCull, cullInputs, type CullRange } from './GrassCull.ts';
import type { Shared } from '../shared.ts';

// Stylised meadow on the island top, a sward of two instanced tuft kinds. The lawn is a dense
// tuft of narrow blades on every planting anchor, with a second one where the growth field runs
// thick (so the density varies as well as the height); tussocks are taller fans of arching blades
// grouped by a clump field. Soft upward normals join the blades to the turf rather than lighting
// every tuft as a cushion, each blade takes its own small shift of value and hue, and a gentle
// wind sways the tips. Anchors come from the world worker (x, y, z, normal, rim distance, kind and
// local sky visibility); every choice below is a field or a seeded hash of the anchor, so the
// meadow grows with the island's footprint and needs no placed features.

interface TuftShape {
	blades: number; segs: number;
	r0: [ number, number ]; // base offset from the tuft's axis
	h: [ number, number ]; // blade height
	lean: [ number, number ];
	w: [ number, number ]; // blade width at the root
	droop: number; // how far a leaning blade's tip falls back: arching tussock blades
	reachPow: number; // < 2 bends the blade out sooner, from lower down
}

// Lawn: many narrow, short blades. Two segments are enough for blades this short, and keep the
// doubled blade count near the old tuft's triangle cost per segment.
const LAWN: TuftShape = { blades: 16, segs: 2, r0: [ 0.02, 0.15 ], h: [ 0.45, 0.95 ], lean: [ 0.2, 0.8 ], w: [ 0.038, 0.072 ], droop: 0.3, reachPow: 2 };
// Tussock: long blades fountaining out and over, as tufted hair grass or sedge grows.
const TUSSOCK: TuftShape = { blades: 18, segs: 4, r0: [ 0.01, 0.08 ], h: [ 0.55, 1 ], lean: [ 0.45, 1.05 ], w: [ 0.05, 0.085 ], droop: 0.6, reachPow: 1.6 };

/** The meadow's cost knobs for a quality tier. They shape the meshes and shaders, so they apply
 * when the grass is built (set them before `buildGrass`); the defaults are the high tier's. */
export interface GrassQuality {
	/** Lawn blades drawn per tuft near, mid and far from the camera (of 16), see `selectBatch`. */
	lawnBlades: [ number, number, number ];
	/** Camera distances (m) from a batch's planting box where the mid and far counts begin. */
	bladeBands: [ number, number ];
	/** Segments along a tussock blade (4 arches them smoothly, 3 is close at a distance). */
	tussockSegments: number;
	/** Whether the extra tufts of thick patches exist at all (they fold away beyond 42 m). */
	thinTufts: boolean;
	/** Light through the canopy per vertex instead of per pixel: the dapple inside a blade is
	 * lost close up, so it suits the lower tiers only. */
	canopyPerVertex: boolean;
	/** The least width of a blade on screen (render pixels, see `pixelWideBlade`) under the
	 * temporal modes; 4x multisampling keeps 2 and one sample outside them 1. */
	minWidth: number;
}
const grassQuality: GrassQuality = { lawnBlades: [ 16, 12, 8 ], bladeBands: [ 40, 70 ], tussockSegments: 4, thinTufts: true, canopyPerVertex: false, minWidth: 2 };

export function setGrassQuality( quality: Partial<GrassQuality> ): void {

	Object.assign( grassQuality, quality );

}

function tuftGeometry( shape: TuftShape, seed = 3 ) {

	const rng = mulberry32( seed );
	const range = ( [ a, b ]: [ number, number ] ) => a + rng() * ( b - a );
	const { blades, segs } = shape;
	// T: blade parameter along its length, the half-width offset from the centreline (x, z), and
	// the blade's own hash for its colour shift
	const P: number[] = [], N: number[] = [], T: number[] = [], I: number[] = [];
	for ( let b = 0; b < blades; b ++ ) {

		const a = rng() * Math.PI * 2;
		const r0 = range( shape.r0 );
		const ox = Math.cos( a ) * r0, oz = Math.sin( a ) * r0;
		const h = range( shape.h ); // varied blades keep the meadow from reading as a brush carpet
		const lean = range( shape.lean );
		const w = range( shape.w );
		const id = rng();
		const dx = Math.cos( a ), dz = Math.sin( a );
		const tw = a + Math.PI / 2 + ( rng() - 0.5 ) * 1.0; // width axis, a little twisted
		const wx = Math.cos( tw ), wz = Math.sin( tw );
		const base = P.length / 3;
		for ( let i = 0; i <= segs; i ++ ) {

			const t = i / segs;
			const reach = lean * h * Math.pow( t, shape.reachPow );
			const cx = ox + dx * reach, cz = oz + dz * reach;
			const cy = h * t * ( 1.0 - shape.droop * lean * t );
			const hw = w * 0.5 * Math.pow( 1 - t, 0.85 ) + 0.004;
			for ( const sg of [ - 1, 1 ] ) {

				const px = cx + wx * hw * sg, pz = cz + wz * hw * sg;
				P.push( px, cy, pz );
				const nx = px * 2.2, nz = pz * 2.2, l = Math.hypot( nx, 0.9, nz );
				N.push( nx / l, 0.9 / l, nz / l );
				T.push( t, wx * hw * sg, wz * hw * sg, id );

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
	return g;

}

// Thin blades alias. Their tips are a few millimetres wide, a fraction of a pixel from the
// overview, so 4x MSAA catches them on some frames and misses them on others and the meadow
// crawls as the camera moves. Each blade is kept at least `minWidth` pixels wide on screen,
// widened across the view, and its coverage is lowered by the same factor through alpha to
// coverage, so it hides as much of the ground as the thin blade did at every distance. This is
// the treatment of thin wires after Emil Persson ("Phone-wire AA", Humus, 2012). Two pixels
// brought a slow orbit's meadow flicker most of the way to a supersampled render's; narrower
// widths left more of it, wider ones soften the blades further for little gain. Without
// multisampling the coverage is dithered instead (`coverageDither`), and a blade dithered at half
// its pixels across two reads as a dotted line, sharpened further by the upscale: one pixel keeps
// such blades solid, with the meadow's brightness as at two. Under the temporal modes the dither
// turns from frame to frame and the resolve averages it, so a blade keeps its two pixels there
// (`GrassQuality.minWidth`, set by `buildGrass`), as at 4x: one pixel darkened the meadow and lost
// the flower heads between the blades.
const grassUniforms = {
	minWidth: uniform( ALPHA_TO_COVERAGE ? 2 : 1 ), // render-target pixels
	rimMinWidth: uniform( 0.75 ), // on the outer rim, see `rimEdge` in buildGrass
	// The extra lawn tufts of thick patches fold away between these view distances (m): beyond
	// them a blade is under a pixel wide and the widened blades of the remaining tufts already
	// cover the turf, so the extras would only cost vertices.
	thinNear: uniform( 30 ),
	thinFar: uniform( 42 ),
};
// Beyond this the blade is seen nearly edge on; widening further would only smear it.
const MAX_WIDEN = 8;
const bladeCoverage = varyingProperty( 'float', 'vGrassBladeCoverage' );
// A batch drawing k of a tuft's n blades (`selectBatch`) widens and covers with each kept blade
// n / k times as much, so the meadow hides as much ground as with every blade: a kept blade
// stands in for the dropped ones beside it. 1 with every blade drawn. The stand-in only holds
// where a blade is a few pixels across: a blade seen 16 or more pixels wide keeps its own width
// and coverage (gain 1), or near tufts with fewer blades would draw each one several times as
// broad and solid. Between 16 and 4 pixels the gain eases in.
const bladeGain = uniform( 1 ).onObjectUpdate( ( { object } ) => object?.userData.bladeGain ?? 1 );
const GAIN_FULL_PIXELS = 4;
const GAIN_NONE_PIXELS = 16;

type V3 = THREE.Node<'vec3'>;
type F = THREE.Node<'float'>;

// Returns the widened vertex and passes its coverage to the fragment stage. Positions are world
// positions: the meadow mesh stays at the origin, untransformed.
function pixelWideBlade( position: V3, halfWidth: V3, minWidth: F ): V3 {

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
		// The blade's own width on screen in pixels sets how much of the batch's gain applies;
		// written as 1 + ( gain - 1 ) * s so a gain of 1 stays exactly 1.
		const gainShare = float( 1 ).sub( smoothstepN( GAIN_FULL_PIXELS, GAIN_NONE_PIXELS, halfSeen.mul( 2 ).div( pixel ) ) );
		const gain = bladeGain.sub( 1 ).mul( gainShare ).add( 1 ).toVar();
		const widen = clamp( minWidth.mul( 0.5 ).mul( pixel ).div( halfSeen ), gain, gain.mul( MAX_WIDEN ) ).toVar();
		bladeCoverage.assign( gain.div( widen ) );
		return p.add( seen.mul( widen.sub( 1 ) ) );

	} )() as V3;

}

// The single-sample stand-in for alpha to coverage: a 4x4 Bayer threshold (16 levels, as many as
// the hardware's 4x pattern gives). Like that pattern it is the same for every blade over a
// pixel, so overlapping blades share their covered pixels rather than adding up: the soil and
// the flowers keep showing through a stack of widened blades as they do at 4x. A hash per blade
// (alphaHash) drew independent pixels for each and closed the meadow over them.
// Under the temporal modes the threshold steps through the pattern from frame to frame, the
// pixel's Bayer value plus 5 times the jitter's dither index (Jitter.ts), mod 16: over 16 frames
// every pixel takes every threshold once (5 is coprime to 16), so the resolve sees each blade's
// coverage rather than a fixed pattern of its pixels, while the blades over a pixel still share
// one threshold in each frame. A scene at rest takes the rest sequence's indices, so a paused
// frame does not depend on the frames before it.
const coverageDither = Fn( () => {

	const p = ivec2( screenCoordinate.xy );
	const x = p.x.bitAnd( 3 ), y = p.y.bitAnd( 3 );
	const d = x.bitXor( y );
	const bayer = d.bitAnd( 1 ).shiftLeft( 3 ).bitOr( y.bitAnd( 1 ).shiftLeft( 2 ) ).bitOr( d.bitAnd( 2 ) ).bitOr( y.shiftRight( 1 ) );
	const index = TEMPORAL ? bayer.add( int( jitter.uniforms.ditherIndex ).mul( 5 ) ).bitAnd( 15 ) : bayer;
	return float( index ).add( 0.5 ).div( 16 );

} );

// The tuft a vertex belongs to. The meadow's instance data lives in `GrassCull`'s storage buffers,
// one slot per tuft (each batch from its own first slot, `grassBase`): the view camera's draws read
// the slot from the culled list it wrote, every other draw (the rain's collision bake, a draw with
// the cull switched off) takes each slot in turn, as an instanced draw of every tuft did.
const cullBase = uniform( 0, 'uint' ).onObjectUpdate( ( { object } ) => ( object as THREE.Mesh | undefined )?.geometry?.userData.grassBase ?? 0 );
const cullOn = uniform( 0, 'uint' ).onObjectUpdate( ( { object } ) => object?.userData.grassCulled === true ? 1 : 0 );

const TAU = Math.PI * 2;

// The meadow's response to `windField`:
// each tuft leans with the gust field at its root, its blades bending along their length (the
// offset grows with the square of the blade parameter) while every vertex keeps its distance from
// the root, so a bent blade arcs over and sinks rather than stretching; each blade flutters on
// its own phase across the wind, more in a gust. `wind` is the frame's wind state (`shared.wind`,
// or `.previous`). Returns the bent position and the lean as a world-space vector, for the normals.
function bendBlade( wind: WindState, rooted: THREE.Node<'vec3'>, origin: THREE.Node<'vec3'>, height: THREE.Node<'float'>,
	t2: THREE.Node<'float'>, phase: THREE.Node<'float'> ): { position: THREE.Node<'vec3'>; lean: THREE.Node<'vec3'> } {

	const field = windField( wind, origin.xz ).toVar();
	const along = vec3( field.x, 0, field.y ), across = vec3( field.y.negate(), 0, field.x );
	const flutter = wave( wind.flutter, 1.7, phase ).mul( 0.65 ).add( wave( wind.flutter, 2.9, phase.mul( 2.3 ) ).mul( 0.35 ) );
	const shiver = wind.breeze.mul( field.w.mul( 0.05 ).add( 0.012 ) ).mul( flutter );
	const lean = along.mul( field.z.add( shiver.mul( 0.4 ) ) ).add( across.mul( shiver ) ).toVar();
	const rel = rooted.sub( origin ).toVar();
	const reach = length( rel );
	const bent = normalize( rel.add( lean.mul( height.mul( t2 ) ) ).add( vec3( 0, 1e-5, 0 ) ) ).mul( reach ).add( origin );
	return { position: bent, lean };

}

function grassMaterial( shared: Shared, cull: GrassCull, legacy = false ): THREE.MeshStandardNodeMaterial {

	// Alpha to coverage carries the widened blades' coverage (see `pixelWideBlade`); a blade at
	// least `minWidth` wide keeps full coverage and renders as before. Without multisampling
	// there is no coverage to lower, and the widened blades would draw solid: an ordered dither
	// threshold per pixel keeps that share of a blade's pixels instead (`coverageDither`).
	const mat = new THREE.MeshStandardNodeMaterial( { roughness: 0.86, metalness: 0, side: THREE.DoubleSide, alphaToCoverage: ALPHA_TO_COVERAGE } );
	const slot = instanceIndex.add( cullBase );
	const tuftSlot = select( cullOn.equal( 1 ), storage( cull.visible, 'uint', cull.slots ).toReadOnly().element( slot ), slot ).toVar( 'grassTuft' );
	const input = cullInputs( cull, tuftSlot );
	// The tuft's instance data, read as the instanced attributes were: what the fragment stage
	// reads passes as a varying, as an attribute did.
	const ground0 = input.ground( 0 ), ground1 = input.ground( 1 ), ground2 = input.ground( 2 );
	const skyVisibility = varying( ground0.x, 'vGrassSkyVisibility' ), rimCover = varying( ground0.z, 'vGrassRimCover' );
	const soilCover = varying( ground0.y, 'vGrassSoilCover' ), tuftOrigin = varying( input.origin, 'vGrassTuftOrigin' );
	mat.opacityNode = bladeCoverage;
	if ( ! ALPHA_TO_COVERAGE ) mat.alphaTestNode = coverageDither();
	markVegetation( mat );
	const wind = shared.wind.direction;
	const blade = attribute<'vec4'>( 'blade', 'vec4' );
	const t = blade.x;
	const t2 = t.mul( t );
	// sway: gusts travel across the meadow, the tips move most. `p` is the vertex placed by the
	// tuft's transform, i.e. in world space (the mesh itself stays untransformed), computed as
	// three's instancing did; held in a variable as three's was, which keeps the rounding of
	// every expression built on it.
	const p = input.matrix.mul( positionLocal ).xyz.toVar( 'grassPlaced' );
	const soil = soilCover.mul( soilUniforms.blend ).mul( soilUniforms.strength );
	const tuft = tuftOrigin;
	const origin = tuft.xyz;
	// Folding a thinned tuft into its root: a scale about the anchor, applied like the drowning.
	const thin = ground1.w;
	const kept = float( 1 ).sub( thin.mul( smoothstepN( grassUniforms.thinNear, grassUniforms.thinFar, length( cameraPosition.sub( origin ) ) ) ) );
	// Keep every planting anchor. Narrower, slightly shorter shoots reveal the same soil
	// pockets as the ground material, and a zero blend restores their original footprint.
	// Standing water drowns the blades: the tufts sink below the waterline (the ground, which
	// carries the water's surface, hides them). About a third keep a few centimetres of their
	// tips above it, so sparse drowned spikes stand in an open sheet of water rather than a
	// meadow that hides it. Which tufts and how much is a hash of the planting anchor, fixed.
	const pool = puddleCover( origin.xz, shared.wetness );
	const drowned = float( 1 ).sub( pool.mul( 0.15 ) ).mul( kept );
	const pick = fract( sin( dot( origin.xz, vec2( 12.9898, 78.233 ) ) ).mul( 43758.5453 ) );
	const tip = select( pick.greaterThan( 0.66 ), pick.sub( 0.66 ).mul( 0.25 ).add( 0.03 ), float( - 0.03 ) );
	// The tallest blade of a tuft reaches about 0.9 of its height ( tuft.w / CANOPY_TOP ).
	const sink = max( tuft.w.div( CANOPY_TOP ).mul( drowned ).mul( 0.9 ).sub( tip ), 0 );
	const rooted = p.sub( p.sub( origin ).mul( vec3( 0.22, 0.06, 0.22 ) ).mul( soil ) ).sub( origin ).mul( drowned ).add( origin )
		.sub( vec3( 0, pool.mul( sink ), 0 ) );
	const gust = windGust( p.xz, wind, shared.wind.phase ).mul( shared.wind.strength );
	const bladePhase = fract( blade.w.mul( 17.31 ).add( pick.mul( 5.13 ) ) ).mul( TAU );
	// The blade's half width at this vertex in world space: its local offset from the centreline
	// through the instance's own axes, then the same soil and drowning scale as `rooted` (an
	// affine map of the position, so it scales offsets alike; the gust barely varies across a blade).
	const across = ground1.xyz.mul( blade.y ).add( ground2.xyz.mul( blade.z ) )
		.mul( vec3( float( 1 ).sub( soil.mul( 0.22 ) ), float( 1 ).sub( soil.mul( 0.06 ) ), float( 1 ).sub( soil.mul( 0.22 ) ) ) ).mul( drowned );
	const minWidth = mix( grassUniforms.minWidth, grassUniforms.rimMinWidth, ground0.w );
	const bend = legacy ? undefined : bendBlade( shared.wind, rooted, origin, tuft.w, t2, bladePhase );
	// Short growth needs a smaller world-space sway to keep its tips above the soil.
	// The widening (`pixelWideBlade`) follows the current camera: a previous frame's pose from
	// the registered displacement keeps the widening as it is now.
	const swayed = bend ? setWindDisplacement( mat, ( state ) => pixelWideBlade(
		state === shared.wind ? bend.position : bendBlade( state, rooted, origin, tuft.w, t2, bladePhase ).position, across, minWidth ), shared.wind )
		: pixelWideBlade( rooted.add( vec3( wind.x, 0, wind.y ).mul( gust.mul( 0.023 ).mul( t2 ) ) ).sub( vec3( 0, gust.mul( 0.007 ).mul( t2 ), 0 ) ), across, minWidth );
	const rest = useRestPoseShadows( mat, rooted, swayed );
	// The rest of three's instancing: the normal and the instance colour, before the blade moves.
	const placed = mat.positionNode!;
	mat.positionNode = Fn( () => {

		// A bent blade's normal turns with it, so a gust shows as it sweeps by, as a sheen.
		const normal = transformNormal( normalLocal, input.matrix );
		normalLocal.assign( bend ? normalize( normal.add( bend.lean.mul( t.mul( 1.5 ) ) ) ) : normal );
		instanceColor.assign( input.color );
		return placed;

	} )();
	// dark, shaded roots to the tuft's own colour at the tips (the instance colour multiplies in)
	const cover = rimCover;
	// Each blade shifts its value by up to +/-8 % and its hue a little toward yellow or blue
	// green: a hash of the blade within its tuft and of the tuft's anchor, so neighbouring tufts
	// of one geometry do not repeat the same light and dark blades.
	const jitter = fract( sin( blade.w.mul( 91.7 ).add( pick.mul( 37.3 ) ) ).mul( 43758.5453 ) );
	const tint = fract( jitter.mul( 7.13 ).add( pick.mul( 3.7 ) ) );
	const bladeShift = mix( vec3( 0.95, 1, 1.07 ), vec3( 1.06, 1, 0.86 ), tint ).mul( jitter.mul( 0.16 ).add( 0.92 ) );
	// Meadow gaps and the rim share one root tint instead of colouring the same blade twice.
	const rootSoil = max( soil.mul( 0.7 ), float( 1 ).sub( cover ).mul( 0.55 ).mul( soilUniforms.strength ) );
	const root = mix( vec3( 0.35, 0.43, 0.29 ), vec3( 0.55, 0.38, 0.23 ), rootSoil );
	const wetness = clamp( shared.wetness, 0, 1 );
	mat.colorNode = mix( root, vec3( 1.04, 1, 0.86 ), smoothstepN( 0.02, 0.9, t ) ).mul( bladeShift ).mul( mix( 1, 0.92, wetness ) );
	mat.roughnessNode = mix( 0.86, 0.76, wetness );
	// the tuft's envelope, the same from both sides
	mat.normalNode = normalViewGeometry;
	// The static visibility affects indirect illumination only; sunlight keeps its own shadows.
	mat.aoNode = mix( float( 0.55 ), float( 1 ), smoothstepN( 0.08, 0.85, t ) ).mul( skyVisibility );
	// light through the blades: strongest when the grass stands against the sun
	// Blades do not cast into the sun's shadow map; see MeadowCanopy.
	// Per vertex (lower tiers) it takes the rest pose before the widening, as the shadows do; the
	// mesh is untransformed, so `rooted` is that pose in world space.
	const canopy = grassQuality.canopyPerVertex
		? varying( meadowCanopyLight( rooted.xz, tuft.w.sub( rooted.y.sub( origin.y ) ), shared.sunDir ) )
		: meadowCanopyLight( rest.xz, tuft.w.sub( rest.y.sub( origin.y ) ), shared.sunDir );
	useLighting( mat, () => new VegetationLighting( mix( float( 0.72 ), float( 1 ), t ).mul( canopy ), ( L, V ) =>
		pow( clamp( dot( V.negate(), L ), 0, 1 ), 4 ).mul( 0.42 ).add( 0.04 ).mul( t2 ) ) );
	mat.userData.wind = wind;
	return mat;

}

interface Tuft { m: THREE.Matrix4; col: THREE.Color; visibility: number; soil: number; cover: number; rimEdge: number; thin: number; top: number; origin: THREE.Vector3 }

// One instanced mesh per batch of tufts of one kind, over its own geometry (the draw range and the
// indirect arguments belong to it) that shares the tuft's vertex buffers. Its instance data (the
// transform, colour, ground inputs and anchor) live in `GrassCull`'s storage buffers from the
// batch's first slot on, read by the material through the drawn tuft's slot; `instanceMatrix`
// and `instanceColor` point at those buffers for code that looks for them, and since neither is an
// instanced attribute three leaves the instancing to the material.
function tuftMesh( source: THREE.BufferGeometry, material: THREE.Material, cull: GrassCull, range: CullRange, name: string ): THREE.InstancedMesh {

	const geometry = new THREE.BufferGeometry();
	for ( const key of [ 'position', 'normal', 'blade' ] ) geometry.setAttribute( key, source.getAttribute( key ) );
	geometry.setIndex( source.getIndex() );
	geometry.userData.grassBase = range.start;
	const mesh = new THREE.InstancedMesh( geometry, material, Math.max( range.count, 1 ) );
	mesh.instanceMatrix.array = new Float32Array( 16 ); // replaced below; drop the copy InstancedMesh allocates
	( mesh as unknown as { instanceMatrix: THREE.BufferAttribute } ).instanceMatrix = cull.matrices;
	( mesh as unknown as { instanceColor: THREE.BufferAttribute } ).instanceColor = cull.colors;
	mesh.count = range.count;
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
// - lawn and tussocks draw the first k blades of each tuft (GrassQuality.lawnBlades by distance
//   band). Blades are generated in a random order, so the first k are a fair subset; the kept
//   ones widen and cover for the rest (`bladeGain`). The bands have no hysteresis: that would
//   make the count depend on where the camera came from. A camera crossing an edge steps once,
//   between two counts that hide the same share of the ground.
// The box spans every tuft of a batch, so its nearest tuft sets the band for all of them: a
// larger island keeps more of its meadow in the nearer bands and saves less.
// Other cameras (the rain's collision bake looks straight down, orthographic) see every tuft
// with all its blades, as before.
// The view camera's draws are then culled per tuft on the GPU (`GrassCull`): one compute pass
// for all batches, before the first of them draws, and only when the view or the selection
// changed; each batch draws its surviving tufts through indirect arguments, set on its geometry
// for that draw alone, so any other mesh over the same geometry (the collision bake's proxies)
// draws every tuft.
const _cameraPosition = new THREE.Vector3();

interface Batch { mesh: THREE.InstancedMesh; box: THREE.Box3; shape: TuftShape; thin: boolean; count: number; range: CullRange }

function selectBatch( batch: Batch, camera: THREE.Camera ): void {

	const { mesh, shape } = batch;
	const full = shape.blades * shape.segs * 6;
	if ( ! ( camera as THREE.PerspectiveCamera ).isPerspectiveCamera ) {

		mesh.count = batch.count;
		mesh.geometry.drawRange.count = full;
		mesh.userData.bladeGain = 1;
		return;

	}

	const d = batch.box.distanceToPoint( _cameraPosition.setFromMatrixPosition( camera.matrixWorld ) );
	mesh.count = batch.thin && debugFlags.grassThinCull !== false && d >= grassUniforms.thinFar.value ? 0 : batch.count;
	const bands = grassQuality.bladeBands;
	const level = debugFlags.grassLod === false ? 0 : d < bands[ 0 ] ? 0 : d < bands[ 1 ] ? 1 : 2;
	const lawnBlades = grassQuality.lawnBlades[ level ];
	const blades = Math.min( shape.blades, Math.max( 1, Math.round( shape.blades * lawnBlades / LAWN.blades ) ) );
	mesh.geometry.drawRange.count = blades * shape.segs * 6;
	mesh.userData.bladeGain = shape.blades / blades;

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
		cull.update( renderer, camera );

	} else selectBatch( batch, camera );
	batch.mesh.userData.grassCulled = true;
	batch.mesh.geometry.setIndirect( cull.indirect, batch.range.indirectOffset );

}

function batchOf( source: THREE.BufferGeometry, shape: TuftShape, material: THREE.Material, cull: GrassCull, range: CullRange, tufts: Tuft[], name: string, thin = false ): Batch {

	const mesh = tuftMesh( source, material, cull, range, name );
	const box = new THREE.Box3();
	for ( const t of tufts ) box.expandByPoint( t.origin );
	return { mesh, box, shape, thin, count: tufts.length, range };

}

/** The meadow: lawn and tussock meshes in one group. `walkDistance` (m from a point to the
 * islander's loop) keeps tussocks off the path. */
export function buildGrass( veg: Float32Array, shared: Shared, rimGround?: RimGroundField, walkDistance?: ( x: number, z: number ) => number ): THREE.Group {

	// (the tier's least blade width applies under the temporal modes only: 4x and one sample keep
	// theirs, see `grassUniforms`)
	if ( TEMPORAL ) grassUniforms.minWidth.value = grassQuality.minWidth;
	const n = veg.length / STRIDE;
	const lawn: Tuft[] = [], tussocks: Tuft[] = [], lawnThin: Tuft[] = [];
	// The lawn's own draws keep their old order; everything added since draws from a second
	// stream, a fixed count per anchor, so the planting stays the same wherever a gate changes.
	const rng = mulberry32( 99 );
	const more = mulberry32( 131 );
	const draws = new Float32Array( 12 );
	const q = new THREE.Quaternion(), qy = new THREE.Quaternion();
	const up = new THREE.Vector3( 0, 1, 0 ), dir = new THREE.Vector3(), pos = new THREE.Vector3(), scl = new THREE.Vector3();
	const out = new THREE.Vector3();
	const col = new THREE.Color();
	const tussockTint = new THREE.Color( 1.1, 1.03, 0.82 );
	const plant = ( list: Tuft[], at: THREE.Vector3, rotation: THREE.Quaternion, scale: THREE.Vector3, color: THREE.Color,
		k: number, soil: number, cover: number, rimEdge: number, thin: number ) => list.push( {
		m: new THREE.Matrix4().compose( at, rotation, scale ), col: color.clone(), visibility: veg[ k + 8 ], soil, cover, rimEdge, thin,
		top: scale.y * CANOPY_TOP, origin: at.clone(),
	} );

	for ( let i = 0; i < n; i ++ ) {

		const k = i * STRIDE;
		const x = veg[ k ], y = veg[ k + 1 ], z = veg[ k + 2 ];
		const rim = veg[ k + 6 ];
		// stand with the ground, leaning out a little more over the rim
		dir.set( veg[ k + 3 ], veg[ k + 4 ], veg[ k + 5 ] ).lerp( up, 0.3 ).normalize();
		q.setFromUnitVectors( up, dir );
		qy.setFromAxisAngle( up, rng() * Math.PI * 2 );
		q.multiply( qy );

		// Height gives the meadow a close-cropped bed with irregular islands of longer growth;
		// the canopy's light (meadowCanopyHeight) follows this mean.
		const { growth, variation } = sampleMeadow( x, z );
		const onStack = veg[ k + 7 ] > 0;
		const edge = smoothstep( - 1.1, - 0.05, rim );
		const tall = rng() < smoothstep( 0.38, 0.74, growth ) * 0.46;
		const h = ( 0.17 + 0.14 * growth + edge * growth * 0.07 + ( tall ? 0.16 + 0.1 * variation : 0 ) )
			* ( 0.78 + rng() * 0.44 ) * ( 1 + edge * ( variation - 0.5 ) * 0.35 ) * ( onStack ? 0.55 : 1 );
		pos.set( x, y - 0.018, z );
		const spread = ( tall ? 0.34 : 0.44 ) + growth * 0.08;
		scl.set( spread * ( 0.85 + rng() * 0.3 ), h, spread * ( 0.85 + rng() * 0.3 ) );

		// The terrain samples the same colour field, so gaps read as short turf between shoots.
		meadowColor( x, z, col ).multiplyScalar( 0.93 + rng() * 0.14 );
		for ( let d = 0; d < draws.length; d ++ ) draws[ d ] = more();
		if ( ! supportsMeadow( y, veg[ k + 4 ] ) ) continue;
		const soil = onStack ? 0 : sampleMeadowSoil( x, z );
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
		plant( lawn, pos, q, scl, col, k, soil, cover, rimEdge, 0 );

		// Thick patches take a second lawn tuft beside the first, so the sward's density varies
		// with its growth instead of every anchor holding one rosette. Clear of the rim, where an
		// offset root could leave the turf.
		const dense = noise3( x * 0.9 - 4.3, 6.6, z * 0.9 + 1.9 ) * 0.5 + 0.5;
		const thick = smoothstep( 0.42, 0.78, growth * 0.55 + dense * 0.45 ) * ( 1 - smoothstep( - 0.7, - 0.35, rim ) );
		if ( draws[ 2 ] < thick * 0.9 && ! onStack ) {

			pos.set( x + ( draws[ 3 ] - 0.5 ) * 0.2, y - 0.018, z + ( draws[ 4 ] - 0.5 ) * 0.2 );
			dir.set( veg[ k + 3 ], veg[ k + 4 ], veg[ k + 5 ] ).lerp( up, 0.3 ).normalize();
			q.setFromUnitVectors( up, dir ).multiply( qy.setFromAxisAngle( up, draws[ 5 ] * Math.PI * 2 ) );
			scl.set( spread * ( 0.85 + draws[ 6 ] * 0.3 ), h * ( 0.8 + draws[ 7 ] * 0.35 ), spread * ( 0.85 + draws[ 6 ] * 0.3 ) );
			meadowColor( x, z, col ).multiplyScalar( 0.9 + draws[ 8 ] * 0.18 );
			if ( grassQuality.thinTufts ) plant( lawnThin, pos, q, scl, col, k, soil, cover, rimEdge, 1 );

		}

		// Tussocks grouped by a clump field, a little more often toward the coast: knee-high
		// fountains of arching blades that give the lawn a vertical structure. Kept off the walking
		// loop, where they would hide the walker's legs.
		const clump = noise3( x * 0.42 + 17.3, 2.2, z * 0.42 - 5.1 ) * 0.5 + 0.5;
		const chance = smoothstep( 0.5, 0.7, clump ) * 0.32 + spill * 0.05;
		const clear = walkDistance ? walkDistance( x, z ) : Infinity;
		if ( draws[ 9 ] < chance && clear > 1.0 && ! onStack && soil < 0.3 ) {

			pos.set( x, y - 0.02, z );
			dir.set( veg[ k + 3 ], veg[ k + 4 ], veg[ k + 5 ] ).lerp( up, 0.6 ).addScaledVector( out, spill * 0.35 ).normalize();
			q.setFromUnitVectors( up, dir ).multiply( qy.setFromAxisAngle( up, draws[ 10 ] * Math.PI * 2 ) );
			const th = ( 0.42 + 0.3 * draws[ 11 ] ) * ( 0.8 + 0.4 * growth );
			const ts = 0.5 + 0.2 * draws[ 3 ];
			scl.set( ts, th, ts * ( 0.85 + 0.3 * draws[ 4 ] ) );
			meadowColor( x, z, col ).multiply( tussockTint ).multiplyScalar( 0.92 + draws[ 8 ] * 0.16 );
			plant( tussocks, pos, q, scl, col, k, 0, 1, rimEdge, 0 );

		}

	}

	const group = new THREE.Group();
	group.name = 'grass';
	const lawnGeometry = tuftGeometry( LAWN, 3 );
	const tussock = { ...TUSSOCK, segs: grassQuality.tussockSegments };
	const tussockGeometry = tuftGeometry( tussock, 17 );
	// Root half widths of the widest blade, for the cull's bounds.
	const halfWidth = ( shape: TuftShape ) => shape.w[ 1 ] * 0.5 + 0.004;
	// The extra tufts of thick patches draw on their own, so they can be skipped as a whole.
	const kinds = [
		{ geometry: lawnGeometry, shape: LAWN, tufts: lawn, name: 'grass-lawn', thin: false },
		{ geometry: tussockGeometry, shape: tussock, tufts: tussocks, name: 'grass-tussocks', thin: false },
	];
	if ( lawnThin.length ) kinds.push( { geometry: lawnGeometry, shape: LAWN, tufts: lawnThin, name: 'grass-lawn-thin', thin: true } );
	const cull = new GrassCull( kinds.map( ( k ) => ( { tufts: k.tufts, geometry: k.geometry, halfWidth: halfWidth( k.shape ) } ) ), grassUniforms.thinFar );
	const material = grassMaterial( shared, cull );
	const legacyMaterial = grassMaterial( shared, cull, true );
	const batches = kinds.map( ( k, i ) => batchOf( k.geometry, k.shape, material, cull, cull.ranges[ i ], k.tufts, k.name, k.thin ) );
	for ( const b of batches ) keepLegacyWind( b.mesh, legacyMaterial );
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
	return group;

}
