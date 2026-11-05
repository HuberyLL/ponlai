import * as THREE from 'three/webgpu';
import {
	Fn, If, struct, texture, attribute, uniform, float, vec2, vec3, vec4, mat2, positionWorld, normalWorldGeometry, normalGeometry, cameraViewMatrix,
	cameraPosition, specularColor, specularColorBlended, specularF90,
	normalize, abs, pow, sqrt, max, min, dot, sign, mix, smoothstep, clamp, fract, floor, sin, cos, exp, log2, select, dFdx, dFdy, length, varying,
} from 'three/tsl';
import type { Shared } from '../shared.ts';
import { DETAIL_SIZE, SCAN_LAYER, SCAN_TOP_MIP, type DetailTextures } from './ProceduralTextures.ts';
import { GTAO, floorOcclusion, receiveScreenAO, screenAOAt } from '../post/GTAO.ts';
import { LAWN_GAIN, LAWN_TONE, MEADOW_EXTENT, MEADOW_MIN_UP, MEADOW_MAX_DROP } from './Meadow.ts';
import { SOIL_EXTENT, SOIL_HEIGHT_RANGE, SOIL_PALETTE, soilGroveSwell, soilUniforms } from './Soil.ts';
import { RIM_FRINGE_FADE, RIM_INNER_LIMIT, RIM_MAX_DROP } from '../world/RimGround.ts';
import { BARE_GROUND, GRASS_ROOTS, GRASS_SHADOW, meadowMean, rootsSky, meadowGroundRuns, meadowLayerLight } from '../world/Grass.ts';
import { CROWN_SCALE, swardField } from '../world/SwardField.ts';
import type { WaveMaps } from '../ocean/WaveMaps.ts';
import { underwaterLight, UnderwaterLightingModel, type UnderwaterLight, type UnderwaterModelOptions } from '../lighting/Underwater.ts';
import { keySeaShare } from '../lighting/KeyCloud.ts';
import { TURF_CANOPY_DEPTH, meadowCanopyLight, meadowGroundLight } from '../lighting/MeadowCanopy.ts';
import { puddleField, puddleRipples } from '../weather/Puddles.ts';
import { seabedAlbedo } from './SeabedLook.ts';
import { FLOOR_ALBEDO } from '../world/SeabedTile.ts';
import { DRY_F0, FILM_ROUGHNESS, WATER_F0, runnels, wetAlbedo, wetPorosity, wetRoughness } from './Wetness.ts';
import { hexReadScan, heightBlend, type HexScan } from './HexTiling.ts';
import { debugFlags } from '../debug/DebugFlags.ts';
import { FSR3 } from '../post/Antialiasing.ts';
import { fsr3MipBiasScale } from '../post/fsr3/MipBias.ts';
import { MEADOW_SHADE, SS_SHADOW, meadowGroundShade, screenShadowAt, releaseSwardShade } from '../post/MeadowShade.ts';
import { writeMeter } from '../lighting/MeterLight.ts';
import { liftKeyWorld } from '../lighting/KeyLift.ts';

// The meadow's ground shaded by its crowns toward the light (`meadowGroundLight`); off with
// `flags=groundCast:false` at load (the canopy's mean depth instead).
const GROUND_CAST = debugFlags.groundCast !== false;
// The blades' own shade on it, marched from its point over the vegetation's depth as the blades'
// is (post/MeadowShade.ts `meadowGroundShade`), so the ground under a sunlit sward carries the
// blade-shaped shadows a close look shows, within some 20 m of the eye; the fade beyond only
// changes where the screen-space shade comes from (the ground's own march, then the pixel's), never
// the layer's shade or the occlusion; off with `flags=groundShade:false` at load. With the screen-space shade
// over the whole scene (`SS_SHADOW`) that march runs over the opaque scene's depth too and fades
// into the pixel's shade beyond it, and the ground and stones elsewhere take the pixel's shade on
// the key (the culms' and the stones' contact shade, a rock's seams); the sea floor, lit by the
// refracted sun, does not.
const GROUND_SHADE = MEADOW_SHADE && debugFlags.groundShade !== false;

// PBR materials for the rock and the sea floor: MeshStandardNodeMaterial (lights, shadows, IBL)
// with the surface built procedurally in world space (triplanar baked detail, moss, wet band,
// algae, sediment) and the light below the water attenuated on its way down (sun path through
// the water column, ambient) by a lighting model of its own, so the water shader only
// has to add the view path. Above the water its ambient diffuse is the ambient volume's
// (lighting/AmbientSample.ts), whose probes see the groves and the cliffs, with the environment's
// specular occluded by it.
//
// The cliff's stone is a scan, hex-tiled after Mikkelsen (HexTiling.ts) so it never repeats on a
// lattice, with per-facet shade, paler recent scars, strata, parting seams, runoff streaks from the
// lip and ledges, dry stone under overhangs, orange lichen near the lip, upper-cliff moss (its
// upper 1.2 m only) and a black lichen spray zone that climbs with the coast's exposure. The layers
// over the stone meet it by the scan's relief (moss, turf, soil and runoff fill its low points,
// lichens take its raised grain first), each keeping its mask's mean cover; stacked layers (cliff
// moss, root soil and turf) take adjacent ranges of the relief in stacking order, so each one's
// visible cover matches the plain mix's. Turf stays on the meadow: never on ledges below the lip.
// The meadow's ground is a grass-coloured ground at every distance (GRASS_GROUND), grained by a CC0
// scan of a forest floor (hex-tiled from above as the stone is), its soil showing only where the
// sward parts; lit as the blades' roots are (Grass.ts GRASS_ROOTS) and shaded by the blades' layer
// (Grass.ts `meadowLayerLight`; with it off, through their canopy, MeadowCanopy.ts), as deep along
// the rim as inland, though the blades shorten there (Grass.ts `meadowGroundRuns`). How deep the
// sward over a point is, and whether any grows there, comes from its tussocks (the sward's fields,
// SwardField.ts): the roots' light follows it, deep under the tall sward and opening under the
// short turf and in the gaps, where one shade everywhere drew the low flowers' patches as dark
// holes. The island top is one sward to the edge on every coast: the ground takes no zones of the
// soil (Meadow.ts).
// `?terrainHex=0` builds the plain triplanar variant; `userData.terrainVariant` swaps them.
// Under fsr3 the triplanar sampling gradients are scaled by FSR's mip bias (post/fsr3/MipBias.ts),
// built into the shader under that mode only.
//
// kind 'cliff'  : island block and submerged rocks (triplanar)
// kind 'seabed' : sand, ripples, seagrass and rubble (planar)

type V3 = THREE.Node<'vec3'>;
type V2 = THREE.Node<'vec2'>;
type F = THREE.Node<'float'>;

// The rim's turf wraps the lip's bevel where a broad field along the coast (gravel's
// low-frequency channel at LIP_WRAP_RATE per metre, a few metres a stretch) clears LIP_WRAP; the
// stone left between is darkened by LIP_SKIN (linear multiplier) on its upward faces.
const LIP_WRAP = [ 0.38, 0.55 ], LIP_WRAP_RATE = 0.09, LIP_SKIN = [ 0.5, 0.52, 0.5 ], LIP_LEDGE = 1.2, RIM_SOIL_TONE = 0.6;
// The meadow's ground. Between the blades, near and far alike, a grass-coloured ground
// (GRASS_GROUND): the blades' mean albedo (Grass.ts `meadowMean`, following the lawn's gain) at
// `value` of its value, a little warmer (`balance`: R/G about 0.77 against the blades' 0.7, B/G
// about 0.18 against 0.125), in the turf's tone (Meadow.ts, the meadow map's R), mottled over 1 -
// 3 m (a band-limited noise, `mottle` its amplitude per unit of the noise, at `mottleRate` cycles
// per metre of its lowest octave) and grained by the meadow scan's own value, without its colour
// (its value over the scan's mean to the power `grain`: the scan's value spreads by about 0.37 in
// log units over 5 mm and 0.2 over 2 cm, so the grain is about +-13 % up close and +-7 % at the
// game's 60 m). The blades thin with distance (Grass.ts LOD), and a ground of their own mean keeps
// the thinned meadow its colour with no ring where they thin: a brown soil between them drew a ring
// of colour 20 m - 28 m out that slid with the camera, and mixing the far ground toward their mean
// left a flat green with no grain. Where the sward parts (the meadow map's G, its cover, below
// `bare`), the scan's soil shows, height-blended over its relief (`seam` wide): a near detail on a
// few edges, never a far tone.
// Under the bamboo groves the grass stops where their litter lies (BambooGroves.ts `litterAt`, the
// soil map's A: clearings of it a few metres inside the culm line, and discs under the clusters of
// shoots), and the floor there is the litter (GROVE_FLOOR), height-blended over the meadow scan's
// relief (GROVE_SEAM wide); the grass-coloured ground runs on under the culms up to it. The litter is
// paler than the grass ground (`value` times its value) and nearly neutral (`hue`, its R : G : B),
// grained by a second scan, of moss, short grass, dead leaves and twigs (its value over its mean to
// the power `grain`: about +-20 % up close) with `spread` of that scan's own hue about its mean.
// Patches of a low blue-green groundcover lie on it (`groundcover`: about 15 % of the litter, a
// metre to a few across, where a band-limited noise at `rate` cycles per metre of its tile clears
// `cover`, height-blended over the scan's relief), brighter than the grass ground and bluer than the
// blades. Each scan: its tile (m), its mean colour (linear), and the brightness range (its 5th to
// 95th percentiles) that ranks its height, for the hex tiles' seams, the paler leaves and twigs
// lying on top.
// The meadow's soil is taken toward ochre (GROUND_OCHRE): its colour multiplied by `balance` (its
// luminance kept), from a red brown (over its soil, its pixels redder than green: hue 72 degrees in
// Oklab, R/G 1.65, B/G 0.45) to a yellow brown (the brighter half: 88 degrees, R/G 1.54, B/G 0.17,
// chroma 1.45 times), where it read grey violet beside the blades. Its small leaves, green and
// yellow (a quarter of its pixels: their green within `green` of their red, in shares of their
// luminance, where the soil's lies near -0.6), read as clover between the blades: they take the
// soil's colour (`soil`, through the same balance) and `fleck` of their value, about the soil's, so
// only their shapes are left in its grain. `gain` sets its mean at the blades' mean albedo. It
// shows where the sward parts but not within the litter's edge (`litter`: the litter it fades over),
// where the grass stops for the litter instead.
// The scan's normal and roughness show wherever the floor does (`floorShare`): the grass-coloured
// ground keeps the scan's grain, so its relief stays with it.
// The lip's bevel takes the scan's mean (GROUND_FLAT, by the surface's up): mapped from above, the
// scan ran down its slope in stripes.
const GROUND_SCANS = {
	meadow: { tile: 1.3, mean: [ 0.1388, 0.0995, 0.0376 ], luma: [ 0.036, 0.238 ], gain: 0.947 },
	grove: { tile: 2, mean: [ 0.2918, 0.2482, 0.1198 ], luma: [ 0.149, 0.383 ] },
} as const;
const GROUND_OCHRE = { balance: [ 0.9, 1, 0.36 ], soil: [ 1.65, 1, 0.445 ], green: [ - 0.35, - 0.1 ], fleck: 0.5 };
// the soil's colour, balanced, at a luminance of 1
const OCHRE_SOIL = ( () => {

	const c = GROUND_OCHRE.soil.map( ( v, i ) => v * GROUND_OCHRE.balance[ i ] );
	const y = 0.2126 * c[ 0 ] + 0.7152 * c[ 1 ] + 0.0722 * c[ 2 ];
	return c.map( ( v ) => v / y ) as [ number, number, number ];

} )();
const GROVE_SEAM = 0.15;
const GROUND_FLAT = [ 0.82, 0.95 ];
const GRASS_GROUND = { value: 1.05, balance: [ 1.1, 1, 1.4 ], grain: 0.35, mottle: 0.8, mottleRate: 0.25, bare: [ 0.2, 0.6 ], seam: 0.3, litter: 0.3 };
const GROVE_FLOOR = {
	value: 1.3, hue: [ 1, 1, 0.47 ], grain: 1.05, spread: 0.3,
	groundcover: { value: 1.1, hue: [ 0.65, 1, 0.25 ], rate: 0.15, cover: [ 0.555, 0.59 ], seam: 0.3 },
} as const;
// (a colour's ratios at a luminance of 1)
const atUnitLuma = ( c: readonly number[] ) => {

	const y = 0.2126 * c[ 0 ] + 0.7152 * c[ 1 ] + 0.0722 * c[ 2 ];
	return c.map( ( v ) => v / y ) as [ number, number, number ];

};
const GROVE_LITTER_HUE = atUnitLuma( GROVE_FLOOR.hue ), GROUNDCOVER_HUE = atUnitLuma( GROVE_FLOOR.groundcover.hue );
const GROVE_SCAN_HUE = atUnitLuma( GROUND_SCANS.grove.mean );

// canopy: direct light left under the meadow's blades (1 where nothing grows)
// water: share under a water film or standing water (water's specular reflectance)
// puddle: share under standing water
// flow: share under water running down a runnel now
// sward: the turf's cover (0 on stone, the bare ground and the sea floor)
const Surface = struct( { albedo: 'vec3', normal: 'vec3', rough: 'float', ao: 'float', canopy: 'float', water: 'float', puddle: 'float', flow: 'float', sward: 'float' } );
interface SurfaceNode { get( name: 'albedo' | 'normal' ): V3; get( name: 'rough' | 'ao' | 'canopy' | 'water' | 'puddle' | 'flow' | 'sward' ): F }

// Whiteout triplanar blend (after Ben Golus), with the projection handedness preserved.
// A principal axis must retain the geometry normal's sign: abs() would turn every west- or
// south-facing wall toward the light and paint false bright patches across the rock.
const triNormal = Fn( ( [ tx, ty, tz, n, w, k ]: [ V2, V2, V2, V3, V3, F ] ) => {

	const sg = sign( n );
	const nx = vec3( n.x, n.y.add( tx.y.mul( k ) ), n.z.add( tx.x.mul( k ).mul( sg.x ) ) );
	const ny = vec3( n.x.add( ty.x.mul( k ).mul( sg.y ) ), n.y, n.z.add( ty.y.mul( k ) ) );
	const nz = vec3( n.x.sub( tz.x.mul( k ).mul( sg.z ) ), n.y.add( tz.y.mul( k ) ), n.z );
	return normalize( nx.mul( w.x ).add( ny.mul( w.y ) ).add( nz.mul( w.z ) ) );

} ).setLayout( {
	name: 'terrainTriplanarNormal', type: 'vec3',
	inputs: [
		{ name: 'tx', type: 'vec2' }, { name: 'ty', type: 'vec2' }, { name: 'tz', type: 'vec2' },
		{ name: 'n', type: 'vec3' }, { name: 'w', type: 'vec3' }, { name: 'k', type: 'float' },
	],
} );

// The scan's hex tiles (HexTiling.ts): their centres lie 0.39 of its period apart (about 0.7 m on
// the wall), and each turns by up to 0.4 rad, so the stone's grain keeps its general lie.
const HEX_RATE = 0.75, HEX_MAX_ANGLE = 0.4, HEX_TRIPLANAR_CUT = 0.08;
// The scan's brightness (linear) mapped to a height in [0, 1] for the hex tiles' seams: its 2nd to
// 97th percentiles span the range, and the power lifts the darker half.
const stoneHeight = ( luma: F ): F => pow( clamp( luma.sub( 0.08 ).div( 0.19 ), 0, 1 ), 0.7 );
// The ground scans' likewise (GROUND_SCANS `luma`).
const groundHeight = ( rgb: V3, [ low, high ]: readonly [ number, number ] ): F => pow( clamp( dot( rgb, vec3( 0.2126, 0.7152, 0.0722 ) ).sub( low ).div( high - low ), 0, 1 ), 0.7 );
// The layers over the stone meet it by rank instead (heightBlend wants heights spread evenly over
// [0, 1]): the share of the hex-tiled scan's texels that are darker. Measured on the scan as the
// material composes it (hex blend included) at each mip level, its brightness keeps one skewed
// shape about a mean of 0.16 while its spread narrows with the level, as the filter averages the
// grain away (0.045 at full size, 0.030 four levels down). So the brightness is standardised by
// the spread at the level the pixel reads, and the shape's distribution (a logistic of a cubic,
// fitted to levels 0 - 5) turns it into the rank. The mean cover of a layer then stays within 0.02
// of its mask up to level 5, and 0.045 at level 7.
const STONE_TEXELS = 1024; // the scan's width: the fit above belongs to it
const stoneRank = ( luma: F, level: F ): F => {

	const l = clamp( level, 0, 7 );
	const spread = float( 0.044754 ).sub( l.mul( 0.003201 ) ).sub( l.mul( l ).mul( 0.000126 ) );
	const z = luma.sub( 0.16 ).div( spread );
	const logit = z.mul( 0.059 ).sub( 0.2389 ).mul( z ).add( 1.7193 ).mul( z ).add( 0.1996 );
	return float( 1 ).div( exp( logit.negate() ).add( 1 ) );

};

// The triplanar projections' scale (~1.8 m per tile), the scan's over them (the 2.7 m scan art-
// directed to smaller flakes beneath the mesh fractures), and the width of the layer stack's blend
// over the stone's relief (`hb` below).
const TRIPLANAR_SCALE = 0.55, STONE_SCALE = ( 1 / 1.8 ) / TRIPLANAR_SCALE, LAYER_WIDTH = 0.25;

const unpack2 = ( v: THREE.Node<'vec4'> | V2 ) => ( v as V2 ).mul( 2 ).sub( 1 );
// Convert tangent normals to slopes before whiteout blending, retaining the scan's +Y axis. The
// detail maps hold the normal's x and y (its z follows) and the roughness in blue.
const stoneSlope = Fn( ( [ v ]: [ THREE.Node<'vec4'> ] ) => {

	const xy = unpack2( v.xy );
	return xy.div( max( sqrt( max( float( 1 ).sub( dot( xy, xy ) ), 0 ) ), 0.3 ) );

} ).setLayout( { name: 'stoneNormalSlope', type: 'vec2', inputs: [ { name: 'sample', type: 'vec4' } ] } );

// Art-directed reflectance at normal incidence for the sky mirrored by standing water and by
// the slugs of water running down the runnels (see the specular setup below); the runnels'
// darkening of the stone and their shade on its ambient light.
const PUDDLE_F0 = 0.2, FLOW_F0 = 0.5, RING_GAIN = 5;
const RUNNEL_DARKENING = 0.6, RUNNEL_SHADE = 0.7;
// The reflectance of stone and sand under the water over theirs in the air: Fresnel's at normal
// incidence, ( ( 1.5 - 1.33 ) / ( 1.5 + 1.33 ) )^2 against 0.04.
const STONE_UNDER_WATER = 0.09;

interface Ctx {
	tex: DetailTextures; shared: Shared; topY: F; vegetation: boolean; shore: FieldTexture;
	rimGround?: FieldTexture; rimGroundXform?: THREE.Node<'vec4'>; hex: boolean;
	/** The island's ground's runs under the meadow's layer, per vertex: x as everything but the turf
	 * takes it, y as the turf does (Grass.ts `meadowGroundRuns`). */
	meadowRun?: THREE.Node<'vec2'> | null;
}
// hex: hex-tiled stone and height-blended layers (the default; debugFlags.terrainHex = false
// builds the plain tiling with smooth masks, as before)
// a world field (WorldFields.ts): its base node, which a swapped field's texture follows
type FieldTexture = THREE.Texture | THREE.TextureNode;
interface TerrainOptions { topY?: number; vegetation?: boolean; rimGround?: FieldTexture; rimGroundXform?: THREE.Vector4; hex?: boolean }

function cliffSurface( { tex, shared, topY: level, vegetation, rimGround, rimGroundXform, hex, meadowRun }: Ctx ) {

	return Fn( () => {

		const p = positionWorld;
		// The meadow's own top here (`topY`): the plateau's level and its swell, and the bamboo
		// groves' litter (Soil.ts's second layer: A the litter, G and B the swell in 16 bits).
		// Submerged boulders keep the level.
		const swellAt = vegetation ? soilGroveSwell( tex.soil, p.xz ) : null;
		const topY = swellAt ? level.add( swellAt.swell ).toVar() : level;
		const n0 = normalize( normalWorldGeometry ).toVar();
		// The island's cliff detail (makeIslandSDF): the facet's identity, how recently its scar
		// fell, the bed coordinate and the depth below the column's own top; how much rock
		// overhangs the point, how exposed the coast is to the waves and whether it lies in a pocket.
		// Submerged boulders have none.
		const detail = vegetation ? attribute<'vec4'>( 'detail', 'vec4' ) : vec4( 0.5, 0, 0, 0 );
		const detail2 = vegetation ? attribute<'vec3'>( 'detail2', 'vec3' ) : vec3( 0, 0.5, 0 );
		const lipDepth = detail.w.toVar();
		const fresh = detail.y.toVar(), shelter = detail2.x.toVar(), pocket = detail2.z.toVar();
		// Turf belongs on the meadow only: not on ledges below the lip nor on the stumps of fallen
		// columns, which stand lower than the meadow's planting height and grow no grass.
		const meadowTop = vegetation ? smoothstep( 0.32, 0.2, lipDepth ).mul( smoothstep( topY.sub( 0.3 ), topY.sub( 0.18 ), p.y.add( lipDepth ) ) ).toVar() : float( 1 );
		// Bare stone must always sample its mineral maps, including upward boulder faces.
		const legacyTurf = ( vegetation ? smoothstep( 0.85, 0.97, n0.y ).mul( smoothstep( topY.sub( 0.6 ), topY.sub( 0.2 ), p.y ) ).mul( meadowTop ) : float( 0 ) ).toVar();
		const turf = legacyTurf.toVar();
		const rimBlend = float( 0 ).toVar(), rimTurf = float( 0 ).toVar(), rimSoil = float( 0 ).toVar();
		if ( vegetation && rimGround && rimGroundXform ) {

			// One cell-centred field also controls edge grass on the CPU. Sample it before any
			// dynamic branches so the narrow fringe stays aligned and derivatives stay uniform.
			const ground = texture( rimGround, p.xz.sub( rimGroundXform.xy ).mul( rimGroundXform.zw ) ).toVar();
			const d = ground.r, roof = ground.g, retreat = ground.b;
			const depth = ground.a.mul( soilUniforms.depth );
			const cover = smoothstep( retreat.sub( RIM_FRINGE_FADE ), retreat.add( RIM_FRINGE_FADE ), d.negate() );
			const atRim = smoothstep( - RIM_INNER_LIMIT, - RIM_INNER_LIMIT + 0.15, d )
				.mul( float( 1 ).sub( smoothstep( 0.20, 0.48, d ) ) );
			const atRoof = smoothstep( roof.sub( RIM_MAX_DROP ), roof.sub( RIM_MAX_DROP - 0.045 ), p.y );
			rimBlend.assign( atRim.mul( atRoof ) );
			// A shallow root bed lets the turf grow down over the lip, onto steeper faces and further
			// below the roof, with a ragged lower edge; deep beds stop it short above their soil.
			// ... and along most of the coast the turf wraps the lip's bevel to its edge (`wrap`, a
			// broad field along the coast, LIP_WRAP of it), the stone showing only in stretches between
			const wrap = smoothstep( LIP_WRAP[ 0 ], LIP_WRAP[ 1 ], texture( tex.gravel, p.xz.mul( LIP_WRAP_RATE ).add( 0.31 ) ).a );
			const overgrown = max( float( 1 ).sub( smoothstep( 0.08, 0.14, depth ) ), wrap ).mul( soilUniforms.strength.min( 1 ) );
			const ragged = texture( tex.heights, p.xz.mul( 1.3 ).add( p.y.mul( 0.9 ) ) ).g.sub( 0.5 ).mul( 0.12 );
			const greenDrop = mix( clamp( depth.add( 0.02 ), 0.05, 0.16 ), float( 0.27 ).add( ragged ), overgrown );
			rimTurf.assign( cover.mul( smoothstep( mix( 0.65, 0.18, overgrown ), mix( 0.95, 0.6, overgrown ), n0.y ) )
				.mul( smoothstep( roof.sub( greenDrop ), mix( roof.sub( 0.025 ), roof.sub( greenDrop ).add( 0.04 ), overgrown ), p.y ) ).mul( meadowTop ) );
			// Root soil occupies small retreat pockets and rounded shoulders. Overlapping grass
			// and exposed stone interrupt it, rather than drawing a continuous brown collar.
			const soilBand = smoothstep( - 0.56, - 0.18, d ).mul( float( 1 ).sub( smoothstep( 0.10, 0.35, d ) ) );
			const soilPocket = mix( float( 0.14 ), float( 0.76 ), smoothstep( - 0.045, 0.24, retreat ) );
			rimSoil.assign( soilBand.mul( soilPocket ).mul( smoothstep( 0.15, 0.80, n0.y ) )
				.mul( smoothstep( roof.sub( depth ).sub( 0.055 ).add( ragged ), roof.sub( depth ).add( 0.02 ).add( ragged ), p.y ) )
				.mul( soilUniforms.strength ) );
			turf.assign( mix( legacyTurf, rimTurf, rimBlend ) );

		}
		const vAO = attribute<'float'>( 'ao', 'float' ), vTint = attribute<'float'>( 'tint', 'float' ), vCurv = attribute<'float'>( 'curv', 'float' );

		// triplanar weights; projections with a negligible share are skipped (most pixels need one
		// or two of the three), gradients taken outside the branches so mip selection stays right
		const w0 = pow( abs( n0 ), vec3( 4 ) );
		const w1 = max( w0.div( dot( w0, vec3( 1 ) ) ).sub( 0.02 ), 0 );
		const w = w1.div( dot( w1, vec3( 1 ) ) ).toVar();
		// The hex-tiled scan reads up to three tiles per projection, so it drops projections under
		// 8 % (instead of 2 %): only the steepest bevels then read two, and the blend between them
		// narrows a little where the facets' own edges already break the stone.
		const ws = hex ? max( w0.div( dot( w0, vec3( 1 ) ) ).sub( HEX_TRIPLANAR_CUT ), 0 ).toVar() : w;
		if ( hex ) ws.divAssign( dot( ws, vec3( 1 ) ) );
		const S = TRIPLANAR_SCALE;
		const sg = sign( n0 );
		const uvX = vec2( p.z.mul( sg.x ), p.y ).mul( S ).toVar(), uvY = vec2( p.x.mul( sg.y ), p.z ).mul( S ).toVar(), uvZ = vec2( p.x.negate().mul( sg.z ), p.y ).mul( S ).toVar();
		// (under fsr3 scaled by FSR's mip bias, render / canvas: fsr3/MipBias.ts)
		const biased = ( g: THREE.Node<'vec2'> ) => FSR3 ? g.mul( fsr3MipBiasScale ) : g;
		const gxX = biased( dFdx( uvX ) ).toVar(), gyX = biased( dFdy( uvX ) ).toVar(), gxY = biased( dFdx( uvY ) ).toVar(), gyY = biased( dFdy( uvY ) ).toVar(), gxZ = biased( dFdx( uvZ ) ).toVar(), gyZ = biased( dFdy( uvZ ) ).toVar();
		// Screen derivatives of the position: the wet layer samples with explicit gradients inside
		// its branch, and the world footprint of a pixel filters the rain rings on puddles.
		const dpx = dFdx( p ).toVar(), dpy = dFdy( p ).toVar();
		const betaWidth = abs( dFdx( detail.z ) ).add( abs( dFdy( detail.z ) ) ).toVar();
		const footprint = max( length( dpx.xz ), length( dpy.xz ) ).toVar();
		const half = vec4( 0.5 );
		const hX = half.toVar(), hY = half.toVar(), hZ = half.toVar();
		const aX = half.toVar(), aY = half.toVar(), aZ = half.toVar();
		const fX = vec4( 0.5, 0.5, 0.9, 1 ).toVar(), fY = fX.toVar(), fZ = fX.toVar();
		const cX = half.toVar(), cY = half.toVar(), cZ = half.toVar();
		const stoneScale = STONE_SCALE;
		// Hex-tiled reads of the scan's colour and normal map (HexTiling.ts). The procedural
		// heights keep their plain tiling: three more reads per projection cost more than their
		// lattice shows under the hex-tiled stone.
		// sX..: the scan's slope, turned back into the projection's frame; rX..: its roughness.
		// The scan is read wherever the stone shows: off the turf, and in the rim's fringe, where the
		// fringe's own masks may leave stone between its turf and soil.
		const scanned = hex ? turf.lessThan( 1 ).or( rimBlend.greaterThan( 0 ) ).toVar() : null;
		const sX = vec2( 0 ).toVar(), sY = vec2( 0 ).toVar(), sZ = vec2( 0 ).toVar();
		const rX = float( 0.9 ).toVar(), rY = rX.toVar(), rZ = rX.toVar();
		const scan: HexScan = {
			colour: tex.scanAlbedo, normal: tex.scanDetail, layer: SCAN_LAYER.rock, scale: stoneScale, rate: HEX_RATE, maxAngle: HEX_MAX_ANGLE,
			colourRest: half, normalRest: fX, height: ( rgb ) => stoneHeight( dot( rgb, vec3( 0.2126, 0.7152, 0.0722 ) ) ), slope: stoneSlope,
		};
		if ( hex ) {

			const proj: [ F, F, V2, V2, V2, THREE.Node<'vec4'>, THREE.Node<'vec4'>, V2, F, THREE.Node<'vec4'> ][] = [
				[ w.x, ws.x, uvX, gxX, gyX, hX, aX, sX, rX, cX ],
				[ w.y, ws.y, uvY, gxY, gyY, hY, aY, sY, rY, cY ],
				[ w.z, ws.z, uvZ, gxZ, gyZ, hZ, aZ, sZ, rZ, cZ ],
			];
			for ( const [ wi, wsi, st, gx, gy, h, a, s, r, c ] of proj ) {

				If( wi.greaterThan( 0 ), () => {

					h.assign( texture( tex.heights, st ).grad( gx, gy ) );
					if ( vegetation ) a.assign( texture( tex.normalsA, st ).grad( gx, gy ) );

				} );
				If( wsi.greaterThan( 0 ).and( scanned! ), () => {

					hexReadScan( st, gx, gy, scan, c, s, r );

				} );

			}

		} else {

			If( w.x.greaterThan( 0 ), () => {

				hX.assign( texture( tex.heights, uvX ).grad( gxX, gyX ) );
				if ( vegetation ) aX.assign( texture( tex.normalsA, uvX ).grad( gxX, gyX ) );
				If( turf.lessThan( 1 ), () => {

					fX.assign( texture( tex.scanDetail, uvX.mul( stoneScale ) ).grad( gxX.mul( stoneScale ), gyX.mul( stoneScale ) ).depth( float( SCAN_LAYER.rock ) ) );
					cX.assign( texture( tex.scanAlbedo, uvX.mul( stoneScale ) ).grad( gxX.mul( stoneScale ), gyX.mul( stoneScale ) ).depth( float( SCAN_LAYER.rock ) ) );

				} );

			} );
			If( w.y.greaterThan( 0 ), () => {

				hY.assign( texture( tex.heights, uvY ).grad( gxY, gyY ) );
				if ( vegetation ) aY.assign( texture( tex.normalsA, uvY ).grad( gxY, gyY ) );
				If( turf.lessThan( 1 ), () => {

					fY.assign( texture( tex.scanDetail, uvY.mul( stoneScale ) ).grad( gxY.mul( stoneScale ), gyY.mul( stoneScale ) ).depth( float( SCAN_LAYER.rock ) ) );
					cY.assign( texture( tex.scanAlbedo, uvY.mul( stoneScale ) ).grad( gxY.mul( stoneScale ), gyY.mul( stoneScale ) ).depth( float( SCAN_LAYER.rock ) ) );

				} );

			} );
			If( w.z.greaterThan( 0 ), () => {

				hZ.assign( texture( tex.heights, uvZ ).grad( gxZ, gyZ ) );
				if ( vegetation ) aZ.assign( texture( tex.normalsA, uvZ ).grad( gxZ, gyZ ) );
				If( turf.lessThan( 1 ), () => {

					fZ.assign( texture( tex.scanDetail, uvZ.mul( stoneScale ) ).grad( gxZ.mul( stoneScale ), gyZ.mul( stoneScale ) ).depth( float( SCAN_LAYER.rock ) ) );
					cZ.assign( texture( tex.scanAlbedo, uvZ.mul( stoneScale ) ).grad( gxZ.mul( stoneScale ), gyZ.mul( stoneScale ) ).depth( float( SCAN_LAYER.rock ) ) );

				} );

			} );

		}
		const H = hX.mul( w.x ).add( hY.mul( w.y ) ).add( hZ.mul( w.z ) ).toVar();
		const Fc = hex ? null : fX.mul( w.x ).add( fY.mul( w.y ) ).add( fZ.mul( w.z ) ).toVar();
		const stoneColor = cX.rgb.mul( ws.x ).add( cY.rgb.mul( ws.y ) ).add( cZ.rgb.mul( ws.z ) ).toVar();
		const big = texture( tex.gravel, p.xz.mul( 0.019 ).add( p.y.mul( 0.011 ) ) ).a.toVar(); // large-scale variation
		const big2 = texture( tex.gravel, p.zx.mul( 0.047 ).add( vec2( 0.31, p.y.mul( 0.03 ) ) ) ).a.toVar();

		// Geometry owns the large fractures. Low-amplitude mineral relief avoids inflated,
		// unrelated Voronoi facets that fight those planes and read as moulded plastic.
		const nRock = hex ? triNormal( sX, sY, sZ, n0, ws, float( 0.6 ) ) : triNormal( stoneSlope( fX ), stoneSlope( fY ), stoneSlope( fZ ), n0, w, float( 0.6 ) );

		// --- limestone: broad cool-grey faces with the scan's full mineral variation. Geometry and
		// sunlight define the edges; curvature only adds a little weathering, never a white outline.
		// The stone stays darker than real limestone (about 0.1 linear albedo against 0.2 - 0.35):
		// the exposure is set for the meadow, and an afternoon sun meets the vertical faces almost
		// head on, so a paler stone ran into the tone curve's shoulder, where its grain flattened
		// into one cream-white face (a third of the sunlit face's pixels at 0.85 of display white
		// or above, against about 6 % now, its local contrast up by about 40 %).
		const convex = vegetation ? smoothstep( 1.2, 4.0, vCurv ) : smoothstep( 1.6, 5.0, vCurv );
		// The island's blocks meet in sharp creases: only the deepest of them count as hollows.
		const concave = ( vegetation ? smoothstep( - 1.5, - 6.0, vCurv ) : smoothstep( - 0.5, - 3.0, vCurv ) ).toVar();
		const stoneLuma = dot( stoneColor, vec3( 0.2126, 0.7152, 0.0722 ) ).toVar();
		// The stone's relief for the layers above it, read from the scan's brightness (its crevices
		// and pits are its darkest texels): moss, turf, soil and runoff fill the low points first,
		// lichens take the raised grain first, so their edges bite into the stone while each keeps
		// its mean cover (heightBlend). Its rank depends on the level of the scan's mips the pixel
		// reads: the area its footprint covers in texels (the anisotropic filter, up to 8 taps,
		// averages along the footprint's long axis too).
		const stoneLevel = ( () => {

			if ( ! hex ) return float( 0 );
			const texels = stoneScale * STONE_TEXELS;
			const lx = dot( vec3( length( gxX ), length( gxY ), length( gxZ ) ), ws ).mul( texels );
			const ly = dot( vec3( length( gyX ), length( gyY ), length( gyZ ) ), ws ).mul( texels );
			const pMax = max( lx, ly ), pMin = min( lx, ly );
			return log2( max( pMax.mul( max( pMin, pMax.div( 8 ) ) ), 1e-6 ) ).mul( 0.5 );

		} )();
		const hRock = stoneRank( stoneLuma, stoneLevel ).toVar();
		// Where the scan was not read, the meadow's turf closes over the stone (its mask is 1 and
		// hides the layers below it): the blend leaves the masks as they are there rather than
		// reading the placeholder colour.
		const hb = ( mask: F, height: F, width: number ): F => hex ? select( scanned!, heightBlend( mask, height, float( width ) ), mask ) : mask;
		const rock = mix( vec3( 0.124, 0.13, 0.126 ), vec3( 0.188, 0.19, 0.176 ), vTint ).mul( mix( float( 0.7 ), shared.rockGain, smoothstep( - 0.5, 0.5, p.y ) ) ).toVar();
		rock.mulAssign( mix( vec3( 0.97, 0.99, 1.03 ), vec3( 1.025, 1.0, 0.965 ), fract( vTint.mul( 7.31 ) ) ) );
		// Desaturate the source to fit this limestone palette, but keep its correlated grain,
		// mineral stains and roughness. Fine colour follows the same relief as the normal map.
		const mineral = clamp( mix( vec3( stoneLuma ), stoneColor, 0.25 ).div( 0.22 ), vec3( 0.42 ), vec3( 1.7 ) );
		rock.mulAssign( mineral );
		rock.mulAssign( big.sub( 0.5 ).mul( 0.18 ).add( 0.98 ) );
		rock.assign( mix( rock, rock.mul( vec3( 1.12, 1.02, 0.86 ) ), smoothstep( 0.55, 0.85, big2 ).mul( 0.5 ) ) ); // faint ochre
		// runoff: faint darker streaks down the faces
		const along = mix( p.z, p.x, w.z.div( max( w.x.add( w.z ), 1e-3 ) ) );
		const streaks = texture( tex.gravel, vec2( along.mul( 0.55 ), p.y.mul( 0.018 ).add( along.mul( 0.002 ) ) ) ).a;
		const streaks2 = texture( tex.gravel, vec2( along.mul( 2.3 ).add( 0.37 ), p.y.mul( 0.04 ) ) ).a;
		const vert = float( 1 ).sub( smoothstep( 0.35, 0.75, abs( n0.y ) ) );
		const streak = smoothstep( 0.3, 0.7, streaks.mul( 0.65 ).add( streaks2.mul( 0.45 ) ) ).toVar();
		rock.mulAssign( mix( float( 1 ), mix( float( 0.83 ), float( 1.055 ), streak ), vert ) );
		if ( vegetation ) {

			// Each facet of the cliff has its own faint shade and a slight warm or cool cast, and
			// each bed its own (the strata); both stay faint, or the facets read as set stones.
			const facet = detail.x;
			rock.mulAssign( mix( float( 0.95 ), float( 1.06 ), facet ) );
			rock.mulAssign( mix( vec3( 0.98, 0.995, 1.02 ), vec3( 1.02, 1.0, 0.975 ), fract( facet.mul( 5.37 ) ) ) );
			const bed = fract( sin( floor( detail.z ).mul( 12.9898 ) ).mul( 43758.5453 ) );
			rock.mulAssign( mix( vec3( 0.97, 0.972, 0.975 ), vec3( 1.025, 1.018, 1.0 ), bed ) );
			// Parting lines: a fine dark seam at the beds' boundaries, only where the geometry
			// opens a groove there (a crease in the mesh), and faded once it is thinner than a
			// pixel so distant walls do not flicker.
			const seam = min( fract( detail.z ), float( 1 ).sub( fract( detail.z ) ) );
			const seamWidth = float( 0.03 ).add( betaWidth );
			const open = smoothstep( - 0.4, - 2.5, vCurv );
			const parting = float( 1 ).sub( smoothstep( 0, seamWidth, seam ) ).mul( float( 0.03 ).div( seamWidth ) ).mul( open );
			rock.mulAssign( float( 1 ).sub( parting.mul( vert ).mul( 0.35 ) ) );
			// A recent scar is the rock's unweathered inside: paler and a little warmer, without
			// the grey skin, lichen and stains the old faces around it carry (as in rockfall scar
			// inventories, where fresh scars stand out by colour long after their edges round).
			rock.assign( mix( rock, rock.mul( vec3( 1.24, 1.18, 1.07 ) ), fresh ) );
			// Under an overhang the stone stays dry: no runoff reaches it and it keeps a paler,
			// dusty skin.
			rock.assign( mix( rock, rock.mul( vec3( 1.07, 1.05, 1.0 ) ), shelter.mul( vert ) ) );
			// Runoff stains (the dark "ink stripes" of rock-dwelling cyanobacteria): water from the
			// soil runs down from the lip and spills from each ledge, in streaks that are darkest
			// at their head and wander down the face, gathered into the re-entrant corners. None
			// form under an overhang or on a recent scar. The stains lie under the moss and turf and
			// fill the same low ranks without taking a range of their own (the layer stack below), so
			// where both reach a face the moss hides a little more of them than a plain mix would;
			// they meet only in the narrow band where the stains begin under the lip.
			const flowHead = smoothstep( 0.02, 0.12, lipDepth ).mul( float( 1 ).sub( smoothstep( 0.8, 3.0, lipDepth ).mul( 0.8 ) ) );
			const gathered = float( 1 ).add( concave.mul( 1.5 ) );
			const ink = hb( smoothstep( 0.5, 0.72, float( 1 ).sub( streak ) ).mul( flowHead ).mul( gathered )
				.mul( float( 1 ).sub( shelter ) ).mul( float( 1 ).sub( fresh ) ).clamp( 0, 1 ), hRock, 0.3 ).toVar();
			rock.mulAssign( mix( vec3( 1 ), vec3( 0.42, 0.42, 0.4 ), ink.mul( vert ).mul( 0.85 ) ) );

		}
		// Worn arrises: the block edges catch a little light, never as an outline.
		rock.assign( mix( rock, min( rock.mul( 1.12 ), vec3( 0.5 ) ), convex.mul( vegetation ? 0.45 : 0.24 ) ) );
		rock.mulAssign( mix( float( 1 ), float( 0.9 ), concave ) );
		// lichen: pale crusts and dark spots on the dry stone, none yet on a recent scar
		const lichen = hb( H.a.mul( smoothstep( 0.4, 1.4, p.y ) ).mul( smoothstep( 0.3, 0.6, big2 ) ).mul( float( 1 ).sub( fresh ) ), float( 1 ).sub( hRock ), 0.3 );
		rock.assign( mix( rock, vec3( 0.42, 0.41, 0.33 ), lichen.mul( 0.45 ) ) );
		const spots = smoothstep( 0.62, 0.8, H.g ).mul( smoothstep( 0.45, 0.7, big ) ).mul( smoothstep( 0.5, 1.5, p.y ) ).mul( float( 1 ).sub( fresh ) );
		rock.mulAssign( float( 1 ).sub( spots.mul( 0.35 ) ) );
		if ( vegetation ) {

			// Orange and yellow lichens of the upper shore (Xanthoria, Caloplaca) in small patches
			// on the faces that look up, toward the lip, above the black zone the spray keeps wet.
			const orange = hb( smoothstep( 0.55, 0.8, H.g.mul( 0.55 ).add( big2.mul( 0.45 ) ) ).mul( smoothstep( 0.15, 0.6, n0.y ) )
				.mul( float( 1 ).sub( smoothstep( 0.3, 1.6, lipDepth ) ) ).mul( smoothstep( 1.4, 2.2, p.y ) ).mul( float( 1 ).sub( fresh ) ), float( 1 ).sub( hRock ), 0.25 );
			rock.assign( mix( rock, vec3( 0.42, 0.24, 0.06 ), orange.mul( 0.55 ) ) );

		}

		// The lip's stone, where it shows on the rim's bevel between the turf's stretches, and the
		// ledges just under it are the cliff's old top: greyed and darkened by their weathering skin
		// (LIP_SKIN) on their upward faces over the cliff's first LIP_LEDGE (m), never the pale band
		// and blocks the noon sun drew round the coast on bare upward stone.
		if ( vegetation ) {

			const ledge = float( 1 ).sub( smoothstep( LIP_LEDGE * 0.4, LIP_LEDGE, lipDepth ) );
			rock.mulAssign( mix( vec3( 1 ), vec3( ...LIP_SKIN ).mul( mix( float( 0.85 ), float( 1.1 ), hRock ) ), max( rimBlend, ledge ).mul( smoothstep( 0.3, 0.75, n0.y ) ) ) );

		}
		const up = n0.y;
		const Hg = H.g.toVar();
		const albedo = rock.toVar();
		const nW = nRock.toVar();
		const stoneRough = clamp( ( Fc ? Fc.b : rX.mul( ws.x ).add( rY.mul( ws.y ) ).add( rZ.mul( ws.z ) ) ).mul( 0.34 ).add( 0.62 ), 0.8, 0.98 );
		const rough = stoneRough.toVar();

		// The meadow ends at the upper shoulder; exposed walls keep their mineral surface.
		// Submerged boulders omit these nodes entirely.
		const canopy = float( 1 ).toVar();
		// the meadow floor scan's slope (in the top projection's frame) and roughness where it shows
		const floorSlope = vec2( 0 ).toVar(), floorRough = float( 0.94 ).toVar(), floorShare = float( 0 ).toVar();
		// how far the root layer's light holds (the blades' roots' key and sky, GRASS_ROOTS)
		const rootLight = float( 0 ).toVar();
		const swardCover = float( 0 ).toVar();
		// 1 where the ground marched the screen-space shade itself (under the sward)
		const marched = float( 0 ).toVar();
		if ( vegetation ) {

			const mossN = H.g.sub( 0.5 ).mul( 0.5 ).add( big.sub( 0.5 ).mul( 0.6 ) );
			const turfRim = smoothstep( MEADOW_MIN_UP, 0.97, up )
				.mul( smoothstep( topY.sub( MEADOW_MAX_DROP ), topY.sub( 0.12 ), p.y.add( mossN.mul( 0.15 ) ) ) ).mul( meadowTop );
			// The turf's own cover, which also sets the blades' shade over it, keeps the plain mask: only the visible mix of turf and stone follows the stone's relief
			// (`layer` below).
			const turfCover = max( legacyTurf, turfRim ).toVar();
			const mossC = mix( vec3( 0.025, 0.06, 0.015 ), vec3( 0.11, 0.2, 0.035 ), smoothstep( 0.2, 0.9, H.g ) ).toVar();
			mossC.mulAssign( smoothstep( 0.3, 0.8, texture( tex.heights, p.xz.mul( 0.9 ).add( p.y.mul( 0.5 ) ) ).g ).mul( 0.6 ).add( 0.7 ) );
			mossC.assign( mix( mossC, vec3( 0.2, 0.21, 0.06 ), smoothstep( 0.6, 0.9, big2 ).mul( 0.35 ) ) ); // sun-dried
			// Keep the same meadow bed on top, with a narrow blend into bare rock.
			const rimGrassC = mossC.toVar();
			If( max( turfCover, turf ).greaterThan( 0 ), () => {

				const q1 = p.xz.mul( 0.23 ), q2 = mat2( 0.8, - 0.6, 0.6, 0.8 ).mul( p.xz ).mul( 0.61 ).add( 0.37 );
				const c1 = texture( tex.heights, q1 ).level( float( 0 ) ).g, c2 = texture( tex.heights, q2 ).level( float( 0 ) ).g;
				// (the meadow map: RGB the lawn's colour, A the sward's depth, SwardField.ts)
				const meadow = texture( swardField, p.xz.div( MEADOW_EXTENT ).add( 0.5 ) ).level( float( 0 ) ).toVar();
				// The meadow's ground (GROUND_*): the grass-coloured ground with the scans' grain
				// (GRASS_GROUND), the soil where the sward parts and the groves' litter, darkened by the sward's depth there (the
				// meadow map's A) as the blades' roots are, and lit as they are (`rootLight`, the roots'
				// key and sky). The lip's bevel takes the scan's mean (GROUND_FLAT).
				const R = GRASS_ROOTS;
				// the sward's depth here (SwardField.ts), its darkening at the root (Grass.ts) and its
				// shade: full from the tall sward's mean depth up, `open` of it under the shortest turf
				const sward = meadow.a;
				const rootDark = float( 1 ).sub( sward.mul( R.darkening ) ).toVar();
				const shade = mix( float( R.open ), float( 1 ), clamp( sward.div( R.tall ), 0, 1 ) ).toVar();
				// the floor: the scans read from above through the hex tiles (their normal and roughness
				// beside their colour), the meadow's off the groves' litter, the groves' on it
				const flat = smoothstep( GROUND_FLAT[ 0 ], GROUND_FLAT[ 1 ], up ).toVar();
				const litter = swellAt!.litter;
				const lumaW = vec3( 0.2126, 0.7152, 0.0722 );
				const reads = ( [ 'meadow', 'grove' ] as const ).map( ( kind ) => {

					const G = GROUND_SCANS[ kind ], mean = vec3( ...G.mean );
					const c = vec4( mean, 1 ).toVar(), sl = vec2( 0 ).toVar(), r = float( 0.9 ).toVar();
					const wanted = kind === 'meadow' ? litter.lessThan( 1 ) : litter.greaterThan( 0 );
					If( flat.greaterThan( 0 ).and( wanted ), () => {

						hexReadScan( uvY, gxY, gyY, {
							colour: tex.scanAlbedo, normal: tex.scanDetail, layer: SCAN_LAYER[ kind ],
							scale: ( 1 / G.tile ) / TRIPLANAR_SCALE, rate: HEX_RATE, maxAngle: Math.PI,
							colourRest: vec4( mean, 1 ), normalRest: vec4( 0.5, 0.5, 0.9, 1 ), height: ( rgb ) => groundHeight( rgb, G.luma ), slope: stoneSlope,
						}, c, sl, r );

					} );
					const rgb = mix( mean, c.rgb, flat );
					const value = dot( rgb, lumaW ).max( 1e-4 );
					// its grain: the value over the scan's own mean (its 1x1 mip)
					const scanMean = texture( tex.scanAlbedo, vec2( 0.5 ) ).depth( float( SCAN_LAYER[ kind ] ) ).level( float( SCAN_TOP_MIP ) ).rgb;
					const grain = value.div( dot( scanMean, lumaW ).max( 1e-4 ) );
					return { rgb, value, grain, slope: sl, rough: r, height: groundHeight( c.rgb, G.luma ) };

				} );
				const [ open, under ] = reads;
				// the meadow scan's soil (GROUND_SCANS.meadow `gain`, GROUND_OCHRE)
				const O = GROUND_OCHRE, balanced = open.rgb.mul( vec3( ...O.balance ) );
				const green = smoothstep( O.green[ 0 ], O.green[ 1 ], open.rgb.g.sub( open.rgb.r ).div( open.value ) );
				const hue = mix( balanced.div( dot( balanced, lumaW ).max( 1e-4 ) ), vec3( ...OCHRE_SOIL ), green );
				const soilC = hue.mul( open.value ).mul( mix( float( 1 ), float( O.fleck ), green ) ).mul( GROUND_SCANS.meadow.gain );
				const inGrove = heightBlend( litter, open.height, float( GROVE_SEAM ) ).toVar();
				// the grass-coloured ground (GRASS_GROUND): the blades' mean, warmed, at `value` of their
				// value, in the turf's tone (the meadow map's R), mottled over metres and grained by the
				// meadow scan's value; the scan's soil where the sward parts (the meadow map's G low),
				// but not where the groves' litter stops it
				const GG = GRASS_GROUND;
				const blades = meadowMean.mul( shared.lawnGain.div( LAWN_GAIN ) );
				const grassY = dot( blades, lumaW ).mul( GG.value ).toVar();
				const warm = blades.mul( vec3( ...GG.balance ) );
				const tone = meadow.r.mul( 2 ).sub( 1 ).mul( LAWN_TONE ).add( 1 );
				// (a band-limited noise, its finest octave a quarter of a metre: read at level 0)
				const mottle = texture( tex.gravel, mat2( 0.6, 0.8, - 0.8, 0.6 ).mul( p.xz ).mul( GG.mottleRate ).add( 0.29 ) ).level( float( 0 ) ).a.sub( 0.5 ).mul( GG.mottle ).add( 1 );
				const grassC = warm.mul( grassY.div( dot( warm, lumaW ) ) ).mul( tone.mul( mottle ).mul( pow( open.grain, GG.grain ) ) );
				const parted = smoothstep( GG.bare[ 1 ], GG.bare[ 0 ], meadow.g ).mul( smoothstep( GG.litter, 0, litter ) );
				const bare = heightBlend( parted, open.height, float( GG.seam ) );
				// the groves' litter (GROVE_FLOOR): `value` times the grass ground's value, its hue, the
				// grove scan's grain and a share of its own hue's spread; its patches of groundcover
				// where a band-limited noise (the same as the mottle's, turned and moved) clears `cover`,
				// height-blended over the scan's relief
				const GF = GROVE_FLOOR, GC = GF.groundcover;
				const scanHue = under.rgb.div( under.value ).div( vec3( ...GROVE_SCAN_HUE ) );
				const litterGrain = pow( under.grain, GF.grain ).toVar();
				const litterC = vec3( ...GROVE_LITTER_HUE ).mul( mix( vec3( 1 ), scanHue, GF.spread ) ).mul( grassY.mul( GF.value ).mul( litterGrain ) );
				const coverC = vec3( ...GROUNDCOVER_HUE ).mul( grassY.mul( GC.value ).mul( litterGrain ) );
				const patch = texture( tex.gravel, mat2( - 0.8, 0.6, - 0.6, - 0.8 ).mul( p.xz ).mul( GC.rate ).add( 0.61 ) ).level( float( 0 ) ).a;
				const covered = heightBlend( smoothstep( GC.cover[ 0 ], GC.cover[ 1 ], patch ), under.height, float( GC.seam ) );
				const floorC = mix( mix( grassC, soilC, bare ), mix( litterC, coverC, covered ), inGrove ).toVar();
				const scanS = mix( open.slope, under.slope, inGrove ), scanR = mix( open.rough, under.rough, inGrove );
				const ground = floorC.mul( rootDark ).toVar();
				floorShare.assign( flat );
				floorSlope.assign( scanS );
				floorRough.assign( mix( float( 0.94 ), clamp( scanR, 0.75, 1 ), floorShare ) );
				// (none of the blades' light on the turf with `flags=bareGround`: bare ground's)
				if ( ! BARE_GROUND ) rootLight.assign( turfCover.mul( shade ) );
				swardCover.assign( turfCover );
				mossC.assign( mix( mossC, ground, turfCover ) );
				rimGrassC.assign( ground );
				// The blades above shade the turf: by their layer's shade, the law their own blades
				// take (Grass.ts `GRASS_SHADOW`, the material's `sunShade`, and here the rest of the
				// turf's own run, past what every pixel of the ground takes there); without it, through the crowns over it and
				// toward the light, so the clumps cast on the ground between them (the meadow map's B,
				// MeadowCanopy.ts `meadowGroundLight`), or without the crowns' heights
				// (`flags=groundCast:false`), through the canopy's depth there.
				if ( meadowRun ) canopy.assign( meadowLayerLight( meadowRun.y.sub( meadowRun.x ).mul( max( turfCover, turf ) ) ) );
				else if ( BARE_GROUND ) canopy.assign( 1 ); else if ( GROUND_CAST ) canopy.assign( meadowGroundLight( ( xz ) => texture( swardField, xz.div( MEADOW_EXTENT ).add( 0.5 ) ).level( float( 0 ) ).b.mul( CROWN_SCALE ), p, shared.sunDir ) );
				else canopy.assign( meadowCanopyLight( turfCover.mul( shade ).mul( TURF_CANOPY_DEPTH ), shared.sunDir ).mul( mix( float( 1 ), float( GRASS_ROOTS.key ), rootLight ) ) );
				// under overcast's deck the turf's shade in the key is its canopy's, the roots' share of
				// the sky that its ambient takes too (`roots` below; post/MeadowShade.ts `swardShadeRelease`):
				// the layer's shade gives way wherever the meadow's ground lies, the screen-space shade only
				// where the sward stands, as the bare soil and the groves' litter keep it as their contact shade
				canopy.assign( releaseSwardShade( canopy, mix( float( 1 ), rootsSky, rootLight ) ) );
				if ( GROUND_SHADE && ! BARE_GROUND ) {

					canopy.mulAssign( releaseSwardShade( meadowGroundShade( cameraViewMatrix.mul( vec4( p, 1 ) ).xyz ), float( 1 ), float( 1 ).sub( bare ).mul( float( 1 ).sub( inGrove ) ) ) );
					marched.assign( 1 );

				}
				Hg.assign( mix( Hg, c1.mul( 0.5 ).add( c2.mul( 0.5 ) ), legacyTurf ) );

			} );

			const nMoss = triNormal( unpack2( aX.zw ), unpack2( aY.zw ), unpack2( aZ.zw ), n0, w, float( 0.8 ) );
			const nFloor = normalize( vec3( n0.x.add( floorSlope.x.mul( sg.y ) ), n0.y, n0.z.add( floorSlope.y ) ) );
			const nBed = normalize( mix( mix( nMoss, n0, turfCover.mul( 0.2 ) ), nFloor, floorShare.mul( turfCover ) ) );

			// Moss and small greenery on the upper cliff, 0.2 - 1.2 m below each block's own top:
			// on the ledges and in the joints and hollows that hold water and grit, and on the bare
			// stumps of fallen columns, where the meadow's turf does not reach. The lower stone
			// stays exposed. Its colour is laid over everything below, last.
			const ledge = smoothstep( 0.1, 0.25, lipDepth ).mul( float( 1 ).sub( smoothstep( 0.85, 1.3, lipDepth ) ) );
			const stump = float( 1 ).sub( meadowTop ).mul( float( 1 ).sub( smoothstep( 0, 0.25, lipDepth ) ) ).mul( smoothstep( topY.sub( 1.3 ), topY.sub( 0.9 ), p.y ) );
			const hold = max( smoothstep( 0.45, 0.8, up ), concave.mul( smoothstep( - 0.3, 0.2, up ) ).mul( 0.85 ) ).mul( float( 1 ).sub( fresh ) );
			const patches = smoothstep( 0.4, 0.62, big2.mul( 0.45 ).add( H.g.mul( 0.35 ) ).add( streak.mul( 0.2 ) ) );
			const cliffMossMask = max( ledge, stump ).mul( hold ).mul( patches ).mul( float( 1 ).sub( turfCover ) ).toVar();

			// A shallow, broken root-soil cut follows the existing cap. Sampling only this shoulder
			// keeps the meadow and lower mineral faces intact; chips naturally interrupt the layer.
			// Its mask is found first, as the layers' blend below needs every mask of the stack.
			const cutting = soilUniforms.strength.greaterThan( 0 ).and( p.y.greaterThan( topY.sub( 0.4 ) ) ).and( up.lessThan( 0.97 ) );
			const cutMask = float( 0 ).toVar(), earth = vec3( 0 ).toVar();
			If( cutting, () => {

				const soil = texture( tex.soil, p.xz.div( SOIL_EXTENT ).add( 0.5 ) ).depth( float( 0 ) ).level( float( 0 ) ).toVar();
				const localTop = topY.add( soil.r.sub( 0.5 ).mul( SOIL_HEIGHT_RANGE ) );
				const depth = localTop.sub( p.y ).toVar();
				const thickness = mix( float( 0.07 ), float( 0.18 ), soil.g ).mul( soilUniforms.depth ).toVar();
				const grain = H.g.sub( 0.5 ).mul( 0.05 ).add( soil.a.sub( 0.5 ).mul( 0.04 ) );
				const upper = smoothstep( 0.014, 0.04, depth.add( grain.mul( 0.3 ) ) );
				const lower = float( 1 ).sub( smoothstep( thickness.mul( 0.72 ), thickness.add( 0.025 ), depth.add( grain ) ) );
				const shoulder = float( 1 ).sub( smoothstep( 0.72, 0.94, up ) );
				const exposure = smoothstep( 0.06, 0.4, soil.b );
				// Root-rich earth is darker at the grass contact. Below it, small mineral flecks
				// soften the change into bedrock without an artificial black seam or brown belt.
				const root = float( 1 ).sub( smoothstep( 0.12, 0.8, depth.div( thickness ) ) );
				earth.assign( mix( vec3( ...SOIL_PALETTE.cut ), vec3( ...SOIL_PALETTE.root ), root.mul( 0.45 ) ) );
				earth.mulAssign( mix( float( 0.88 ), float( 1.14 ), soil.a ).mul( H.r.mul( 0.35 ).add( 0.83 ) ) );
				const grit = smoothstep( 0.58, 0.73, H.r ).mul( smoothstep( 0.35, 1, depth.div( thickness ) ) ).mul( 0.38 );
				earth.assign( mix( earth, rock, grit ) );
				const stoneBreak = smoothstep( 0.4, 0.7, H.g ).mul( smoothstep( 0.55, 1.15, depth.div( thickness ) ) );
				// Inside the shared fringe, the same root bed is shaded by rimSoil below.
				// Crossfade the old shoulder cut instead of layering two earth bands.
				cutMask.assign( upper.mul( lower ).mul( shoulder ).mul( exposure ).mul( soilUniforms.strength )
					.mul( float( 1 ).sub( rimBlend ) ).mul( float( 1 ).sub( stoneBreak.mul( 0.55 ) ) ) );

			} );

			// The layers stack (from the top) cliff moss, root-soil cut, turf over the stone, or in
			// the rim's fringe cliff moss, rim turf, rim soil. Blended one by one on the same relief,
			// every layer would fill the same low points, and a lower one would keep only what its
			// mask has beyond the masks above it (about A - B where a plain mix shows A (1 - B)).
			// So each layer takes the next range of the stone's ranks in stacking order: the
			// cumulative cover down to it (c = above + mask (1 - above)) is height-blended, the
			// layer shows between that and the cover above it, and its mix factor is that share of
			// what the layers above leave. Each layer's visible cover then has the plain mix's
			// mean. One width serves a stack, so the cumulative covers nest.
			const cover = ( c: F ): F => hb( c, hRock, LAYER_WIDTH );
			const accumulate = ( above: F, mask: F ): F => above.add( mask.mul( float( 1 ).sub( above ) ) );
			const share = ( blended: F, aboveBlended: F ): F => clamp( blended.sub( aboveBlended ).div( max( float( 1 ).sub( aboveBlended ), 1e-4 ) ), 0, 1 );
			let mossCover: F = turfCover, cutCover: F = cutMask, cliffMoss: F = cliffMossMask;
			if ( hex ) {

				const toCut = accumulate( cliffMossMask, cutMask ).toVar();
				const cliffB = cover( cliffMossMask ).toVar(), cutB = cover( toCut ).toVar();
				cliffMoss = cliffB;
				cutCover = share( cutB, cliffB ).toVar();
				mossCover = share( cover( accumulate( toCut, turfCover ) ), cutB ).toVar();

			}

			albedo.assign( mix( rock, mossC, mossCover ) );
			nW.assign( normalize( mix( nRock, nBed, mossCover ) ) );
			rough.assign( mix( stoneRough, floorRough, mossCover ) );
			If( cutting, () => {

				albedo.assign( mix( albedo, earth, cutCover ) );
				const nSoil = normalize( mix( nRock, n0, 0.65 ) );
				nW.assign( normalize( mix( nW, nSoil, cutCover ) ) );
				rough.assign( mix( rough, float( 0.98 ), cutCover ) );

			} );
			if ( rimGround && rimGroundXform ) {

				// Preserve the existing meadow and bare mineral surface exactly outside the fringe.
				// The old detail maps supply subdued grains only; the shared field owns its boundary.
				If( rimBlend.greaterThan( 0 ), () => {

					// Both soil treatments retain one palette and the existing soil toggle/depth.
					// (the lip's root soil darker than the palette, RIM_SOIL_TONE: damp, shaded by the turf
					// over it, it read in the noon sun as a pale tan block in the lip)
					const soilC = mix( vec3( ...SOIL_PALETTE.root ), vec3( ...SOIL_PALETTE.cut ), smoothstep( 0.15, 0.85, H.r ) )
						.mul( H.g.sub( 0.5 ).mul( 0.16 ).add( 1 ) ).mul( RIM_SOIL_TONE );
					const soilNormal = normalize( mix( n0, nRock, 0.18 ) );
					let rimSoilCover: F = rimSoil, rimTurfCover: F = rimTurf;
					if ( hex ) {

						const toTurf = accumulate( cliffMossMask, rimTurf ).toVar();
						const turfB = cover( toTurf ).toVar();
						rimTurfCover = share( turfB, cliffMoss );
						rimSoilCover = share( cover( accumulate( toTurf, rimSoil ) ), turfB );

					}
					const groundC = mix( mix( rock, soilC, rimSoilCover ), rimGrassC, rimTurfCover );
					const groundN = normalize( mix( mix( nRock, soilNormal, rimSoilCover ), nBed, rimTurfCover ) );
					const groundRough = mix( mix( stoneRough, float( 0.96 ), rimSoilCover ), float( 0.94 ), rimTurfCover );
					albedo.assign( mix( albedo, groundC, rimBlend ) );
					nW.assign( normalize( mix( nW, groundN, rimBlend ) ) );
					rough.assign( mix( rough, groundRough, rimBlend ) );

				} );

			}

			const cliffMossC = mix( vec3( 0.04, 0.065, 0.02 ), vec3( 0.12, 0.155, 0.04 ), smoothstep( 0.25, 0.85, H.g ) );
			albedo.assign( mix( albedo, cliffMossC, cliffMoss ) );
			nW.assign( normalize( mix( nW, nMoss, cliffMoss ) ) );
			rough.assign( mix( rough, float( 0.93 ), cliffMoss ) );

		}
		// the whole scene's screen-space shade at the pixel, where the ground did not march its own
		// (post/MeadowShade.ts `SS_SHADOW`)
		if ( SS_SHADOW ) canopy.mulAssign( mix( screenShadowAt(), float( 1 ), marched ) );

		// --- rain: wet materials after Lagarde (see Wetness.ts). The mask starts above the highest
		// tidal modulation, preserving that band and all submerged detail exactly; downward-facing
		// overhangs receive less rain. Dry weather skips the branch, so it renders as before.
		const water = float( 0 ).toVar(), puddle = float( 0 ).toVar(), flow = float( 0 ).toVar(), runShade = float( 1 ).toVar();
		const exposure = smoothstep( 0.65, 1.0, p.y.sub( shared.waterLevel ) ).mul( smoothstep( - 0.6, 0.1, up ) ).toVar();
		If( shared.wetness.greaterThan( 0 ).and( exposure.greaterThan( 0 ) ), () => {

			const wetness = clamp( shared.wetness, 0, 1 ).toVar();
			// The pores fill first and a film forms on top; drying runs the other way, so the
			// gloss goes first and the darker stain lingers.
			const soak = smoothstep( 0, 0.45, wetness ).mul( exposure ).toVar();
			const film = smoothstep( 0.35, 0.75, wetness ).mul( exposure ).toVar();
			const porosity = wetPorosity( rough ).toVar();
			// Turf and moss darken within small limits; the blades above hide most of the bed.
			const plant = mix( float( 1 ), float( 0.45 ), turf ).toVar();
			// Water running down the steep faces in runnels, which stay damp after the rain.
			const run = vegetation ? runnels( { tex: tex.gravel, p, n: n0, dpx, dpy, warp: big2, time: shared.time, rain: shared.rain } ).mul( float( 1 ).sub( turf ) ).toVar() : vec2( 0 );
			// The runnels' water and stain keep to the stone's grooves.
			if ( vegetation && hex ) run.assign( vec2( hb( run.x, hRock, 0.35 ), run.y ) );
			// Standing water in level hollows, and the soaked ground it has just left.
			const pool = vec3( 0 ).toVar();
			// Standing water collects on the meadow and the stumps' tops, not on narrow ledges.
			const level = smoothstep( 0.93, 0.985, up ).mul( exposure ).mul( vegetation ? smoothstep( 0.3, 0.18, lipDepth ) : float( 1 ) ).toVar();
			If( level.greaterThan( 0.001 ), () => {

				pool.assign( puddleField( p.xz, wetness, Hg ).mul( vec3( level, 1, level ) ) );

			} );
			// Rain falls on the faces that look up; a wall takes less of it between its runnels,
			// so the water's paths stand out darker against a damp face.
			const face = mix( float( 0.5 ), float( 1 ), smoothstep( 0.1, 0.6, up ) );
			const soaked = max( max( porosity.mul( soak ).mul( face ), run.x.mul( soak ) ).mul( plant ), max( pool.x, pool.z ).mul( mix( float( 1 ), float( 0.8 ), turf ) ) );
			albedo.assign( wetAlbedo( albedo, soaked ) );
			// The runnels darken further, beyond tidewater's stains (40 %): water streaming over the
			// stone and the dark stain it leaves.
			albedo.mulAssign( float( 1 ).sub( run.x.mul( soak ).mul( RUNNEL_DARKENING ) ) );
			// On a wall in shade or under an overcast the sky's specular reflection from the wet
			// stone is about as bright as its diffuse light, and the grade's black lift adds a
			// floor, so a darker albedo alone left the runnels invisible in the rain. The water's
			// paths also return less of the sky's light (an art-directed shade on the ambient and
			// sky reflection), except where a slug of water running down them catches the sky.
			runShade.assign( float( 1 ).sub( run.x.mul( soak ).mul( RUNNEL_SHADE ).mul( float( 1 ).sub( run.y ) ) ) );
			rough.assign( wetRoughness( rough, porosity, soak ) );
			// A water film on bare stone that faces the sky and in the runnels; the turf only glistens.
			const filmCover = max( film.mul( smoothstep( 0.25, 0.75, up ) ), max( run.x.mul( film ), run.y.mul( exposure ) ) )
				.mul( float( 1 ).sub( turf ) ).toVar();
			flow.assign( run.y.mul( exposure ).mul( float( 1 ).sub( turf ) ) );
			rough.assign( mix( rough, float( FILM_ROUGHNESS ), filmCover ) );
			rough.assign( mix( rough, max( float( 0.55 ), rough.mul( 0.8 ) ), film.mul( turf ) ) );
			// Lagarde 3b: a thin layer fills the fine relief, so the normal leans to the geometry's.
			nW.assign( normalize( mix( nW, n0, filmCover.mul( 0.5 ) ) ) );
			water.assign( filmCover );
			If( pool.x.greaterThan( 0.001 ), () => {

				// Standing water: water's smooth surface, ringed by the falling rain, over drowned
				// ground that the deeper water darkens further. Shallow edges keep a little of
				// the ground's relief (Lagarde 3b), so the waterline reads against the stone.
				const ripples = puddleRipples( p.xz, shared.time, shared.rain, footprint ).toVar();
				const surface = normalize( vec3( ripples.x.negate(), 1, ripples.y.negate() ) );
				nW.assign( normalize( mix( nW, surface, pool.x.mul( mix( float( 0.75 ), float( 1 ), pool.y ) ) ) ) );
				// Silt stirred into the water and the drowned blades' shade hide the bed: it sinks
				// toward a dull, dark brown-olive, so the sky reflected above it carries the colour
				// and the puddle no longer reads as a patch of greener turf.
				const bed = mix( float( 0.6 ), float( 0.22 ), pool.y ).toVar();
				albedo.assign( mix( albedo, mix( albedo, vec3( dot( albedo, vec3( 0.3, 0.5, 0.2 ) ) ).mul( vec3( 1.1, 1, 0.75 ) ), 0.6 ).mul( bed ), pool.x ) );
				// Rings below a pixel's footprint roughen the water instead.
				rough.assign( mix( rough, ripples.z.mul( 0.6 ).add( 0.02 ), pool.x ) );
				water.assign( max( water, pool.x ) );
				puddle.assign( pool.x );
				// The drowned blades no longer shade the water's surface.
				canopy.assign( mix( canopy, float( 1 ), pool.x.mul( 0.7 ) ) );

			} );

		} );

		// --- the tidal band: wet, dark, glossy; green-black algae just below the waterline;
		// silt and sediment on the submerged ledges
		const wl = shared.waterLevel.add( sin( shared.time.mul( 0.9 ).add( p.x.mul( 0.4 ) ).add( p.z.mul( 0.3 ) ) ).mul( 0.08 ) );
		const wet = float( 1 ).sub( smoothstep( 0, 0.32, p.y.sub( wl ).sub( 0.06 ).sub( H.r.sub( 0.5 ).mul( 0.25 ) ) ) );
		const algae = float( 1 ).sub( smoothstep( - 0.05, 0.35, p.y.sub( wl ).add( Hg.sub( 0.5 ).mul( 0.5 ) ) ) );
		const deep = vegetation ? smoothstep( 0.35, 1.65, wl.sub( p.y ) ) : smoothstep( - 0.6, - 2.5, p.y );
		const algaeC = mix( vec3( 0.035, 0.05, 0.02 ), vec3( 0.09, 0.085, 0.045 ), deep );
		const silt = smoothstep( 0.35, 0.8, up ).mul( smoothstep( - 0.4, - 1.2, p.y ) );

		// Patchy growth leaves mineral faces between damp crevices on the island. Reuse
		// its broad stains and local grain so the tide does not paint an opaque collar.
		// Offshore boulders keep their established sediment and algae treatment.
		const colony = smoothstep( 0.35, 0.65, big2.mul( 0.65 ).add( Hg.mul( 0.35 ) ).add( concave.mul( 0.06 ) ) );
		const algaeCoverage = algae.mul( vegetation
			? mix( float( 0.65 ), float( 0.24 ), deep ).mul( mix( float( 0.28 ), float( 1 ), colony ) )
			: mix( float( 0.85 ), float( 0.5 ), deep ) );
		albedo.assign( mix( albedo, algaeC.mul( H.r.mul( 0.6 ).add( 0.7 ) ), algaeCoverage ) );
		albedo.assign( mix( albedo, vec3( 0.077, 0.067, 0.049 ).mul( FLOOR_ALBEDO.gain ), silt.mul( 0.7 ) ) );
		// Below the tidal band the stone wears an olive-brown film of algae and diatoms on the faces
		// that catch the light, in patches, so submerged stones and the underwater cliff separate
		// from the sand by hue as well as value. Each stone also keeps more of its own shade.
		const subtidal = smoothstep( - 0.3, - 0.8, p.y.sub( wl ) );
		const film = subtidal.mul( smoothstep( 0.15, 0.7, up ) )
			.mul( smoothstep( 0.3, 0.62, big2.mul( 0.55 ).add( Hg.mul( 0.3 ) ).add( vTint.mul( 0.25 ) ) ) );
		albedo.mulAssign( mix( vec3( 1 ), vec3( 0.84, 0.74, 0.46 ), film ) );
		if ( ! vegetation ) albedo.mulAssign( mix( vec3( 0.8, 0.83, 0.86 ), vec3( 1.18, 1.12, 1.0 ), vTint ) );
		if ( vegetation ) {

			// Above the damp band, the black zone of spray-fed lichen (Verrucaria) reaches 0.4 -
			// 1.4 m up the walls, higher where the coast meets the swell; its upper edge is jagged
			// from facet to facet and frayed, with the grey stone showing through in places.
			const reach = float( 0.4 ).add( detail2.y.mul( 0.7 ) ).add( fract( detail.x.mul( 3.7 ) ).mul( 0.3 ) ).add( H.r.sub( 0.5 ).mul( 0.3 ) );
			const spray = hb( float( 1 ).sub( smoothstep( reach.sub( 0.16 ), reach.add( 0.05 ), p.y.sub( wl ) ) ), hRock, 0.25 );
			const crust = mix( float( 0.55 ), float( 1 ), smoothstep( 0.35, 0.75, H.g.mul( 0.6 ).add( big.mul( 0.4 ) ) ) );
			albedo.mulAssign( mix( vec3( 1 ), vec3( 0.62, 0.63, 0.6 ), spray.mul( crust ).mul( float( 1 ).sub( wet ) ) ) );
			// The notch's floor and the ledges in the spray hold water, weed and grit: darker still.
			albedo.mulAssign( mix( float( 1 ), float( 0.68 ), max( spray, wet ).mul( smoothstep( 0.3, 0.75, up ) ) ) );

		}
		albedo.mulAssign( mix( float( 1 ), float( vegetation ? 0.66 : 0.5 ), wet.mul( float( 1 ).sub( algae.mul( 0.5 ) ) ) ) );
		// The wave-washed band glistens on the walls. On a face that looks up at the sky (a sloping
		// foot or ledge in a gully at the waterline) the same gloss mirrored the bright low sky as
		// a pale sheet streaked by the stone's relief, which read from afar as water running down
		// the gully, so it fades out on such faces; they keep the band's darker, damp albedo. The
		// wall's own gloss stays broad (0.5): sharper, at a grazing view it mirrored the environment's
		// lower half as a thin blue line along the waterline.
		const washed = wet.mul( float( 1 ).sub( deep ) ).mul( float( 1 ).sub( smoothstep( 0.2, 0.55, up ) ) );
		rough.assign( mix( rough, float( 0.5 ), washed ) );

		// The island's jointed wall occludes much of its own sky; a share of that occlusion keeps
		// the shadowed blocks airy while the crevices stay dark, though never black: the whole
		// product keeps the floor every receiver of the screen's occlusion keeps (post/GTAO.ts
		// AO_FLOOR).
		// A pocket keeps less of it again: the sky it sees past its rim is what lights it in the shade,
		// and at full occlusion a small one read as a black hole.
		// The turf's roots keep the share of the sky the blades over them leave (GRASS_ROOTS.sky). The
		// screen-space occlusion (post/GTAO.ts) sees those same blades, so the two are estimates of one
		// loss: the turf takes the stronger of them, and the blades close its sky once; off the turf it
		// takes the screen's in full. The vertex occlusion, that and the rest are one product held at
		// the floor every receiver keeps.
		const roots = mix( float( 1 ), rootsSky, rootLight );
		const ao = floorOcclusion( ( vegetation ? mix( float( 1 ), clamp( vAO, 0, 1 ), float( 0.7 ).sub( pocket.mul( 0.3 ) ) ) : clamp( vAO, 0, 1 ) )
			.mul( mix( float( 1 ), mix( float( 0.72 ), float( 0.88 ), pocket ), concave ) ).mul( runShade ).mul( GTAO ? min( roots, screenAOAt() ) : roots ) );
		return Surface( albedo, nW, rough, ao, canopy, water, puddle, flow, swardCover );

	} )();

}

// Wave ripples on the sand. The swell's to-and-fro over the shelf rakes the sand into ripples some
// 15 - 25 cm apart whose crests run along the coast, as the waves' own crests do once they feel the
// floor, and fine dark detritus settles in their troughs (`trough`: the darkening against the crests),
// so a sunlit floor shows them from above even at noon. Here the crests follow the contours of the shoreline's distance, wandering by two
// octaves of the detail textures' low-frequency variation (`warp`: its scale per metre and its phase
// shift in cycles, twice), with rounded troughs and sharp crests ( ( 1 + cos ) / 2 ) squared, of a
// height `steepness` times their spacing (slopes up to about 0.5; real wave ripples stand 0.15 - 0.2
// of their spacing). They stand on the bare sand only,
// strongest on the shelf and gone below `depth` (m under the sea), where the swell no longer stirs
// the floor; they die out against the cliff's foot (`wall`, m) and where the contours turn sharply
// (the crease of the distance field in a cove's middle, where two stretches of coast meet), and
// below a pixel they give way to their mean. They replace the detail texture's tiled ripples, which
// ran one way across the whole world, along the coast on one side of the island and across it on the
// other, and showed as sparse grooves a metre apart in a low sun.
const RIPPLE = { spacing: 0.2, steepness: 0.13, trough: 0.28, depth: [ 5, 8 ], wall: [ 0.6, 2.2 ], warp: [ 0.11, 6, 0.37, 1.2 ] } as const;

function seabedSurface( { tex, shore, shared }: Ctx, shoreXform: THREE.Node<'vec4'> ) {

	return Fn( () => {

		const p = positionWorld;
		const n0 = normalize( normalWorldGeometry ).toVar();
		const S = 0.27; // detail tile ~3.7 m
		const q = p.xz.mul( S );
		const H = texture( tex.heights, q ).toVar();
		const A = texture( tex.normalsA, q.mul( 0.7 ).add( 0.13 ) );
		const B = texture( tex.normalsB, q );
		const big = texture( tex.normalsB, p.xz.mul( 0.013 ).add( 0.2 ) ).a;
		const shoreAt = ( at: V2 ) => texture( shore, at.sub( shoreXform.xy ).mul( shoreXform.zw ) ).r;
		const sd = shoreAt( p.xz ).toVar();
		// seagrass cover and pale-sand share, baked per vertex without repetition (seabedBeds)
		const bed = attribute<'vec2'>( 'bed', 'vec2' );

		// (the detail texture's tiled ripples left out at their mean, 0.5: the ripples are RIPPLE's)
		const pdx = dFdx( p.xz ).toVar(), pdy = dFdy( p.xz ).toVar();
		const [ w1, s1, w2, s2 ] = RIPPLE.warp;
		const lowNoise = texture( tex.normalsB, p.xz.mul( w1 ).add( 0.41 ) ).a.sub( 0.5 ).toVar();
		// the gravel's level is worked out here, where derivatives may be taken: the stones are sampled
		// inside the apron's branch only (SeabedLook.ts), so the rest of the floor does not pay for them
		const texelsPerPixel = log2( max( length( pdx ), length( pdy ) ).mul( DETAIL_SIZE ) ).toVar();
		const gravelAt = ( rate: number, c: number, sn: number, at: number ) => texture( tex.gravel, mat2( c, sn, - sn, c ).mul( p.xz ).mul( rate ).add( at ) ).level( texelsPerPixel.add( Math.log2( rate ) ) );
		const look = seabedAlbedo( bed, big, vec3( H.x, H.y, 0.5 ), sd, lowNoise, gravelAt );
		const albedo = look.albedo.toVar(), grass = look.grass.toVar(), rubble = look.rubble.toVar(), relief = look.relief.toVar();

		// --- wave ripples (RIPPLE): the contours' direction over a metre and a bit (across a crease
		// the differences cancel), the crests' phase and its gradient in world xz from the screen's
		// derivatives, which carry the wander too
		const e = 0.6;
		const across = vec2( shoreAt( p.xz.add( vec2( e, 0 ) ) ).sub( shoreAt( p.xz.sub( vec2( e, 0 ) ) ) ),
			shoreAt( p.xz.add( vec2( 0, e ) ) ).sub( shoreAt( p.xz.sub( vec2( 0, e ) ) ) ) ).div( 2 * e );
		const wander = lowNoise.mul( s1 )
			.add( texture( tex.normalsB, p.zx.mul( w2 ).add( 0.17 ) ).a.sub( 0.5 ).mul( s2 ) );
		const phase = sd.div( RIPPLE.spacing ).add( wander ).toVar();
		const fdx = dFdx( phase ).toVar(), fdy = dFdy( phase ).toVar();
		const det = pdx.x.mul( pdy.y ).sub( pdx.y.mul( pdy.x ) );
		const safeDet = select( abs( det ).lessThan( 1e-12 ), float( 1e-12 ), det );
		const grad = vec2( fdx.mul( pdy.y ).sub( fdy.mul( pdx.y ) ), fdy.mul( pdx.x ).sub( fdx.mul( pdy.x ) ) ).div( safeDet );
		const u = fract( phase ).mul( 2 * Math.PI ).toVar();
		const crest = cos( u ).mul( 0.5 ).add( 0.5 ).toVar();
		const height = crest.mul( crest );
		const dHeight = sin( u ).mul( crest ).mul( - 2 * Math.PI ); // d height / d phase
		const depth = shared.waterLevel.sub( p.y );
		const site = float( 1 ).sub( smoothstep( RIPPLE.depth[ 0 ], RIPPLE.depth[ 1 ], depth ) ).mul( smoothstep( RIPPLE.wall[ 0 ], RIPPLE.wall[ 1 ], sd ) )
			.mul( smoothstep( 0.55, 0.85, length( across ) ) ).mul( float( 1 ).sub( grass ) ).mul( float( 1 ).sub( rubble ) ).toVar();
		const resolved = float( 1 ).sub( smoothstep( 0.18, 0.4, max( abs( fdx ), abs( fdy ) ) ) ).toVar();
		const rippleSlope = grad.mul( dHeight.mul( RIPPLE.steepness * RIPPLE.spacing ) ).mul( site.mul( resolved ) );
		// (the troughs darker and the crests clean, about the sand's own colour on the mean, 5/8 of a
		// full trough, so the shallows keep their tone; under a pixel, that mean)
		albedo.mulAssign( float( 1 ).sub( float( 1 ).sub( height ).sub( 0.625 ).mul( resolved ).mul( site ).mul( RIPPLE.trough ) ) );

		// the sand's fine grain from the detail texture, and the ripples
		const grain = vec2( B.r.mul( 2 ).sub( 1 ), B.g.mul( 2 ).sub( 1 ) ).mul( 0.06 );
		const nSand = normalize( vec3( grain.x.sub( rippleSlope.x ), 1, grain.y.sub( rippleSlope.y ) ) );
		// cobbles and the meadows' clumps: the detail texture's rounded lumps (its moss cushions). The
		// rock's own normal drew its long thin fractures across the sand wherever the apron thinned
		// out, as meandering grooves no cobble field has.
		const nRock = normalize( vec3( A.b.mul( 2 ).sub( 1 ), 0, A.a.mul( 2 ).sub( 1 ) ).mul( 1.3 ).add( vec3( 0, 1, 0 ) ) );
		// keep the macro slope of the mesh
		const t = normalize( n0.cross( vec3( 0, 0, 1 ) ) );
		const b = t.cross( n0 );
		// the stones' rounded sides, from the screen derivatives of their height after the branch, in
		// world xz as the ripples' are: no sample of its own, and it lights one side of each stone
		const rdx = dFdx( relief ).toVar(), rdy = dFdy( relief ).toVar();
		const stoneSlope = vec2( rdx.mul( pdy.y ).sub( rdy.mul( pdx.y ) ), rdy.mul( pdx.x ).sub( rdx.mul( pdy.x ) ) ).div( safeDet ).mul( 0.04 );
		const dn = mix( nSand, nRock, max( rubble, grass.mul( 0.6 ) ) ).sub( vec3( stoneSlope.x, 0, stoneSlope.y ) );
		const nW = normalize( t.mul( dn.x ).add( n0.mul( dn.y ) ).add( b.mul( dn.z ) ) );

		const detailAO = mix( float( 1 ), float( 0.85 ), rubble ).mul( mix( float( 0.8 ), float( 1 ), H.b ) );
		// Baked solid contacts and procedural rubble can overlap: retain the stronger estimate.
		const ao = min( attribute<'float'>( 'ao', 'float' ), detailAO );
		return Surface( albedo, nW, float( 0.92 ), ao, float( 1 ), float( 0 ), float( 0 ), float( 0 ), float( 0 ) );

	} )();

}

// The light below the surface is the shared underwater model (lighting/Underwater.ts): the sun
// path through the water column and the dimmer ambient. Above the water the terrain adds its
// own: the meadow's canopy shade on the key. The light the sea sends onto the rock above it is the
// ground bounce's (lighting/GroundBounce.ts).

/** The land's model: the ambient diffuse takes the sward's tint (materials/SwardTint.ts) by the
 * turf's cover, 1 + ( tint - 1 ) cover, exactly 1 at a white tint. The metering's ambient
 * leaves it out. */
class TurfLightingModel extends UnderwaterLightingModel {

	tint: V3;
	cover: F;

	constructor( light: UnderwaterLight, options: UnderwaterModelOptions, tint: V3, cover: F ) {

		super( light, options );
		this.tint = tint;
		this.cover = cover;

	}

	indirect( builder: THREE.NodeBuilder ): void {

		super.indirect( builder );
		const { reflectedLight } = builder.context as unknown as { reflectedLight: { indirectDiffuse: V3 } };
		reflectedLight.indirectDiffuse.mulAssign( this.tint.sub( 1 ).mul( this.cover ).add( 1 ) );

	}

}

type TerrainVariant = ( hex: boolean, from?: THREE.NodeMaterial ) => THREE.MeshStandardNodeMaterial;

export function makeTerrainMaterial( kind: 'cliff' | 'seabed', tex: DetailTextures, shared: Shared, waveMaps: WaveMaps, shore: FieldTexture, { topY = 3.1, vegetation = true, rimGround, rimGroundXform, hex }: TerrainOptions = {} ): THREE.MeshStandardNodeMaterial {

	const topYU = uniform( topY );
	const ctx: Omit<Ctx, 'hex'> = { tex, shared, topY: topYU, vegetation, shore, rimGround, rimGroundXform: rimGroundXform ? uniform( rimGroundXform ) : undefined };
	if ( kind === 'seabed' ) return buildTerrainMaterial( kind, { ...ctx, hex: false }, waveMaps );
	// For an A/B inside one page, each cliff material can hand over its other variant (built on
	// first use, sharing the uniforms) with the nodes RefractedSun installed on it:
	//   s.scene.traverse( ( o ) => { const v = o.material?.userData.terrainVariant; if ( v ) o.material = v( on, o.material ); } )
	const variants = new Map<boolean, THREE.MeshStandardNodeMaterial>();
	const variant: TerrainVariant = ( on, from ) => {

		let mat = variants.get( on );
		if ( ! mat ) {

			mat = buildTerrainMaterial( kind, { ...ctx, hex: on }, waveMaps );
			mat.userData.terrainVariant = variant;
			variants.set( on, mat );

		}
		if ( from && from !== mat && ( mat.receivedShadowNode !== from.receivedShadowNode || mat.receivedShadowPositionNode !== from.receivedShadowPositionNode ) ) {

			mat.receivedShadowPositionNode = from.receivedShadowPositionNode;
			mat.receivedShadowNode = from.receivedShadowNode;
			mat.needsUpdate = true;

		}
		return mat;

	};
	// URL option, read at load: terrainHex=0 builds the plain tiling with smooth masks.
	if ( typeof location !== 'undefined' && new URLSearchParams( location.search ).get( 'terrainHex' ) === '0' ) debugFlags.terrainHex = false;
	return variant( hex ?? debugFlags.terrainHex !== false );

}

function buildTerrainMaterial( kind: 'cliff' | 'seabed', ctx: Ctx, waveMaps: WaveMaps ): THREE.MeshStandardNodeMaterial {

	const { shared, vegetation } = ctx;
	const topYU = ctx.topY;
	const mat = new THREE.MeshStandardNodeMaterial( { roughness: 0.85, metalness: 0 } );
	// the island's ground's two runs under the meadow's layer (`sunShade` below, and the turf's in
	// `cliffSurface`), by the surface's normal's height as well (the land's chunks stand untransformed,
	// so the geometry's normal is the world's)
	const key = liftKeyWorld( shared.sunDir );
	const meadowRun = GRASS_SHADOW && kind !== 'seabed' && ctx.vegetation ? varying( meadowGroundRuns( positionWorld, key, normalGeometry.y ), 'vMeadowLayer' ) : null;
	const call = kind === 'seabed' ? seabedSurface( ctx, shared.shoreXform ) : cliffSurface( { ...ctx, meadowRun } );
	const surf = ( call as unknown as { toVar( name: string ): SurfaceNode } ).toVar( 'surf' );
	mat.colorNode = surf.get( 'albedo' );
	mat.roughnessNode = surf.get( 'rough' );
	mat.normalNode = normalize( cameraViewMatrix.mul( vec4( surf.get( 'normal' ), 0 ) ).xyz );
	mat.aoNode = surf.get( 'ao' );
	// the screen-space ambient occlusion (post/GTAO.ts): the sea floor takes it through its lighting
	// model, the island's ground in its own occlusion (`cliffSurface`, against the turf's roots)
	if ( kind === 'seabed' ) receiveScreenAO( mat );
	// the island's ground lies in the meadow's layer's shade on its lifted key, the sun's map's
	// direction (Grass.ts `meadowLayerLight`, KeyLift.ts `liftKeyWorld`):
	// the turf under the blades and the ground beside the meadow where the light comes over it (over
	// a shadow filter's footprint; a face under the meadow's lip whose light goes out over the sea
	// takes none, `meadowGroundRuns`) by the one law the blades take, at the run of their own ray under
	// the layer's top, near the eye and far alike. Its run is worked out per vertex, as the fragment
	// stage already samples WebGPU's sixteen textures. The turf's run differs only along the rim, and
	// which pixels are turf is known in the fragment stage alone: every pixel takes the first run here
	// and the turf the rest of its own in its canopy, so the stone beside it stays as it was. Under
	// overcast's deck it lets go, and the turf takes its canopy's share instead (`cliffSurface`,
	// post/MeadowShade.ts `swardShadeRelease`).
	if ( meadowRun ) mat.userData.sunShade = releaseSwardShade( meadowLayerLight( meadowRun.x ) );
	// A water film or puddle reflects with water's specular reflectance instead of the stone's.
	const f0 = mix( float( DRY_F0 ), float( WATER_F0 ), surf.get( 'water' ) ).toVar();
	// Seen from above, a puddle mirrors only 2 % of the sky, about as much light as the dark ground
	// around it returns, so physically it nearly vanishes into the turf. Art direction lets
	// standing water (and the slugs of water running down the runnels) mirror the sky as a
	// brighter interface: the sky's own brightness and colour, through Schlick's Fresnel, so the
	// reflection still grows toward grazing view and the bed below loses what it gains (the
	// diffuse layer keeps only 1 - F). specularColor drives the sky reflection and that energy
	// split; specularColorBlended drives the key light's glint, which stays at water's own F0 so
	// the sun's mirror image does not flare twelve times brighter.
	// The lifted reflectance also flattens Fresnel's contrast between a rain ring's two flanks,
	// which is what lets the rings read: the flank tilted toward the eye mirrors less sky and
	// shows the dark bed, the one tilted away mirrors more. Steepen that response with the ring's
	// tilt against the level surface (zero on calm water, so a still puddle keeps PUDDLE_F0).
	const view = normalize( cameraPosition.sub( positionWorld ) );
	const tilt = dot( surf.get( 'normal' ), view ).sub( view.y );
	const puddleF0 = clamp( float( PUDDLE_F0 ).mul( float( 1 ).sub( tilt.mul( RING_GAIN ) ) ), WATER_F0, 0.6 );
	const f0Sky = mix( mix( f0, puddleF0, surf.get( 'puddle' ) ), FLOW_F0, surf.get( 'flow' ) );
	( mat as unknown as { setupSpecular: () => void } ).setupSpecular = () => {

		specularColor.assign( vec3( f0Sky ) );
		specularColorBlended.assign( vec3( f0 ) );
		specularF90.assign( 1 );

	};

	const light = underwaterLight( shared, waveMaps, { aboveSun: vec3( surf.get( 'canopy' ) ), specular: STONE_UNDER_WATER, seaKey: keySeaShare( positionWorld ) } );
	// the ambient volume (lighting/AmbientSample.ts): degree 2 on the plateau, the cliffs and the
	// stones, under the water too (lighting/Underwater.ts). At degree 1
	// the volume's directionality boost turns the light the lit meadow bounces up against level
	// ground in its shade, darkening it (AmbientRelight.ts, known limits); degree 2's quadratic band
	// gives it back. None on the sea floor, which lies under the water, where the environment's
	// light is read anyway (the volume's texture would take a binding of its fragment stage for the
	// few points above it)
	const ambient = kind === 'seabed' ? null : { bands: 2 as const, kind: ctx.vegetation ? 'terrain' : 'stones' };
	( mat as unknown as { setupLightingModel: () => THREE.LightingModel } ).setupLightingModel = () => ( ambient?.kind === 'terrain' ? new TurfLightingModel( light, { ambient }, shared.swardTint, surf.get( 'sward' ) ) : new UnderwaterLightingModel( light, { ambient } ) );
	writeMeter( mat );
	mat.userData.refractedSolarReceiver = true;
	mat.userData.refractedSolarFloor = kind === 'seabed';
	mat.userData.topY = topYU;
	// whether the terrain carries the meadow's detail; not `userData.vegetation`, which tags the plants' materials (markVegetation)
	mat.userData.meadowDetail = vegetation;
	return mat;

}
