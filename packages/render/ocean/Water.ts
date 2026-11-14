/*!
 * Portions adapted from tidewater by Daniel Greenheck (https://github.com/dgreenheck/tidewater).
 * SPDX-FileCopyrightText: Copyright (c) 2026 DRG Software Solutions LLC
 * SPDX-License-Identifier: MIT
 *
 * hash22 is "Hash without Sine" by David Hoskins (https://www.shadertoy.com/view/4djSRW).
 * SPDX-FileCopyrightText: Copyright (c) 2014 David Hoskins
 * SPDX-License-Identifier: MIT
 */

import * as THREE from 'three/webgpu';
import {
	Fn, If, Loop, Break, texture, textureLoad, textureSize, uniform, varying, positionGeometry, positionWorld, positionPrevious,
	cameraPosition, cameraViewMatrix, cameraProjectionMatrix, modelViewMatrix, modelViewProjection, cameraProjectionMatrixInverse, cameraWorldMatrix, screenUV,
	float, int, bool, ivec2, vec2, vec3, vec4, mix, smoothstep, clamp, length, normalize, dot, max, min, sqrt, exp, log2,
	abs, fwidth, reflect, refract, select, step, dFdx, dFdy, perspectiveDepthToViewZ, cameraNear, cameraFar, luminance, property,
} from 'three/tsl';
import type { Sky } from '../sky/Sky.ts';
import { FFT_SIZE, NEAR_RIPPLES, type OceanFFT } from './OceanFFT.ts';
import { COX_MUNK } from './OceanSpectrum.ts';
import type { ShoreWaves } from './ShoreWaves.ts';
import type { StormSea } from './StormSea.ts';
import type { SeaDetail } from './SeaDetail.ts';
import { REFRACTION_GUARD } from './Refraction.ts';
import { waveDamping } from './WaveDamping.ts';
import type { Shared } from '../shared.ts';
import type { SunShadow } from '../lighting/SunShadow.ts';
import { liftKeyWorld } from '../lighting/KeyLift.ts';
import { refractedSunBeamScaleNode } from '../lighting/RefractedSun.ts';
import { rainRippleGradient } from '../weather/Rain.ts';
import type { Bounds } from '../RenderTypes.ts';
import { debugFlags } from '../debug/DebugFlags.ts';
import { AMBIENT_ONLY } from '../debug/LightLayer.ts';
import { tuneUniform } from '../debug/Tune.ts';
import { REFERENCE_SPEED } from '../weather/Wind.ts';
import { motionNode, motionState, motionUniforms, outputStruct, reactiveUniforms } from '../post/Motion.ts';
import { sceneUnits } from '../post/PreExposure.ts';
import { TEMPORAL } from '../post/Antialiasing.ts';
import { settings } from '../Settings.ts';

// The sea surface: an FFT-displaced grid with its normal, reflection, refraction and foam.
// Its shading takes tidewater's WaterMaterial (4811ba4, its above-water branch: the normal, the
// Fresnel and the sky's reflection, its gate, the refracted ray to the floor, the foam) with the
// water body and the sun's glint our own (below; the camera never goes under the sea):
//   - the normal from the cascades' slopes over their horizontal stretch (WaterSurface), with
//     near-field capillary ripples (in the reflection and the glint, not the refraction), the rocky
//     shore's reflected wave and the rain's rings
//   - the sea's large-scale detail in world space (SeaDetail): gusts roughen the short waves the
//     pixel cannot resolve and the near ripples, slicks smooth them, gusts and windrows add whitecaps;
//     around the island the gusts are the meadow's, read in the vertex stage
//   - the key reaching the surface: the sun or the moon through the clouds, which every term takes
//     whole (the glint only the direct beam, without the light the cloud scatters on through, which is
//     diffuse and makes no mirror image of the key: Sky.ts `cloudDirectVisibility`), and through the
//     sun shadow's maps, read once, in the vertex stage, over a disc some
//     metres wide (`vKeyShadow`, SunShadow `discVisibility`), which each term takes by what it is
//     (the constants at `SHADOW_SOFT_RADIUS`): the glint, the meter and a storm's foam whole
//     (`sunLight`), the foam raised (`foamLight`), the water body in part (`bodyLight`), and the
//     floor keeps its own sharp shadow; the moon's glint is grey (`keyChroma`), so its path on the
//     sea stays pale rather than a sheet of the moon's saturated blue, which the water body keeps.
//     The sea's key is the land's (Sky.ts `seaKeyVisibility`, lighting/KeyCloud.ts): the sky's
//     (shared.sunColor) through the clouds' own transmittance over the land's floor, the cumulus'
//     and under a closed deck the deck's floor with its gain, the air's. The sunlight the deck
//     passes down reaches the sea's surface as it reaches the land, so the water body, its
//     foam, the floor seen through it (the light under the water) and the sea the ambient light
//     bounces are lit by one key, and the floor enters ahead of the surface, taking the key's share
//     into the water, its refraction and its path down the column as the key does. The glint keeps
//     the direct beam alone: under a deck that lets almost none of it through, the soft sheen
//     toward the sun is the sky's reflection (the deck's glow about the sun's place is drawn in the
//     sky), not a glitter road. The surface's metering illuminance is a share of what a white card
//     laid level at the point would meter (the sky's upper hemisphere and the key by its shadow and
//     clouds, no reflection, refraction, body nor foam): clear water sends back little diffuse
//     light, and yet it is read as bright water, not a black hole, in the exposure's image. The
//     key's cosine in it is the one level ground takes (the lifted key's: KeyLift.ts), so under one
//     key the sea's sunlit term and the ground's are metered alike, and a low sun's sea is not a
//     dark hole in the meter at dusk and dawn; reflection and refraction enter the colour only. The
//     meter follows the lighting state: the sea's share of a frame moves the exposure the same way
//     under every sky, and by less than when the sea metered as open ground
//   - exact dielectric Fresnel, its mean over the slopes no pixel resolves on the distant sea (a
//     mirror's grazing reflectance is too much for a sheet of small facets turned every way): the
//     facets the eye sees turn toward it, and other waves stop part of their reflected rays (Smith's
//     shadowing), all from one spread of the slopes along the view (`REFLECTION_LOBE`); it scales
//     the pixel's own Fresnel, so the waves the pixel does resolve keep their relief; the sky
//     reflected over a lobe as wide as those slopes, lifted by the same facets' tilt toward the
//     higher sky, its share under the horizon darkened toward the horizon's colour, and by the
//     view's elevation (`REFLECTION_BAND`) a low sun's lift of the sky's light (shared.ts
//     `skyLift`), so the far sea keeps the band it mirrors, never brighter than the sky over the
//     horizon (the lobe, the horizon's level and its darkening are means over what no pixel
//     resolves, the slopes and the waves' occlusion, not a grade of the sky's colour); by night the
//     far sea's reflection comes, with the distance, to the night sky as the dome draws it
//     (SEEN_SKY: the dome's night sky stands below the light it sheds, which the bake holds); both read the sea's slopes before the waves' damping, so a lee stands level with the sea round it, never a pale tongue
//     of a mirror's reflectance; the screen-space reflection of the cliffs and the islanders behind
//     tidewater's gate (rays near the horizon, reflectance over 0.05)
//   - the key's specular: the sun's Beckmann lobe of the base roughness and the slopes the pixel
//     cannot resolve (Cox & Munk 1954's mean square slope for the wind, J. Opt. Soc. Am. 44:838, the
//     share finer than the pixel), which is the distribution's alpha^2 itself, with Beckmann's Smith
//     shadowing (Walter et al. 2007's rational form), and no ceiling but half float's: a glint is
//     some 1e5 times the sky, and the display chain takes it from there; the moon's, the same
//     Gaussian lobe of twice a smaller share of those slopes, with GGX's visibility, under a fixed
//     ceiling (`MOON_KNEE`), so its field stands broken on the dark sea (values set for the moon)
//   - refraction: the refracted view ray (through the surface without the near ripples) followed to
//     the floor's height field, its end projected
//     into the refraction pass's image of the world under the sea (Refraction.ts, through its wider
//     view: the floor behind the cliffs above the waterline, and below the screen's bottom edge)
//     where it lies behind the surface, else straight behind in that image; on the screen the
//     opaque pass's sharper image of the same floor, read over the pixel's footprint at the end
//     from the underwater pyramid (Pipeline.ts: its mips, what stands above the water left out);
//     where the image holds nothing there (the shallows above its clip height, the sky), the
//     opaque image, as before; a thin sheet of water takes the opaque image of the rock under it;
//     what swims in the water (Refraction.ts markSwimmer), in the opaque image straight behind,
//     where its material places it as seen through the waves (swimmerSway)
//   - the water body: Lee et al.'s semi-analytic shallow-water model along that path (`WATER_BODY`),
//     for Case 1 water's absorption and backscattering (shared.ts `sigA`, `bb`): the floor seen
//     through the column, and the deep water's reflectance under the sun (the same sun the floor
//     takes: the share that enters the water and the beam's change of area, so the body dims as the
//     sun sinks) and under the sky (through the surface at the sky's diffuse transmittance, the sky
//     the surface sees and reflects, under a deck too: the light that enters the water agrees with
//     the deck it mirrors), each filling in as the column deepens, the whole leaving the water at
//     1 / n^2; the floor's image formed of its unscattered light, sharp, and the light the water
//     scatters forward by small angles, blurred over the path (`WATER_BODY`, the floor's image), so
//     the floor's detail softens with the water between and its large shapes stay; whitecaps where the surface is compressed
//     (tidewater's fresh foam, not its persistent foam, which integrates in time), lit as a bright diffuse scatterer
// Drawn after the opaque pass into the same multisampled target, depth-tested per sample against
// the opaque surfaces, reading a copy of that pass's resolved colour, its linear depth and the
// underwater pyramid, and the refraction pass's colour and depth. Those images hold radiance
// pre-exposed, and so does the water's own output (post/PreExposure.ts): it reads them back in
// scene units (`sceneUnits`) and shades in scene units, and its `outputStruct` stores the result.
//
// Kept of our own: the grid and its skirt, the waves' damping by the shore (the vertex stage), the
// rocky shore's reflected wave and the foam the waves leave on it (ShoreWaves), the reflection march with its box and the cliff foot's
// lifted hit (traceSSR), the soft line where the surface cuts the rock, the motion vectors, the
// rain's ripples and the storm's foam (parked weathers), the open sea's deepening past the
// shelf (OPEN_DEEPENING), which fades the floor's light out before the far floor's edge, the water
// body, Lee et al. 1999's shallow-water reflectance of the sea's measured optics (WATER_BODY), and
// the sun's glint, Beckmann's lobe of Cox & Munk's slopes (`D_Gaussian`, `smithG1`).
// The sea continues to the horizon: a skirt around the wave grid out to SKIRT_RADIUS, whose outer
// ring stands at the eye's height (`onHorizon`), so from any height the sea's far edge meets the
// sky at the eye's level, where the dome's horizon lies. Left flat, the ring stood a little under
// it (from 190 m some 0.3 degrees, from 12 m a fraction of a pixel), and the dome's panorama under
// the horizon showed between the two as a band with a step at the sea's edge. The camera's far
// plane and the sky-depth thresholds (-9e4; the resolved sky is -1e5) stay beyond the skirt. The
// pixel row the horizon crosses holds samples of both: the haze composite fogs it as the sea
// (post/Pipeline.ts, the surface resolve), else that row kept the far sea unhazed, a dark line.
//
// Limits to keep in mind:
// - WebGPU guarantees 16 sampled textures per stage (a texture past them fails pipeline creation),
//   and the fragment stage samples 14: the FFT's fields are array textures, a layer per cascade,
//   and the storm foam is a storage buffer. The sun's two shadow steps, one array texture, bind in
//   the vertex stage. So the water samples neither the target it draws into nor a history or a
//   reactive input: what the resolve needs from it goes out through its velocity.
// - The reflection only finds what lies inside `reflectionBounds` (see below): anything opaque
//   placed off the island or above 3 m (REFLECTOR_HEIGHT; a tree, a boat, a hut, a mast) must grow
//   that box through `hold`, or the sea will not reflect it (the game's props and the plants'
//   crowns do: IslandStages.ts `holdOpaque`, `holdPlants`). A held box never lowers its floor.
//
// Motion vectors (the temporal modes, Motion.ts): the sea writes its velocity with its colour (class
// water). Each vertex is moved back to where it was a step of the scene clock ago (`step`: the
// clock's advance since the rendered frame before, 0 across a cut, a seek or a pause): its cascades'
// displacement less their rate of change times the step (OceanFFT's orbital velocity, horizontally
// scaled by the choppiness), weighted by the fine cascade's fade and the skirt's flattening as seen
// from the previous camera, plus the rocky shore's reflected wave from its previous bake
// (ShoreWaves). The skirt beyond 1500 m carries no waves: camera motion only there. That previous
// position reaches the fragment through Motion.ts's one varying; the reads are vertex-stage only.
// The storm's foam rides the water's undisplaced grid (StormSea), so it moves as the surface does:
// `flags.mv.sea = false` leaves out the waves' motion, the foam's with it (the sea has no foam
// geometry of its own for `flags.mv.foam`). The reactive weight marks the sun's glints: the glint's
// luminance before its ceiling against a white diffuse surface under the same light, smoothstep( 2,
// 8, ratio ) by default (the resolve's settings, Motion.ts reactiveUniforms), so that a sparkle is
// not smeared into the history.
//
// Screen conventions (WebGPU): uv ( 0, 0 ) is the top-left corner, NDC y points up, depth runs 0..1.
// Texture samples that need screen-space derivatives are taken first, while control flow is still
// uniform; inside branches and loops the shading samples explicit levels or loads texels.

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;
type V4 = THREE.Node<'vec4'>;
type M4 = THREE.Node<'mat4'>;
type B = THREE.Node<'bool'>;

// The open sea beyond the island's shelf is taken to be deep. Its floor is drawn at an even depth
// of some ten metres out to the far floor's square edge, and the water shows a floor that shallow
// plainly, so where the floor stopped the edge ran across the sea as a straight line: the floor-lit
// water inside it, the open water's colour outside. The water now adds this much depth to its path
// to the floor, over a rounded square round the world's centre (a 4-norm, so its contours have no
// straight runs): none out to where no grown land's shelf reaches, and the full depth from a little
// inside the far floor's edge (the two 4-norm radii are the scene's, WaterInputs.openSea), where
// the added depth, crossed down and back, leaves some 7 % of the floor's blue light and 2 % of its
// green (red none): too little beside the water body's own light for the edge to show in the frame,
// at noon clear or cloudy, from the island view or low over the sea. The shallows fade into deep
// water in between. The floor's mesh is not lowered: the opaque image holds the floor as the eye
// sees it straight, without refraction, and a floor that fell away faster than the view's slant
// left no image of itself behind the shelf's lip, so the refracted lookups found nothing there and
// drew the lip as a hard line instead. (A mean over the geometry the drawn floor leaves out, the
// open sea's depth past the shelf, kept for the floor's resolution.)
const OPEN_DEEPENING = {
	depth: 30, // m
	left: 0.05, // the share of the light down the full depth that the fade's shape follows
};

const PI = Math.PI;
const IOR = 1.333;
const sat = ( x: F ) => clamp( x, 0, 1 );
const lum = ( c: V3 ) => dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );

// exact unpolarised dielectric Fresnel, eta = n2 / n1
const fresnelDielectric = Fn( ( [ cosI, eta ]: [ F, F ] ) => {

	const c = clamp( cosI, 0, 1 ).toVar();
	const g2 = eta.mul( eta ).sub( 1 ).add( c.mul( c ) ).toVar();
	const res = float( 1 ).toVar();
	If( g2.greaterThanEqual( 0 ), () => {

		const g = sqrt( g2 ).toVar();
		const a = g.sub( c ).div( g.add( c ) );
		const b = c.mul( g.add( c ) ).sub( 1 ).div( c.mul( g.sub( c ) ).add( 1 ) );
		res.assign( a.mul( a ).mul( b.mul( b ).add( 1 ) ).mul( 0.5 ) );

	} );
	return res;

} ).setLayout( { name: 'fresnelDielectric', type: 'float', inputs: [ { name: 'cosI', type: 'float' }, { name: 'eta', type: 'float' } ] } );

// the unit normal density, and its integral through erf by Abramowitz and Stegun's 7.1.26 (an
// absolute error under 1.5e-7)
const normalPdf = ( x: F ) => exp( x.mul( x ).mul( - 0.5 ) ).mul( 1 / Math.sqrt( 2 * PI ) );
const normalCdf = Fn( ( [ x ]: [ F ] ) => {

	const z = abs( x ).mul( Math.SQRT1_2 ).toVar();
	const t = float( 1 ).div( z.mul( 0.3275911 ).add( 1 ) ).toVar();
	const poly = t.mul( t.mul( t.mul( t.mul( t.mul( 1.061405429 ).add( - 1.453152027 ) ).add( 1.421413741 ) ).add( - 0.284496736 ) ).add( 0.254829592 ) );
	const half = float( 1 ).sub( poly.mul( exp( z.mul( z ).negate() ) ) ).mul( 0.5 ).toVar();
	return select( x.lessThan( 0 ), float( 0.5 ).sub( half ), float( 0.5 ).add( half ) );

} ).setLayout( { name: 'normalCdf', type: 'float', inputs: [ { name: 'x', type: 'float' } ] } );

// Smith's shadowing of a ray at elevation sine `y` over Gaussian slopes of spread `s` along its
// azimuth (the Beckmann distribution's G1 in the rational form of Walter, Marschner, Li & Torrance
// 2007, "Microfacet Models for Refraction through Rough Surfaces", EGSR), 0 at or under the horizon
const smithG1 = Fn( ( [ y, s ]: [ F, F ] ) => {

	const c = clamp( y, 0, 0.9999 ).toVar();
	const a = c.div( sqrt( float( 1 ).sub( c.mul( c ) ) ).mul( s ).mul( Math.SQRT2 ) ).toVar();
	const g = a.mul( 3.535 ).add( a.mul( a ).mul( 2.181 ) ).div( a.mul( 2.276 ).add( a.mul( a ).mul( 2.577 ) ).add( 1 ) ).toVar();
	return select( a.lessThan( 1.6 ), g, float( 1 ) );

} ).setLayout( { name: 'smithG1', type: 'float', inputs: [ { name: 'y', type: 'float' }, { name: 's', type: 'float' } ] } );

// the Gaussian (Beckmann) distribution of slopes of mean square alpha^2 over both axes (the glint's,
// the sun's and the moon's)
const D_Gaussian = Fn( ( [ NdH, a2 ]: [ F, F ] ) => {

	const cos2 = max( NdH.mul( NdH ), 1e-6 ).toVar();
	return exp( float( 1 ).sub( cos2 ).div( cos2.mul( a2 ) ).negate() ).div( a2.mul( cos2 ).mul( cos2 ).mul( PI ) );

} ).setLayout( { name: 'D_Gaussian', type: 'float', inputs: [ { name: 'NdH', type: 'float' }, { name: 'a2', type: 'float' } ] } );

// the height-correlated Smith visibility for GGX, V = G / ( 4 NdL NdV )
const V_SmithGGX = Fn( ( [ NdL, NdV, a2 ]: [ F, F, F ] ) => {

	const gv = NdL.mul( sqrt( NdV.mul( NdV ).mul( float( 1 ).sub( a2 ) ).add( a2 ) ) );
	const gl = NdV.mul( sqrt( NdL.mul( NdL ).mul( float( 1 ).sub( a2 ) ).add( a2 ) ) );
	return float( 0.5 ).div( max( gv.add( gl ), 1e-5 ) );

} ).setLayout( { name: 'V_SmithGGX', type: 'float', inputs: [ { name: 'NdL', type: 'float' }, { name: 'NdV', type: 'float' }, { name: 'a2', type: 'float' } ] } );

// a 2D vector turned by an angle (radians)
const rotate = ( v: V2, angle: number ) => vec2( v.x.mul( Math.cos( angle ) ).sub( v.y.mul( Math.sin( angle ) ) ), v.x.mul( Math.sin( angle ) ).add( v.y.mul( Math.cos( angle ) ) ) );

// The sea continues to this distance (metres), well past the horizon for any review camera.
const SKIRT_RADIUS = 40000;
// 1 on the skirt's outer ring (`xz` undisplaced), which stands at the eye's height (see the header),
// 0 elsewhere. The vertex stage raises the ring in its clip position alone (`vertexNode`), built from
// the grid point (the skirt carries no waves), and leaves the surface's position as it is: any second
// use of the position, even one that left every other vertex's value unchanged, let the compiler
// round the whole sea's positions another way, and the near sea's reflection march flipped at
// scattered pixels. The ring's fragments shade the level sea under it, a fraction of a degree away
// (the motion vectors take the raised ring). The last row of the skirt, some 34 to 40 km out, rises to
// the eye; its rays reach the sea's far edge through less of the low haze than a level sea's would,
// which from 190 m leaves its top rows a level or two darker than the rows under them.
const onHorizon = ( xz: V2 ) => step( SKIRT_RADIUS * 0.999, max( abs( xz.x ), abs( xz.y ) ) );

// The longest step of the scene clock between two rendered frames that is still motion; a longer
// one (or a step back) is a seek, which has none (as StormSea's live step).
const MAX_MOTION_STEP = 0.25;

// The whitecaps' foam pattern, repeats per metre (tidewater's foamScale).
const FOAM_SCALE = 0.09;
// The foam the waves leave at the rock (ShoreWaves), finer: bubbles of a few centimetres, cells of a decimetre
// or two.
const SHORE_FOAM_SCALE = 1;

// The share of the key's chroma in the glint: 1 by day, 0 under the moon (RenderStages.ts publishLighting).
// At the handover between them the key has no energy, so the step is not seen.
export const keyChroma = uniform( 1 );

// The moon's glint. The sun's and the moon's glints share Beckmann's lobe (`D_Gaussian`), the shape the
// sea's near-Gaussian slopes give (Cox-Munk); a long-tailed lobe such as GGX's would lay a lit sheet
// between the moon's glints, since a moon at a hundredth of its peak is still brighter than the whole
// moonlit sea and at its height every slope lies within about three alpha of the mirror. The two
// differ only in what the night keeps as it was tuned: under the moon the glint's visibility is
// still GGX's height-correlated Smith term (`V_SmithGGX`) and its alpha and ceiling are the moon's
// own (below), where the sun takes Beckmann's own separable Smith shadowing and no ceiling. The
// glint mixes the two by `keyChroma`, exactly 0 under the moon, so the night draws as it did before
// the sun's lobe became physical.
// MOON_UNRESOLVED scales the slopes no pixel resolves in the moon's alpha alone, which sets the size
// of the field, not the level between its glints: the part of the frame above L .6 goes about 2.5 %
// at 1, 2.0 % at .7, 1.7 % at .5, and the field's median .57, .47, .39 with it.
// MOON_KNEE is the moon's soft ceiling: G / ( G MOON_KNEE + 1 ) takes the hard top off the near-white
// core and leaves the broken field as it is (the field's p99 .965 at 0, .907 at 1.5, .860 at 3). The moon's alpha^2 takes twice the slopes' mean square
// and its lobe GGX's visibility: values set for the moon, which the sun's physical lobe leaves as they
// are (the glint's `keyChroma` mix is exactly 0 under the moon).
const MOON_UNRESOLVED = 0.7, MOON_KNEE = 1.5;

// The key's shadow on the sea. Deep water has no surface to take a shadow on: a shadow shows there as
// the glitter gone, a mirror's loss at the surface, and a slight, soft dimming, since light that enters
// beside the shadow scatters in under it. The body is more than half of the lit sea, and one sharp
// read of the map took the whole of it with a leaf's edge, as a dark stain on the water. Weakening
// that read still left the leaves' outlines, so the softness comes first: the map is read at the
// undisplaced grid point over a disc of SHADOW_SOFT_RADIUS metres (3 and 6 gave the same levels, and 3
// keeps a shadow by its caster), SHADOW_LIFT metres over the sea (its offset out of the level
// surface), and the varying's interpolation softens it on. Each term then takes the one soft value:
// - the glint, the reactive weight, the meter and a storm's foam: whole;
// - the foam: min( 1, FOAM_SHADOW_GAIN soft ). A tap of the disc that lands on rock or sand reads
//   shadow, and foam stands exactly there, so the soft read alone dims the foam all along the shore;
//   raised, the foam keeps its level there and still goes dark inside a whole shadow;
// - the body: mix( 1, soft, share ). The share is SHADOW_BODY over deep water, where the shadow's
//   drop follows it by about .08 of L per unit by day and .06 at night, and rises to 1 where the floor
//   takes the light (over SHADOW_BODY_DEPTH metres of water): in the shallows the water deep inside
//   a wide shadow stays as dark as the floor under it, which keeps its own sharp shadow.
const SHADOW_SOFT_RADIUS = 3, SHADOW_LIFT = 0.012;
const FOAM_SHADOW_GAIN = 2;
const SHADOW_BODY = 0.5, SHADOW_BODY_DEPTH = [ 2, 8 ] as const;

// The sky panorama's level the horizon's colour is read at (a band some 20 degrees high): a mean over
// the band, as wide as the reflection's lobe stands at the horizon, not a sharp line.
const HORIZON_MIP = 5;

// What a reflection below the horizon keeps of the horizon's colour (it meets other waves). It stands
// for a mean over occlusion finer than the pixel: a ray turned down meets the next wave and takes what
// that wave's face reflects, which no pixel resolves.
const BELOW_HORIZON = 0.6;

// The view's elevation (its sine) over which a low sun's lift of the sky's light (shared.ts `skyLift`)
// comes into the reflection: the far sea mirrors the low band of the sky straight across, which the
// lift does not raise, and stays under the sky over the horizon.
const REFLECTION_BAND = { ramp: 0.18 } as const;

// The distances (m) over which the sky's reflection comes to the night sky as the dome draws it
// (shared.ts `seenNight`): the dome's night sky stands below the light it sheds, which the sea's
// reflection reads from the environment's bake, so the far sea would stand as a bright band under
// a darker sky; the near sea keeps the light the sky sheds, as the land does.
const SEEN_SKY = { near: 200, far: 2000 } as const;

// The mean surface's reflection over the slopes no pixel resolves, all from one spread: the slopes
// along the view a Gaussian of sigmaV = sqrt( sigma^2 / 2 ) x `slopeScale`, sigma^2 the mean square
// slope over both axes of the sea's share finer than the pixel, before the waves' damping (the
// damped one falls away where the fine waves do, and the lee stood out as a smooth pale tongue).
// - The facets the eye sees, weighted by their projected area (the visible normals' distribution:
//   Heitz 2014, "Understanding the Masking-Shadowing Function in Microfacet-Based BRDFs", JCGT),
//   meet the view at a mean cosine cosVisible = E2 / E1 over the flat sea's cos
//   (E1 = cos Phi( m ) + sigmaV phi( m ), E2 = ( cos^2 + sigmaV^2 ) Phi( m ) + cos sigmaV phi( m ),
//   m = cos / sigmaV), and a facet's reflectance climbs so steeply at grazing that the sheet reflects
//   as they do. The mean Fresnel is the pixel's own times
//   F( cosVisible ) / F( cos ) (a lifted cosine in the pixel's Fresnel alone would even the waves out),
//   times the share of the reflected rays no other wave stops: Smith's shadowing for those slopes,
//   at the lobe's centre and its two edges, weighted 1/4, 1/2, 1/4.
// - The reflected rays rise with the facets' tilt toward the eye: the lobe's centre stands `lift`
//   times ( cosVisible - cos ) over the mirror (an elevation's sine), and it spreads 2 sigmaV either
//   way. `lift` is 2, the geometry's own: a facet tilted toward the eye by a small angle raises the
//   view's cosine on it by that angle times the grazing angle's cosine, and the reflected ray by
//   twice the angle, so its sine by twice as much (1.5 left the far sea of a low sun too dark). The pixel's own mirror rises by as much, so the waves it resolves keep their relief. The sky
//   is read there over the lobe's width (a level of the panorama, never wider than the lobe stands
//   over the horizon), and the lobe's share under the horizon, a normal integral at least `edge`
//   wide (the waves near the eye, which leave the lobe no width, keep a soft edge), takes the
//   horizon's colour by BELOW_HORIZON.
// (A mean over the slopes finer than the pixel: what the pixel would show if it resolved them.)
const REFLECTION_LOBE = { slopeScale: 1, lift: 2, edge: 0.05 } as const;

// The water body: Lee, Carder, Mobley, Steward & Patch 1999, "Hyperspectral remote sensing for
// shallow waters: 2. Deriving bottom depths and water properties by optimization" (Appl. Opt.
// 38:3831), the semi-analytic model of the light a shallow column sends up, in its off-nadir form
// (their equation 9). With kappa = a + bb and u = bb / kappa (shared.ts `sigA`, `bb`):
//   rrs_deep = ( 0.084 + 0.170 u ) u, the deep water's below-surface remote-sensing reflectance
//   Du_C = 1.03 sqrt( 1 + 2.4 u ), Du_B = 1.04 sqrt( 1 + 5.4 u ), the column's and the floor's
//     upwelling distribution factors
//   floor  = the floor's radiance x exp( - kappa Du_B L )
//   column = E_d( 0- ) rrs_deep ( 1 - exp( - kappa ( H / mu_d + Du_C L ) ) )
// for each of the sun (mu_d the refracted sun's cosine) and the sky (1 / mu_d = SKY_PATH), L the
// slant path along the refracted view and H = L mu_v the water's depth along it. The floor's radiance
// is the opaque pass's, lit through the column by Underwater.ts at the same kappa, which is the
// model's downward leg. The model was fitted to views within 30 degrees of the nadir under the
// water (its mean error about 6 %, at most about 15 %); most of the sea in the island view is seen
// past that, and takes it with a larger error, though the lower the view the more the reflection
// rules the sea. Their angular correction of bb (equations 10 and 11) is left out, as small within
// that range. Their denominator ( 1 - 1.5 rrs ) is left out too: 1.5 rrs is about 0.1 to 1.6 % over
// deep water (red to blue) and up to about 4 % over shallow sand, under the model's own error. The
// radiance under the surface leaves it at 1 / n^2 (the change of the beam's solid angle); the
// surface's own transmittance 1 - F is the blend with the reflection.
// The floor's image. Lee's floor term is the whole of the floor's light that comes back up the path,
// what went straight and what the water scattered a little off its line on the way, so taken as a
// sharp image it showed the floor as through glass at any depth, only darker. The image is formed
// of the unscattered light, the beam's exp( - c L ) with c = a + b (ocean/SeaOptics.ts SCATTER), and
// the light scattered forward by small angles, which arrives spread over the floor (McGlamery 1980,
// "A computer model for underwater camera systems", SPIE 208; Jaffe 1990, "Computer modeling and the
// design of optimal underwater imaging systems", IEEE J. Oceanic Eng. 15:101): the floor term is
// split into floor x exp( - c L ) and the floor blurred x ( exp( - kappa Du_B L ) - exp( - c L ) ),
// the sharp share held under the whole. In green the sharp share is some .69, .39 and .16 of the
// floor's light at 2, 5 and 10 m: the sand's ripples hold near the shore, the floor's detail goes
// soft from a few metres, and past ten only its large shapes remain; the mean is Lee's as before.
// The blur's spread on the floor, one axis, is the small-angle diffusion of a beam scattered at
// rate b_f with rms angle theta per axis along a path L, each scattering at x offsetting the ray by
// theta ( L - x ): sigma^2 = b_f theta^2 L^3 / ( 3 ( 1 - exp( - b_f L ) ) ) (the mean over the
// scatterings that happened; SeaOptics.ts FORWARD_SCATTER, FORWARD_ANGLE). The blurred image is the
// underwater pyramid read again at the end's footprint widened by that spread in pixels, one
// filtered read: a single scale where the spread is heavy-tailed (its median offset well under
// sigma), so it softens the floor's mid-scale detail and keeps its large shapes, without the halo's
// long tail.
const WATER_BODY = { rrs: [ 0.084, 0.170 ], column: [ 1.03, 2.4 ], floor: [ 1.04, 5.4 ] } as const;
// the diffuse Fresnel transmittance of a uniform sky from air into water at n = 1.333, and the path
// factor of its light down the column, about 1 / mu_d (Underwater.ts)
const SKY_INTO_WATER = 0.934, SKY_PATH = 1.2;

// The reflection's march stops this far along the ray (m); its hits fade out from 120 m (tidewater's).
const SSR_FARTHEST = 260;

// A refracted sample serves when it lies this far behind the water's surface (view depth, m).
const WATER_BEHIND = 0.05;

// view-space direction through a screen point (on the far plane; scaled by the caller)
const viewRay = Fn( ( [ q, projInv ]: [ V2, M4 ] ) => {

	const v = projInv.mul( vec4( q.x.mul( 2 ).sub( 1 ), float( 1 ).sub( q.y ).mul( 2 ).sub( 1 ), 1, 1 ) ).toVar();
	return v.xyz.div( v.w );

} ).setLayout( { name: 'viewRay', type: 'vec3', inputs: [ { name: 'q', type: 'vec2' }, { name: 'projInv', type: 'mat4' } ] } );

/** Where something swimming at world point `at` (Refraction.ts markSwimmer) appears to the eye
 * through the sea's longer waves, as an offset to add to it (for its material's vertex stage): the
 * ray through a flat sea less the ray refracted through those waves (the surface tilted by their
 * slopes at `at`), followed down to its depth under the mean sea, `seaLevel`. The water then shows
 * it straight behind the surface (Water.ts), where a flat sea leaves it whole and the waves sway it
 * by a pixel or two; the shift a flat sea gives the whole view, which this leaves out, no eye can
 * tell from where it lies. The finest cascade is left out: it turns the ray by as much across a
 * fish's few centimetres, and seen through ripples that short a fish blurs rather than breaks. */
export function swimmerSway( fft: OceanFFT, at: V3, seaLevel: F ): V3 {

	const d = [ 0, 1, 2 ].map( ( c ) => texture( fft.derivatives, at.xz.div( fft.sizes[ c ] ) ).depth( int( c ) ).level( float( 0 ) ) as unknown as V4 ).reduce( ( a, b ) => a.add( b ) );
	const tilted = normalize( vec3( d.x.div( max( d.z.add( 1 ), 0.2 ) ).negate(), 1, d.y.div( max( d.w.add( 1 ), 0.2 ) ).negate() ) );
	const view = normalize( at.sub( cameraPosition ) );
	const perDepth = ( n: V3 ) => {

		const t = refract( view, n, 1 / IOR );
		const down = normalize( vec3( t.x, min( t.y, - 0.08 ), t.z ) );
		return down.div( max( down.y.negate(), 0.04 ) );

	};
	return perDepth( vec3( 0, 1, 0 ) ).sub( perDepth( tilted ) ).mul( max( seaLevel.sub( at.y ), 0 ) );

}

const projectView = Fn( ( [ p, proj ]: [ V3, M4 ] ) => {

	const c = proj.mul( vec4( p, 1 ) ).toVar();
	const s = c.xy.div( c.w ).mul( 0.5 ).add( 0.5 );
	return vec2( s.x, float( 1 ).sub( s.y ) );

} ).setLayout( { name: 'projectView', type: 'vec2', inputs: [ { name: 'p', type: 'vec3' }, { name: 'proj', type: 'mat4' } ] } );

export interface WaterInputs {
	fft: OceanFFT;
	sky: Sky;
	shared: Shared;
	shore: THREE.Texture | THREE.TextureNode;
	seabedHeight: THREE.Texture | THREE.TextureNode; // the rendered floor's height over the shoreline field's bounds
	land: Bounds; // the land's box, for reflectionBounds
	// Where the open sea deepens (OPEN_DEEPENING), as 4-norm radii round the world's centre (m): no
	// added depth out to `from`, past any shelf the land can grow, and the full depth from `to`, a
	// little inside the drawn floor's edge. Plain numbers, compiled into the shader.
	openSea: { from: number; to: number };
	reflectorTop: number; // the highest the land's ground rises (m): reflectionBounds ends REFLECTOR_HEIGHT above it
	shoreWaves: ShoreWaves;
	sunShadow: SunShadow;
	storm: StormSea;
	detail: SeaDetail; // gusts, slicks and windrows
	sceneColor: THREE.Texture; // the opaque pass's resolved colour
	linearDepth: THREE.Texture; // its view-space z: sample 0 (x) and the farthest sample (y)
	underwater: THREE.Texture; // that colour under the sea, premultiplied by its weight, with mips (Pipeline.ts)
	refraction: { color: THREE.Texture; depth: THREE.Texture }; // the refraction pass's image (Refraction.ts)
	size?: number;
	res?: number;
	quality?: Partial<WaterQuality>; // compile-time: read once, a change needs a new Water (a reload)
}

// The water's quality knobs. They are compiled into the shader (a uniform-gated branch keeps its
// registers), so they are fixed for the material's life. High is the reference image; the lower
// tiers trade a little of it for time:
//   ssrRays: rays per pixel for the screen-space reflection, either side of the centre (2) or
//     through it (1, a little stair-stepping on the reflected island's edge);
//   ssrSteps, ssrGrowth: its geometric steps, each this much longer than the last. Within 60 m
//     of the camera the march reaches 0.15 + 0.25 (growth^steps - 1) / (growth - 1) metres: 158 m
//     on high, 100 m for 14 steps at x1.45 (14 at about x1.51 would keep the 158 m); farther away
//     every step grows with the distance, up to SSR_FARTHEST;
//   ssrMinFresnel: the reflectance under which a pixel marches no reflection and keeps the sky
//     (tidewater's gate). 0.05 on every tier: it skips most of the sea the island camera looks
//     down on, for about a seventh of the island views' water pass, and with it the faint (2-5 %
//     reflectance) image of the cliffs in the water at their feet (1-2 % of those views' pixels
//     moved more than 8 levels against 0.01); the low views over the sea, where the reflectance is
//     high, keep their reflection;
//   ssrOneRayFresnel: the reflectance under which a pixel takes one ray through its centre instead
//     of two (ssrRays 2 only). The second ray's stair-step and speck are scaled by the reflectance:
//     at 0.05 with the gate at 0.01 it took about a fourteenth of the island views' water pass
//     with under 0.1 % of their pixels moved more than 8 levels (at 0.1 short bright streaks showed
//     at the cliffs' foot). It acts only above ssrMinFresnel: at or under it no shader is built for
//     it, as on high, whose gate already skips those pixels;
//   stormFoam: 'merged' reads the storm foam's mat and lace from one pattern fetch instead of
//     three: the mat keeps only its first layer, and the lace takes the mat's coordinates, so it
//     is no longer drawn out along the wind. The streaks keep their own fetch (they need
//     coordinates stretched along the wind), so 'merged' saves two of the five fetches;
//   fftAnisotropy: the FFT output targets' anisotropic filtering (read by OceanFFT, not here; its
//     six fetches per pixel). It costs only at grazing angles: the island's views, which look
//     down, take no time for it. 4 on high: against 8 it changed under 2 % of the horizon view's
//     pixels, unseen side by side, for about a twelfth of that view's water pass; 2 dulled the
//     far glitter (a tenth of the pixels).
export interface WaterQuality {
	ssrRays: 1 | 2;
	ssrSteps: number;
	ssrGrowth: number;
	ssrMinFresnel: number;
	ssrOneRayFresnel: number;
	stormFoam: 'full' | 'merged';
	fftAnisotropy: number;
}

// High's values; the tiers' values are in Quality.ts.
export const DEFAULT_WATER_QUALITY: Readonly<WaterQuality> = { ssrRays: 2, ssrSteps: 20, ssrGrowth: 1.3, ssrMinFresnel: 0.05, ssrOneRayFresnel: 0.05, stormFoam: 'full', fftAnisotropy: 4 };

// The screen-space reflection can only find what the opaque pass drew above the sea: the island,
// its plants and its people. A box around them, from the land's box (so it grows with the island):
// out past the land's edge by the rim's overhang (the grass hanging from the lip, and room for
// more) plus a metre's margin, and up past the meadow by the islanders' 2 m plus a metre.
// Hits below REFLECTION_FLOOR under the sea level already weigh nothing (see traceSSR), so the box
// ends there, whatever is held (`hold` clips a held box at that floor: a plant's box reaches far
// below the ground, and would otherwise deepen the march's box for nothing). A placed object off
// the island or above 3 m (a tree, a hut, a mast) or a wider rim overhang must grow these, or its
// reflection is lost (debug builds warn, see checkReflectionBounds).
const REFLECTOR_REACH = 1.5 + 1;
const REFLECTOR_HEIGHT = 3;
const REFLECTION_FLOOR = 0.35;

// The ways of building the sea's shading, each its own material (a debug flag picks one, for A/B
// timing in one page). How the reflection's march uses that box: cull, a ray that never meets it
// within the march's reach keeps the sky without marching (most of the sea away from the island);
// clip, a ray stops at its first step past the box, where nothing is left to reflect. The steps
// before the box still read the depth buffer: the march accepts a hit up to 1.4 steps behind it,
// so one of them can end a ray on a far false hit (or on a hit that weighs nothing) where a ray
// started at the box would march on and find another, and the image would change. refraction: the
// refraction pass's image is the refraction source (else the opaque copy alone).
interface WaterVariant { cull: boolean; clip: boolean; refraction: boolean }
const SHIPPED: WaterVariant = { cull: true, clip: true, refraction: true };
const variantKey = ( v: WaterVariant ) => ( v.cull ? 1 : 0 ) + ( v.clip ? 2 : 0 ) + ( v.refraction ? 4 : 0 );

// The distances along a ray (origin, unit direction) at which it enters and leaves a box (slab
// method); enter > leave when it misses.
const rayBoxSpan = Fn( ( [ origin, direction, lo, hi ]: [ V3, V3, V3, V3 ] ) => {

	const safe = ( c: F ) => select( abs( c ).lessThan( 1e-6 ), select( c.lessThan( 0 ), float( - 1e-6 ), float( 1e-6 ) ), c );
	const inv = vec3( float( 1 ).div( safe( direction.x ) ), float( 1 ).div( safe( direction.y ) ), float( 1 ).div( safe( direction.z ) ) ).toVar();
	const a = lo.sub( origin ).mul( inv ).toVar(), b = hi.sub( origin ).mul( inv ).toVar();
	const enter = max( max( min( a.x, b.x ), min( a.y, b.y ) ), min( a.z, b.z ) );
	const leave = min( min( max( a.x, b.x ), max( a.y, b.y ) ), max( a.z, b.z ) );
	return vec2( enter, leave );

} ).setLayout( {
	name: 'rayBoxSpan', type: 'vec2',
	inputs: [ { name: 'origin', type: 'vec3' }, { name: 'direction', type: 'vec3' }, { name: 'lo', type: 'vec3' }, { name: 'hi', type: 'vec3' } ],
} );

const DEBUG = import.meta.env.DEV || settings.has( 'debug' );

export class Water {

	mesh: THREE.Mesh;
	material: THREE.NodeMaterial;
	readonly quality: WaterQuality;
	// Everything opaque above the sea that the reflection can show (see REFLECTOR_REACH). Anything
	// built off the island later (a boat, a hut on stilts) must lie inside it: grow it with `hold`,
	// and the water picks it up on the next frame.
	readonly reflectionBounds: THREE.Box3;
	// tidewater's water material's settings
	uniforms = {
		// the alpha of the slopes the cascades do not describe: Beckmann's for the sun's glint, GGX's
		// for the moon's
		roughness: uniform( 0.035 ),
		ssr: uniform( 1 ),
		reflection: uniform( 1 ),
		foamIntensity: uniform( 1 ),
		foamCoverage: uniform( 1 ),
		shoreFoam: uniform( 1 ), // the foam the waves leave at the rock (ShoreWaves)
	};

	private reflectorMin = uniform( new THREE.Vector3() );
	private reflectorMax = uniform( new THREE.Vector3() );
	private inputs: WaterInputs;
	private materials = new Map<number, THREE.NodeMaterial>();
	// The temporal modes' motion: the scene clock's step since the rendered frame before (s), 0
	// across a cut or a seek; and 0 to leave the waves' own motion out (flags.mv.sea = false).
	private step = uniform( 0 );
	private ownMotion = uniform( 1 );
	private shoreHistory = uniform( 0 ); // 1 while the shore's previous bake is a step ago
	private clock = { frame: - 1, time: 0 };
	private boundsChecked = false;

	constructor( inputs: WaterInputs ) {

		const { size = 700, res = 320, quality } = inputs;

		// grid in world xz, warped dense under the island and sparse toward the horizon
		const n = res;
		const pos = new Float32Array( ( n + 1 ) * ( n + 1 ) * 3 );
		const warp = ( u: number ) => Math.sign( u ) * Math.pow( Math.abs( u ), 2.1 );
		for ( let j = 0; j <= n; j ++ ) for ( let i = 0; i <= n; i ++ ) {

			const k = ( j * ( n + 1 ) + i ) * 3;
			pos[ k ] = warp( i / n * 2 - 1 ) * size / 2;
			pos[ k + 2 ] = warp( j / n * 2 - 1 ) * size / 2;

		}

		const idx: number[] = [];
		for ( let j = 0; j < n; j ++ ) for ( let i = 0; i < n; i ++ ) {

			const a = j * ( n + 1 ) + i;
			idx.push( a, a + n + 1, a + 1, a + 1, a + n + 1, a + n + 2 );

		}

		// A skirt continues the grid's outer edge to the horizon in widening rows. Without it the
		// sea stopped a couple of degrees below the horizon and a band of the sky's lower panorama
		// showed between them. Its inner row is the grid's boundary, so the seam is exact; its outer
		// row the vertex stage raises to the eye (`onHorizon`).
		const ring: number[] = [];
		for ( let i = 0; i < n; i ++ ) ring.push( i ); // z = -size / 2
		for ( let j = 0; j < n; j ++ ) ring.push( j * ( n + 1 ) + n ); // x = +size / 2
		for ( let i = n; i > 0; i -- ) ring.push( n * ( n + 1 ) + i ); // z = +size / 2
		for ( let j = n; j > 0; j -- ) ring.push( j * ( n + 1 ) ); // x = -size / 2
		const rows = 28, reach = SKIRT_RADIUS / ( size / 2 );
		const grid = pos.length / 3, skirt: number[] = [];
		for ( let r = 1; r <= rows; r ++ ) {

			const scale = Math.pow( reach, r / rows );
			for ( const v of ring ) skirt.push( pos[ v * 3 ] * scale, 0, pos[ v * 3 + 2 ] * scale );

		}
		const vertex = ( r: number, k: number ) => r === 0 ? ring[ k % ring.length ] : grid + ( r - 1 ) * ring.length + k % ring.length;
		const all = new Float32Array( pos.length + skirt.length );
		all.set( pos );
		all.set( skirt, pos.length );
		for ( let r = 0; r < rows; r ++ ) for ( let k = 0; k < ring.length; k ++ ) {

			const a = vertex( r, k ), b = vertex( r, k + 1 ), c = vertex( r + 1, k ), d = vertex( r + 1, k + 1 );
			for ( const [ p, q, w ] of [ [ a, c, b ], [ b, c, d ] ] ) {

				// Keep every triangle facing up, whichever way the boundary loop runs.
				const ux = all[ q * 3 ] - all[ p * 3 ], uz = all[ q * 3 + 2 ] - all[ p * 3 + 2 ];
				const vx = all[ w * 3 ] - all[ p * 3 ], vz = all[ w * 3 + 2 ] - all[ p * 3 + 2 ];
				if ( uz * vx - ux * vz > 0 ) idx.push( p, q, w ); else idx.push( p, w, q );

			}

		}

		const geo = new THREE.BufferGeometry();
		geo.setAttribute( 'position', new THREE.BufferAttribute( all, 3 ) );
		geo.setIndex( new THREE.BufferAttribute( new Uint32Array( idx ), 1 ) );
		geo.boundingSphere = new THREE.Sphere( new THREE.Vector3(), SKIRT_RADIUS * Math.SQRT2 );

		this.inputs = inputs;
		this.quality = { ...DEFAULT_WATER_QUALITY, ...quality };
		this.reflectionBounds = new THREE.Box3();
		this.setLand( inputs.land );
		this.material = this.buildMaterial( SHIPPED );
		this.materials.set( variantKey( SHIPPED ), this.material );
		this.mesh = new THREE.Mesh( geo, this.material );
		this.mesh.frustumCulled = false;
		this.mesh.name = 'water';

	}

	// The sea's shading for one variant (see WaterVariant).
	private buildMaterial( variant: WaterVariant ): THREE.NodeMaterial {

		const { fft, sky, shared, shore, seabedHeight, shoreWaves, sunShadow, storm, detail, sceneColor, linearDepth, underwater, refraction, openSea } = this.inputs;
		const quality = this.quality;
		const u = this.uniforms;
		// (REFLECTION_LOBE's spread and lift, and the panorama's texel in radians)
		const lobeSlopeScale = tuneUniform( 'sea.reflection.slopeScale', REFLECTION_LOBE.slopeScale, { min: 0.5, max: 1.5 } );
		const lobeLift = tuneUniform( 'sea.reflection.lobeLift', REFLECTION_LOBE.lift, { min: 0, max: 3 } );
		const panoramaTexel = PI / sky.equirect.height;
		// the sea's metering illuminance: a share of the white card's. A quarter puts the sea two stops
		// under sunlit bare ground in the island views of a clear sky, a closed deck and a cloudy
		// deck, within a fifth of a stop; a fifth leaves three of those four views outside it and
		// three tenths all four (one by a hundredth of a stop), and the views keep their look best at
		// a quarter (three tenths loses the most)
		const meterShare = tuneUniform( 'sea.meter.share', 0.25, { min: 0, max: 1 } );
		// A cascade's layer of an FFT field at an undisplaced xz.
		const cascade = ( field: THREE.Texture, c: number, at: V2 ) => texture( field, at.div( fft.sizes[ c ] ) ).depth( int( c ) );

		// ---- vertex: displace the grid by the four cascades (the finest fades out far away), each
		// damped by the floor's depth, the island's lee and the rock (WaveDamping.ts). The undisplaced
		// grid point comes from the geometry: once positionNode is set, positionLocal reads the
		// displaced position.
		const xz = positionGeometry.xz;
		const fieldUV = ( p: V2 ) => p.sub( shared.shoreXform.xy ).mul( shared.shoreXform.zw );
		// ( the fine cascade's level of detail apart, w: its physical damping alone )
		const weights = waveDamping( { fft, shared, shore, seabedHeight, shoreWaves }, xz ).weights.toVar();
		const far = length( xz.sub( cameraPosition.xz ) );
		const fineWeight = float( 1 ).sub( smoothstep( 60, 140, far ) );
		const disps = [ 0, 1, 2, 3 ].map( ( c ) => cascade( fft.displacement, c, xz ).level( float( 0 ) ).xyz );
		const weighted = ( parts: V3[], w: THREE.Node<'vec4'>, fine: F ) => parts[ 0 ].mul( w.x ).add( parts[ 1 ].mul( w.y ) )
			.add( parts[ 2 ].mul( w.z ) ).add( parts[ 3 ].mul( w.w.mul( fine ) ) );
		// The skirt's sparse rows cannot carry waves; there the shading's slopes alone describe them.
		const geometric = float( 1 ).sub( smoothstep( 600, 1500, far ) );
		const d = weighted( disps, weights, fineWeight ).mul( geometric );
		const material = new THREE.NodeMaterial();
		const displaced = vec3( xz.x.add( d.x ), shared.waterLevel.add( d.y )
			.add( shoreWaves.surfaceAt( xz.add( d.xz ), shared.time ).x ), xz.y.add( d.z ) ).toVar();
		material.positionNode = displaced;
		// the skirt's outer ring at the eye's height (`onHorizon`)
		material.vertexNode = Fn( () => {

			const clip = ( modelViewProjection as THREE.Node<'vec4'> ).toVar();
			If( onHorizon( xz ).greaterThan( 0.5 ), () => {

				clip.assign( cameraProjectionMatrix.mul( modelViewMatrix.mul( vec4( xz.x, cameraPosition.y, xz.y, 1 ) ) ) );

			} );
			return clip;

		} )();
		if ( TEMPORAL ) {

			// (motion vectors: the note at the top) the vertex a step of the clock ago, seen from the
			// previous camera's level of detail
			const previousFar = length( xz.sub( motionUniforms.previousCameraPosition.xz ) );
			const previousFine = float( 1 ).sub( smoothstep( 60, 140, previousFar ) );
			const previousGeometric = float( 1 ).sub( smoothstep( 600, 1500, previousFar ) );
			const back = disps.map( ( now, c ) => {

				const v = cascade( fft.velocity, c, xz ).level( float( 0 ) ).xyz; // Ux, Uz, Vy
				return now.sub( vec3( v.x.mul( fft.chop ), v.z, v.y.mul( fft.chop ) ).mul( this.step ) );

			} );
			const dp = weighted( back, weights, previousFine ).mul( previousGeometric ).toVar();
			const shoreAt = xz.add( dp.xz );
			// (paused or across a cut the field baked before is not the previous frame's)
			const shorePrevious = mix( shoreWaves.surfaceAt( shoreAt, shared.time ).x, shoreWaves.previousSurfaceAt( shoreAt ).x, this.shoreHistory );
			const previous = vec3( xz.x.add( dp.x ), shared.waterLevel.add( dp.y ).add( shorePrevious ), xz.y.add( dp.z ) );
			// (the skirt's outer ring at the eye's height then and now, as the clip position has it; the
			// position stays the surface's, see `onHorizon`)
			const raised = ( p: V3, eye: F ) => vec3( p.x, mix( p.y, eye, onHorizon( xz ) ), p.z );
			// Weights of exactly 0 or 1, not select(): TSL turns a select of large operands into
			// branches, and `displaced`, first built inside one, was then declared in it only.
			material.positionNode = Fn( () => {

				positionPrevious.assign( mix( raised( displaced, cameraPosition.y ), raised( previous, motionUniforms.previousCameraPosition.y ), this.ownMotion ) );
				return displaced;

			} )();
			material.userData.previousPosition = true;

		}
		const vLag = varying( xz ), vWeights = varying( weights );
		// the meadow's gust at the grid point (SeaDetail.ts: its map read here, in the vertex stage)
		const vLandGust = varying( detail.landGust( xz ) );
		// the key's soft shadow at the grid point (the constants at SHADOW_SOFT_RADIUS): the map's
		// coordinate is an affine function of the world, so the disc's radii are its columns
		const toMap = sunShadow.coordinate;
		const vKeyShadow = varying( sunShadow.discVisibility(
			toMap.mul( vec4( xz.x, shared.waterLevel.add( SHADOW_LIFT ), xz.y, 1 ) ).xyz,
			toMap.mul( vec4( SHADOW_SOFT_RADIUS, 0, 0, 0 ) ).xyz,
			toMap.mul( vec4( 0, 0, SHADOW_SOFT_RADIUS, 0 ) ).xyz ) );
		const floorHeight = ( p: V2 ) => texture( seabedHeight, fieldUV( p ) ).level( float( 0 ) ).r;
		// How much deeper the open sea is taken to be than its floor at xz (m): OPEN_DEEPENING.
		// The depth grows as the light it lets through falls in a smoothstep (Beer-Lambert: the depth
		// is the log of that share), so the fade spreads over the whole way rather than happening in
		// its first metres.
		const openDeepening = ( p: V2 ) => {

			const p2 = p.mul( p );
			const s = smoothstep( openSea.from, openSea.to, sqrt( sqrt( dot( p2, p2 ) ) ) );
			return log2( float( 1 ).sub( s.mul( 1 - OPEN_DEEPENING.left ) ) ).mul( OPEN_DEEPENING.depth / Math.log2( OPEN_DEEPENING.left ) );

		};
		const windSpeed = shared.wind.breeze.mul( REFERENCE_SPEED );
		const FINE = fft.cascades - 1;
		const sum = <T extends F | V2 | V3 | V4>( terms: T[] ) => terms.reduce( ( a, b ) => ( a as V4 ).add( b ) as unknown as T );

		// ---- fragment
		const tDepth = texture( linearDepth );
		const depthSize = vec2( textureSize( tDepth ) as unknown as THREE.Node<'ivec2'> );
		const pixel = ( q: V2 ) => ivec2( clamp( q.mul( depthSize ), vec2( 0 ), depthSize.sub( 1 ) ) );
		const sceneViewZ = Fn( ( [ q ]: [ V2 ] ) => textureLoad( tDepth, pixel( q ) ).x )
			.setLayout( { name: 'sceneViewZ', type: 'float', inputs: [ { name: 'q', type: 'vec2' } ] } );
		// What lies behind the water at its own pixel: the farthest of the opaque samples. The sea is
		// drawn only into the samples it is in front of, so where a cliff or a figure covers part of
		// the pixel, the sea's samples hold what is behind them, not the figure of sample 0.
		const behindViewZ = textureLoad( tDepth, pixel( screenUV ) ).y;
		// (the scene's images hold radiance pre-exposed: read back in scene units, PreExposure.ts)
		const sceneAt = ( q: V2 ) => sceneUnits( texture( sceneColor, q ).level( float( 0 ) ).rgb );
		// The refraction pass's image at a screen uv, through its wider view (Refraction.ts): its
		// colour, filtered (premultiplied by its coverage, alpha), and the view z of its nearest texel.
		const G = REFRACTION_GUARD;
		const refractionColor = texture( refraction.color ), refractionDepth = texture( refraction.depth );
		const refractionSize = vec2( textureSize( refractionDepth ) as unknown as THREE.Node<'ivec2'> );
		const refractionUV = ( q: V2 ) => vec2( q.x.sub( 0.5 ).div( G.sx ).add( 0.5 - G.cx / ( 2 * G.sx ) ), q.y.sub( 0.5 ).div( G.sy ).add( 0.5 + G.cy / ( 2 * G.sy ) ) );
		const refractedAt = ( q: V2 ) => {

			const r = refractionUV( q ).toVar();
			const depth = textureLoad( refractionDepth, ivec2( clamp( r.mul( refractionSize ), vec2( 0 ), refractionSize.sub( 1 ) ) ), int( 0 ) ) as unknown as F;
			return { color: texture( refractionColor, r ).level( float( 0 ) ).toVar(), depth: depth.toVar() };

		};
		const viewZOf = ( depth: F ) => perspectiveDepthToViewZ( depth, cameraNear, cameraFar );

		// screen-space reflection of the opaque scene (cliffs, stacks): geometric steps, then bisection.
		// The steps grow with the distance (tidewater's stepScale: far away the first ones would all
		// land in the same pixel), and a ray stops at SSR_FARTHEST, where its hits weigh nothing.
		// The distance the march reaches near the camera: its last step.
		const ssrReach = 0.15 + 0.25 * ( Math.pow( quality.ssrGrowth, quality.ssrSteps ) - 1 ) / ( quality.ssrGrowth - 1 );
		const traceSSR = Fn( ( [ posV, Rv ]: [ V3, V3 ] ) => {

			const res = vec4( 0 ).toVar();
			// A zero grazing weight cannot contribute a reflection. Reuse the exact fade
			// below rather than marching those rays through the depth buffer.
			const directionWeight = smoothstep( 0.5, 0.1, Rv.z ).toVar();
			let marches = Rv.z.lessThanEqual( 0.6 ).and( directionWeight.greaterThan( 0 ) );
			const stepScale = max( posV.z.negate().div( 60 ), 1 ).toVar();
			// Where the ray is inside the box of what it can reflect (in world space: the view is rigid,
			// so distances along the ray are the same).
			const span = variant.cull || variant.clip ? rayBoxSpan( cameraWorldMatrix.mul( vec4( posV, 1 ) ).xyz,
				cameraWorldMatrix.mul( vec4( Rv, 0 ) ).xyz, this.reflectorMin, this.reflectorMax ).toVar() : vec2( 0, 1e9 );
			if ( variant.cull ) marches = marches.and( span.y.greaterThanEqual( max( span.x, 0 ) ) ).and( span.x.lessThanEqual( min( stepScale.mul( ssrReach ), SSR_FARTHEST ) ) );
			If( marches, () => {

				const t = stepScale.mul( 0.15 ).toVar(), dt = stepScale.mul( 0.25 ).toVar(), prevT = float( 0 ).toVar();
				const hit = float( 0 ).toVar();
				const step = () => {

					const p = posV.add( Rv.mul( t ) ).toVar();
					const q = projectView( p, cameraProjectionMatrix ).toVar();
					If( q.x.lessThan( 0 ).or( q.x.greaterThan( 1 ) ).or( q.y.lessThan( 0 ) ).or( q.y.greaterThan( 1 ) ).or( p.z.greaterThan( - 0.1 ) ), () => {

						Break();

					} );
					const sz = sceneViewZ( q ).toVar();
					If( p.z.lessThan( sz ).and( sz.sub( p.z ).lessThan( max( dt.mul( 1.4 ), 0.35 ) ) ), () => {

						hit.assign( 1 );
						Break();

					} );

				};
				Loop( quality.ssrSteps, () => {

					prevT.assign( t );
					If( prevT.greaterThanEqual( SSR_FARTHEST ), () => {

						Break();

					} );
					t.addAssign( dt );
					dt.mulAssign( quality.ssrGrowth );
					step();
					if ( variant.clip ) If( t.greaterThan( span.y ), () => {

						Break();

					} );

				} );
				If( hit.greaterThan( 0.5 ), () => {

					const a = prevT.toVar(), b = t.toVar();
					Loop( 5, () => {

						const m = a.add( b ).mul( 0.5 ).toVar();
						const p = posV.add( Rv.mul( m ) ).toVar();
						If( p.z.lessThan( sceneViewZ( projectView( p, cameraProjectionMatrix ) ) ), () => {

							b.assign( m );

						} ).Else( () => {

							a.assign( m );

						} );

					} );
					const hv = posV.add( Rv.mul( b ) ).toVar();
					const q = projectView( hv, cameraProjectionMatrix ).toVar();
					// the ray must really touch the surface there, within a gap that grows with the
					// distance as the steps do (tidewater's)
					const touch = smoothstep( max( b.mul( 0.04 ), 0.6 ), max( b.mul( 0.02 ), 0.15 ), abs( sceneViewZ( q ).sub( hv.z ) ) );
					const hw = cameraWorldMatrix.mul( vec4( hv, 1 ) ).xyz.toVar();
					const edge = smoothstep( 0, 0.06, q.x ).mul( smoothstep( 1, 0.94, q.x ) ).mul( smoothstep( 0, 0.06, q.y ) ).mul( smoothstep( 1, 0.94, q.y ) );
					const farFade = smoothstep( SSR_FARTHEST, 120, b );
					res.assign( vec4( sceneAt( q ), edge.mul( touch ).mul( directionWeight ).mul( farFade ) ) );
					// Where the ray meets the cliff below the sea's reach, it could only have got there
					// through the water it meets first. Falling back to the sky there (tidewater fades
					// the lowest 0.4 m, sized for cliffs ten times taller) drew a bright band along every
					// cliff foot. The sea at this island's cliffs is a near mirror in everyday weather,
					// so the reflected rock continues down to the waterline, and rock just below it shows
					// the rock where it leaves the water: the hit lifted to the waterline, if the depth
					// buffer confirms rock there (a cliff face, not open seabed). A gale's swell heaves
					// the surface at the rock by tens of centimetres; the reach grows with it and the
					// lifted rock gives way to the sky, as before, so a rough sea keeps its sky-lit facets.
					const gale = sat( shared.wind.gale ).toVar();
					const waterline = shared.waterLevel.add( mix( float( 0.03 ), float( 0.3 ), gale ) ).toVar();
					const above = smoothstep( shared.waterLevel.sub( gale.mul( 0.1 ) ), waterline, hw.y ).toVar();
					If( above.lessThan( 1 ), () => {

						const lifted = cameraViewMatrix.mul( vec4( hw.x, waterline, hw.z, 1 ) ).xyz.toVar();
						const ql = projectView( lifted, cameraProjectionMatrix ).toVar();
						const liftedTouch = float( 1 ).sub( smoothstep( 0.15, 0.6, abs( sceneViewZ( ql ).sub( lifted.z ) ) ) );
						// Deep hits (the seabed, rock seen past a downward-tilted facet) keep the sky.
						const shallow = smoothstep( shared.waterLevel.sub( 0.35 ), shared.waterLevel.sub( 0.15 ), hw.y ).mul( float( 1 ).sub( gale ) );
						// Weighted, so that a gale's sea (no lifted rock) blends exactly as before.
						const direct = res.a.mul( above ).toVar();
						const rock = res.a.mul( liftedTouch ).mul( shallow ).mul( float( 1 ).sub( above ) ).toVar();
						const weight = direct.add( rock ).toVar();
						res.assign( vec4( sceneAt( ql ).mul( rock ).add( res.rgb.mul( direct ) ).div( max( weight, 1e-4 ) ), weight ) );

					} );

				} );

			} );
			return res;

		} ).setLayout( { name: 'traceSSR', type: 'vec4', inputs: [ { name: 'posV', type: 'vec3' }, { name: 'Rv', type: 'vec3' } ] } );

		// the surface's metering illuminance, assigned inside the shading (from its sun's shadow and
		// clouds) and read by the outputs after it: a fragment-stage property, no varying
		const meter = property( 'float', 'WaterMeter' ) as unknown as THREE.Node<'float'>;
		material.fragmentNode = Fn( () => {

			const time = shared.time;
			const wp = positionWorld;

			// ---- everything that needs screen-space derivatives, while control flow is still uniform
			const footprint = max( length( fwidth( vLag ) ), 1e-4 ).toVar();
			const lagDx = dFdx( vLag ).toVar(), lagDy = dFdy( vLag ).toVar();
			// The storm foam's texture level: the pixel's area, not its longest side. At grazing angles
			// the longest side is many times the width and would blur the mat into a flat grey film.
			const foamFootprint = max( abs( lagDx.x.mul( lagDy.y ).sub( lagDx.y.mul( lagDy.x ) ) ).sqrt(), 1e-4 ).toVar();
			const shoreWave = shoreWaves.surfaceAt( wp.xz, time ).toVar();
			const rainGradient = rainRippleGradient( wp.xz, time, shared.rain, footprint ).toVar();
			// the cascades' slopes, each damped as its displacement is (the fine one by its physical
			// damping alone: its mips filter it with the distance)
			const ws = [ vWeights.x, vWeights.y, vWeights.z, vWeights.w ];
			const d = sum( [ 0, 1, 2, 3 ].map( ( c ) => cascade( fft.derivatives, c, vLag ).mul( ws[ c ] ) ) ).toVar();
			// the whitecaps' bubbly mat: two layers of the foam pattern at other scales and angles
			const fuv = vLag.mul( FOAM_SCALE ).toVar();
			const p1 = texture( storm.pattern, fuv ).toVar();
			const p2 = texture( storm.pattern, rotate( fuv, 0.6435 ).mul( 2.37 ).add( vec2( 0.31, 0.77 ) ) ).toVar();
			// the pattern of the foam at the rock, finer (SHORE_FOAM_SCALE)
			const ps = texture( storm.pattern, rotate( vLag.mul( SHORE_FOAM_SCALE ), 1.13 ).add( vec2( 0.57, 0.19 ) ) ).toVar();
			// the sea's large-scale detail: ( rough, gust, slick, streak ); the island's wave shadow
			// smooths the slopes no pixel resolves as it damps the finest cascade (WaveDamping.ts LEE)
			const sea = detail.sample( vLag, vLandGust ).toVar();
			const rough = sea.x.mul( vWeights.w );

			// ---- the normal: the cascades' slopes over their horizontal stretch (tidewater's
			// WaterSurface), the rock's reflected wave and the rain's rings in world xz
			const slopes = vec2( d.x.div( max( d.z.add( 1 ), 0.2 ) ), d.y.div( max( d.w.add( 1 ), 0.2 ) ) ).add( shoreWave.yz ).add( rainGradient ).toVar();
			// Near-field capillary ripples: within a few metres a pixel covers less than the finest
			// cascade's texel (about 3 cm) and the surface looks glassy; the finest cascade read again
			// at about 1 and 2.3 m tiles (NEAR_RIPPLES), turned so that they never line up with it;
			// damped in slicks with the short waves. They tilt the reflection and the glint only. Read
			// at those scales with the cascade's own slopes, they curve the surface three to seven times
			// as sharply as it does, and the refracted floor, seen through a metre or two of water, broke
			// into crumbs; at 4K every pixel of the island camera's view is under their 4 cm, so that was
			// all the shallows. The floor seen through real ripples that small and that quick is blurred
			// by them, not folded.
			const resolvedSlopes = vec2( slopes ).toVar();
			const near = smoothstep( 0.04, 0.01, footprint ).mul( rough ).toVar();
			If( near.greaterThan( 0.002 ), () => {

				const ripple = ( k: number, angle: number ) => {

					const texel = fft.sizes[ FINE ] / k / FFT_SIZE;
					return texture( fft.derivatives, rotate( vLag, angle ).mul( k / fft.sizes[ FINE ] ) ).depth( int( FINE ) )
						.level( max( log2( footprint.div( texel ) ), 0 ) ).xy;

				};
				slopes.addAssign( sum( NEAR_RIPPLES.map( ( r ) => rotate( ripple( r.scale, r.angle ), - r.angle ).mul( r.weight ) ) ).mul( near ) );

			} );
			const jac = d.z.add( 1 ).mul( d.w.add( 1 ) ).toVar();
			const toCam = cameraPosition.sub( wp ).toVar();
			const V = toCam.div( length( toCam ) ).toVar();
			// A facet turned away from the eye (a fold of the choppy surface) is bent to just past
			// grazing, not flipped: a flipped normal turns a fold into a white mirror of the sky.
			const N0 = normalize( vec3( slopes.x.negate(), 1, slopes.y.negate() ) );
			const unfold = ( n: V3 ) => normalize( n.add( V.mul( max( dot( n, V ).negate().add( 0.03 ), 0 ) ) ) );
			const N = unfold( N0 ).toVar();
			const Nrefracted = unfold( normalize( vec3( resolvedSlopes.x.negate(), 1, resolvedSlopes.y.negate() ) ) ).toVar();
			const L = shared.sunDir;
			const posV = cameraViewMatrix.mul( vec4( wp, 1 ) ).xyz.toVar();

			// ---- the key reaching the surface: through the clouds, on every path, and by the shadow's
			// soft read from the vertex stage, whole here (the terms' shares: SHADOW_SOFT_RADIUS)
			const cloudVisibility = sky.cloudVisibility( wp ).toVar();
			// the sea's key: the clouds' own over the land's floor (Sky.ts `seaKeyVisibility`, from the same
			// read); the clouds' own alone is what the deck's gaps let through of the sky (`inAmb`)
			const keyLight = shared.sunColor.mul( mix( sky.seaKeyFloor, float( 1 ), cloudVisibility ) ).toVar();
			const sunLight = keyLight.mul( vKeyShadow ).toVar();
			// the glint's: the key's direct beam alone, the light the cloud scatters on through being
			// diffuse (Sky.ts `cloudDirectVisibility`)
			const glintKey = shared.sunColor.mul( sky.cloudDirectVisibility( wp ) ).mul( vKeyShadow ).toVar();
			// the surface's metering illuminance (lighting/MeterLight.ts): a share of what a white card
			// laid level at the point would meter, the sky's upper hemisphere (its irradiance over pi)
			// and the key by the cosine level ground takes it by (the lifted key's, KeyLift.ts); no
			// reflection, no light from within the water. The key is the colour's (the clouds and the
			// sun's shadow in it). Zero in the ambient-only view, which reads the two terms apart.
			const meterSunTerm = AMBIENT_ONLY ? float( 0 ) : lum( sunLight ).mul( max( liftKeyWorld( L ).y, 0 ) ).mul( 1 / Math.PI );
			meter.assign( meterShare.mul( luminance( shared.skyIrradianceSource ).add( meterSunTerm ) ) );

			// ---- what lies straight behind this pixel (linear depth: view-space z, < -9e4 = sky)
			const z0 = behindViewZ.toVar();
			const skyBehind = z0.lessThan( - 9e4 );
			const ray0 = viewRay( screenUV, cameraProjectionMatrixInverse ).toVar();
			const sv0 = ray0.mul( z0.div( ray0.z ) ).toVar();
			const thick = select( skyBehind, float( 1e4 ), posV.z.sub( sv0.z ) ).toVar(); // view distance from the surface to whatever is behind it

			// ---- whitecaps: where the surface is compressed right now (tidewater's fresh foam), more
			// of them inside gusts, and the windrows' trace of foam; a threshold on the foam pattern so
			// that they grow and tear into lace; far away, the coverage itself. None without a cover:
			// the pattern's peaks reach past the threshold's soft edge, and a faint film of foam, lit as
			// a white scatterer under the full sun, showed as pale blotches a metre across on the calm
			// shallows.
			const fresh = sat( fft.foamBias.sub( 0.15 ).sub( jac ).mul( 2 ) );
			const coverage = sat( fresh.mul( mix( float( 0.5 ), float( 1.5 ), sea.y ) ).add( sea.w.mul( 0.5 ) ).mul( u.foamCoverage ) );
			const threshold = float( 1.05 ).sub( coverage.mul( 1.1 ) );
			const soft = footprint.mul( 0.1 ).add( 0.06 );
			const mat = smoothstep( threshold.sub( soft ), threshold.add( soft ), p1.x.mul( 0.62 ).add( p2.x.mul( 0.38 ) ) ).mul( p1.y.mul( 0.25 ).add( 0.8 ) );
			const foam = mix( mat.mul( smoothstep( 0, 0.05, coverage ) ), coverage.mul( 0.85 ), smoothstep( 0.15, 1.2, footprint ) ).toVar();
			// the foam the waves leave at the rock (ShoreWaves): a fresh burst, the pattern's bubbly mat,
			// the foam lingering from the waves before, the pattern's lace, finer than the whitecaps' (a rock churns the foam
			// finer than a breaking crest does); far away, its cover
			const white = sat( shoreWave.w.mul( u.shoreFoam ) ).toVar();
			// (the mat only above a cover of 0.3, from a burst; the lace from the first trace; none
			// without a cover, where the pattern's veins reach 1)
			// (softer edges than the whitecaps': up close a rock's foam frays into fine bubbles)
			const matEdge = float( 1.2 ).sub( white ).toVar(), laceEdge = float( 1 ).sub( white.mul( 1.3 ) ).toVar(), shoreSoft = soft.add( 0.1 ).toVar();
			const shoreMat = smoothstep( matEdge.sub( shoreSoft ), matEdge.add( shoreSoft ), ps.x );
			const shoreLace = smoothstep( laceEdge.sub( shoreSoft ), laceEdge.add( shoreSoft ), ps.y );
			// (thin foam lets the water show through; its pattern's cells fall below a pixel some three
			// times sooner than the whitecaps')
			const shoreFoam = max( shoreMat, shoreLace.mul( 0.75 ) ).mul( ps.z.mul( 0.3 ).add( 0.75 ) ).mul( white.mul( 0.35 ).add( 0.5 ) ).mul( smoothstep( 0, 0.05, white ) );
			foam.assign( max( foam, mix( shoreFoam, white.mul( 0.6 ), smoothstep( 0.05, 0.4, footprint ) ) ) );

			// ---- roughness: the slopes no pixel resolves at this distance (Cox-Munk's mean square
			// slope 0.003 + 0.00512 U, the share finer than the pixel's wavenumber, scaled by the
			// gusts and slicks) over the base
			const mss = windSpeed.mul( COX_MUNK.perWind ).add( COX_MUNK.base );
			const unresolvedShare = sat( log2( footprint.mul( 110 / PI ) ).div( 9 ) ).toVar();
			const unresolved = unresolvedShare.mul( rough.mul( rough ) ).toVar();
			// (Cox-Munk's mean square slope over both axes is Beckmann's alpha^2 itself; the moon's alpha
			// takes twice it, of a smaller share of those slopes: MOON_UNRESOLVED)
			const alpha2 = u.roughness.mul( u.roughness ).add( mss.mul( mix( float( 2 ), float( 1 ), keyChroma ) ).mul( unresolved ).mul( mix( float( MOON_UNRESOLVED ), float( 1 ), keyChroma ) ) ).add( foam.mul( 0.2 ) ).toVar();
			const sigmaUnresolved = sqrt( mss.mul( unresolved ) ).toVar();
			// the mean surface's: the same share of the sea's slopes, before the waves' damping
			const sigmaMean = sqrt( mss.mul( unresolvedShare ).mul( sea.x.mul( sea.x ) ) ).toVar();

			const NdV = max( dot( N, V ), 1e-4 ).toVar();
			const Fr = fresnelDielectric( NdV, float( IOR ) ).toVar();

			// ---- reflection
			const Rraw = reflect( V.negate(), N ).toVar();
			// How the reflected direction turns across a quarter of the pixel, diagonally (taken here,
			// while control flow is uniform): the screen-space reflection traces a ray on either side.
			const reflectionJitter = dFdx( Rraw ).add( dFdy( Rraw ) ).mul( 0.25 ).toVar();
			// The mean surface's reflection over the slopes the pixel does not resolve (REFLECTION_LOBE):
			// the slopes' spread along the view, the visible facets' mean cosine, the lobe's lift, width
			// and shadowing (whose mean Fresnel the water's blend takes below).
			const sigmaV = max( sigmaMean.mul( Math.SQRT1_2 ).mul( lobeSlopeScale ), 1e-5 ).toVar();
			const cosMean = max( V.y, 1e-4 ).toVar();
			const m = cosMean.div( sigmaV ).toVar();
			const cdfM = normalCdf( m ).toVar(), pdfM = normalPdf( m ).toVar();
			const e1 = cosMean.mul( cdfM ).add( sigmaV.mul( pdfM ) );
			const e2 = cosMean.mul( cosMean ).add( sigmaV.mul( sigmaV ) ).mul( cdfM ).add( cosMean.mul( sigmaV ).mul( pdfM ) );
			const cosVisible = min( e2.div( e1 ), 1 ).toVar();
			const lift = cosVisible.sub( cosMean ).mul( lobeLift ).toVar();
			const lobeY = min( cosMean.add( lift ), 1 ).toVar();
			const lobeW = sigmaV.mul( 2 ).toVar();
			const lobeShadow = smithG1( lobeY.sub( lobeW ), sigmaV ).mul( 0.25 ).add( smithG1( lobeY, sigmaV ).mul( 0.5 ) )
				.add( smithG1( lobeY.add( lobeW ), sigmaV ).mul( 0.25 ) ).toVar();
			// The pixel's own mirror, lifted as the mean surface's lobe is; its share over the horizon
			// reads the sky over the lobe's width, the rest meets other waves and takes the darkened
			// horizon (and a sheet of water thinner than a quarter metre keeps the sky).
			const lobeUp = min( Rraw.y.add( lift ), 1 ).toVar();
			const thickness = wp.y.sub( floorHeight( wp.xz ) ).toVar();
			const skyShare = max( normalCdf( lobeUp.div( max( lobeW, REFLECTION_LOBE.edge ) ) ), smoothstep( 0.25, 0.06, thickness ) ).toVar();
			const skyReflection = vec3( 0 ).toVar();
			// (a share under a thousandth reads no sky)
			If( skyShare.greaterThan( 1e-3 ), () => {

				const y = max( lobeUp, 0.004 ).toVar();
				const across = normalize( Rraw.xz.add( vec2( 1e-5, 0 ) ) ).mul( sqrt( float( 1 ).sub( y.mul( y ) ) ) );
				const mip = log2( max( min( lobeW, y ).div( panoramaTexel ), 1 ) );
				skyReflection.assign( sky.sample( vec3( across.x, y, across.y ), mip ) );

			} );
			// (the band at the mirror's own elevation, what the flat sea here reflects)
			const horizon = sky.sampleBackground( normalize( vec3( Rraw.x, V.y, Rraw.z ).add( vec3( 1e-5, 0, 0 ) ) ), float( HORIZON_MIP ) );
			const bandRamp = smoothstep( 0, REFLECTION_BAND.ramp, V.y ).toVar();
			// (a low sun's lift of the sky's light, shared.ts `skyLift`, by the band's ramp: the far sea
			// keeps the band it mirrors and stays under the sky over the horizon; written 1 + ( lift - 1 )
			// ramp, exactly 1 where there is no lift)
			// (the night sky as the dome draws it, shared.ts `seenNight`, faded in with the distance:
			// the far sea meets the seen sky at the horizon, the near sea keeps the light the sky
			// sheds; written 1 + ( seen - 1 ) fade, exactly 1 by day)
			const seenSky = shared.seenNight.sub( 1 ).mul( smoothstep( SEEN_SKY.near, SEEN_SKY.far, length( toCam ) ) ).add( 1 );
			const refl = mix( horizon.mul( BELOW_HORIZON ), skyReflection, skyShare )
				.mul( shared.skyLift.sub( 1 ).mul( bandRamp ).add( 1 ) ).mul( seenSky ).toVar();
			// The cliffs and the islanders from the screen: only rays near the horizon can meet them,
			// and where the reflectance is small the reflection cannot be seen (tidewater's gate).
			If( u.ssr.greaterThan( 0.5 ).and( Rraw.y.lessThan( 0.45 ) ).and( Fr.greaterThan( quality.ssrMinFresnel ) ), () => {

				// Two rays a quarter pixel either side of the pixel's centre, averaged: a ray either hits
				// the island or shows the sky, so with one ray per pixel the reflected island's edge and
				// the sky seen through it between the waves were pixel stair-steps and single bright
				// specks. Two rays give the edges a half step and halve a lone speck. The offsets are
				// fixed, so a paused frame repeats. The lower tiers take the one ray through the centre,
				// and so does a pixel whose reflectance is under ssrOneRayFresnel. The first ray moves
				// to the centre when it is alone, so the march is built twice, not three times. Nothing
				// of it is built unless ssrOneRayFresnel is above ssrMinFresnel.
				if ( quality.ssrRays === 1 ) {

					const rc = traceSSR( posV, normalize( cameraViewMatrix.mul( vec4( Rraw, 0 ) ).xyz ) ).toVar();
					refl.assign( mix( refl, rc.rgb, rc.a ) );

				} else if ( quality.ssrOneRayFresnel > quality.ssrMinFresnel ) {

					const both = step( quality.ssrOneRayFresnel, Fr ).toVar();
					const ra = traceSSR( posV, normalize( cameraViewMatrix.mul( vec4( Rraw.sub( reflectionJitter.mul( both ) ), 0 ) ).xyz ) ).toVar();
					const first = mix( refl, ra.rgb, ra.a ).toVar();
					If( both.greaterThan( 0.5 ), () => {

						const rb = traceSSR( posV, normalize( cameraViewMatrix.mul( vec4( Rraw.add( reflectionJitter ), 0 ) ).xyz ) ).toVar();
						refl.assign( first.add( mix( refl, rb.rgb, rb.a ) ).mul( 0.5 ) );

					} ).Else( () => {

						refl.assign( first );

					} );

				} else {

					const ra = traceSSR( posV, normalize( cameraViewMatrix.mul( vec4( Rraw.sub( reflectionJitter ), 0 ) ).xyz ) ).toVar();
					const rb = traceSSR( posV, normalize( cameraViewMatrix.mul( vec4( Rraw.add( reflectionJitter ), 0 ) ).xyz ) ).toVar();
					refl.assign( mix( refl, ra.rgb, ra.a ).add( mix( refl, rb.rgb, rb.a ) ).mul( 0.5 ) );

				}

			} );
			refl.mulAssign( u.reflection );

			// ---- the key's specular: Beckmann's (Gaussian) distribution of the slopes' alpha^2 under
			// the sun and the moon; under the sun with Beckmann's own Smith shadowing (smithG1 per axis
			// of spread sqrt( alpha^2 / 2 ), separable), under the moon with GGX's visibility and a soft
			// ceiling, the values set for the moon (MOON_UNRESOLVED, MOON_KNEE); the shadowed light above
			const H = normalize( L.add( V ) );
			const NdL = max( dot( N, L ), 0 ).toVar();
			const NdH = max( dot( N, H ), 0 ).toVar();
			const sBeckmann = sqrt( alpha2.mul( 0.5 ) ).toVar();
			const vBeckmann = smithG1( NdL, sBeckmann ).mul( smithG1( NdV, sBeckmann ) ).div( max( NdL.mul( NdV ).mul( 4 ), 1e-5 ) );
			const spec = D_Gaussian( NdH, alpha2 ).mul( mix( V_SmithGGX( NdL, NdV, alpha2 ), vBeckmann, keyChroma ) )
				.mul( fresnelDielectric( max( dot( V, H ), 0 ), float( IOR ) ) ).mul( NdL );
			// (physically a glint is some 1e5 times the sky; held inside half float's range)
			const glintLight = mix( vec3( luminance( glintKey ) ), glintKey, keyChroma ).toVar();
			const glint = min( spec, 400 ).toVar();
			const knee = mix( float( MOON_KNEE ), float( 0 ), keyChroma );
			const sunSpec = glintLight.mul( glint.div( glint.mul( knee ).add( 1 ) ) ).toVar();

			// ---- refraction: the refracted view ray (Snell; kept heading down where a coarse crest
			// would turn it up) followed to the floor, two refinements on the floor's height, its end
			// projected to the screen. The refraction image there serves where it lies behind the
			// surface (it holds nothing above the water to stand in front); where the end lies on
			// something in front of the surface (a stone nearer the eye), what lies straight behind
			// in that image; where the image holds nothing there (the shallows above its clip height,
			// the sky), the opaque image at the end where it lies behind the surface, else straight
			// behind.
			const Tr = refract( V.negate(), Nrefracted, 1 / IOR );
			const Tv = normalize( vec3( Tr.x, min( Tr.y, - 0.08 ), Tr.z ) ).toVar();
			const tDown = max( Tv.y.negate(), 0.04 ).toVar();
			const L0 = max( thickness, 0 ).div( tDown ).toVar();
			const Lt = L0.toVar();
			If( L0.lessThan( 100 ), () => {

				const L1 = max( wp.y.sub( floorHeight( wp.xz.add( Tv.xz.mul( min( L0, 200 ) ) ) ) ), 0 ).div( tDown );
				Lt.assign( max( wp.y.sub( floorHeight( wp.xz.add( Tv.xz.mul( min( L1.mul( 0.5 ).add( L0.mul( 0.5 ) ), 200 ) ) ) ) ), 0 ).div( tDown ) );

			} );
			const Lter = clamp( Lt, 0, 400 ).toVar();
			const Lend = min( Lter, 80 ).toVar();
			const endV = cameraViewMatrix.mul( vec4( wp.add( Tv.mul( Lend ) ), 1 ) ).xyz.toVar();
			const uvR = projectView( endV, cameraProjectionMatrix ).toVar();
			const onScreen = uvR.x.greaterThan( 0 ).and( uvR.x.lessThan( 1 ) ).and( uvR.y.greaterThan( 0 ) ).and( uvR.y.lessThan( 1 ) );
			// The footprint of the pixel at the refracted end, for the underwater pyramid's filtered
			// read (taken here, before any branch): how the end moves to the neighbouring pixels, each
			// step widened by the blur of the slopes the pixel cannot resolve. Those tilt the
			// refracted ray by about a quarter of their slope (1 - 1 / IOR), so along the path through
			// the water they spread the end over 0.25 sigma L metres (one standard deviation), which
			// the end's distance turns into pixels. Near the eye the pixel resolves the slopes and the
			// floor keeps its full sharpness.
			const p11 = ( cameraProjectionMatrix as unknown as { element( i: number ): { element( i: number ): F } } ).element( 1 ).element( 1 );
			const blur = sigmaUnresolved.mul( 0.25 ).mul( Lend ).mul( p11 ).mul( depthSize.y.mul( 0.5 ) ).div( max( endV.z.negate(), 0.1 ) ).toVar();
			const widen = ( g: V2 ) => {

				const px = max( length( g.mul( depthSize ) ), 1e-3 );
				return g.mul( sqrt( px.mul( px ).add( blur.mul( blur ) ) ).div( px ) ).toVar();

			};
			const endDx = widen( dFdx( uvR ) ), endDy = widen( dFdy( uvR ) );
			// The floor's forward-scattered image (WATER_BODY, the floor's image): the same footprint widened by the
			// spread the particles' small-angle scattering gives the floor over the path, sigma^2 =
			// b_f theta^2 L^3 / ( 3 ( 1 - exp( - b_f L ) ) ) metres along one axis, in pixels at the end
			const Lscatter = max( Lend, 0.05 ).toVar();
			const bfL = Lscatter.mul( shared.forwardScatter ).toVar();
			const spread = Lscatter.mul( shared.forwardAngle ).mul( sqrt( bfL.div( float( 1 ).sub( exp( bfL.negate() ) ).mul( 3 ) ) ) );
			const blurScatter = spread.mul( p11 ).mul( depthSize.y.mul( 0.5 ) ).div( max( endV.z.negate(), 0.1 ) ).toVar();
			const widenScattered = ( g: V2 ) => {

				const px = max( length( g.mul( depthSize ) ), 1e-3 );
				return g.mul( sqrt( px.mul( px ).add( blur.mul( blur ) ).add( blurScatter.mul( blurScatter ) ) ).div( px ) ).toVar();

			};
			const scatDx = widenScattered( dFdx( uvR ) ), scatDy = widenScattered( dFdy( uvR ) );
			const behind = ( z: F ) => z.lessThan( posV.z.sub( WATER_BEHIND ) );
			const sceneCol = vec3( 0 ).toVar();
			const sceneBlur = vec3( 0 ).toVar(); // the floor's forward-scattered image (WATER_BODY)
			const uvF = vec2( screenUV ).toVar();
			const zF = z0.toVar();
			const found = float( 0 ).toVar();
			if ( variant.refraction ) {

				// What lies under the sea is taken from the underwater pyramid (Pipeline.ts) wherever the
				// end lies on the screen: the opaque pass drew the world under the sea at the render's
				// resolution and samples, where the refraction image has half its pixel density and
				// one sample, so the floor, its stones and its light read nine times coarser than the
				// land at 4K. The pyramid is read over the pixel's footprint at the end (endDx, endDy:
				// anisotropic, its mips): where the surface's slopes throw the ends of neighbouring
				// pixels apart, a read at a point skipped most of what lay between them and broke the
				// floor's edges and cobbles into crumbs, as a texture without mips shimmers in the
				// distance; over the footprint it averages them, as the eye does. Divided by its weight,
				// the read is the average of what lies under the sea there: what stands above the water
				// in the opaque image (a cliff, the rim's grass, a figure) is left out of it.
				// The refraction image serves where the opaque image does not hold the floor: behind
				// what stands above the water, and off the screen. It is shaded only there (the
				// refraction mask, Pipeline.ts), so where the opaque pixel at a lookup drew what lies
				// under the sea (its pyramid weight 1) the depth comes from the opaque pass too, and
				// a colour read where the refraction image was masked (its coverage 0) is the
				// pyramid's alone. Straight behind (an end in front of the surface, by the cliffs) is
				// read at the same footprint as its refracted neighbours, so it neither stands out
				// sharper nor softer.
				const tUnderwater = texture( underwater );
				const lookup = ( q: V2, onImage: B ) => {

					const r = refractedAt( q );
					const texel = pixel( q );
					const opaque = onImage.and( textureLoad( tUnderwater, texel, int( 0 ) ).a.greaterThan( 0.999 ) ).toVar();
					const z = select( opaque, textureLoad( tDepth, texel ).x, viewZOf( r.depth ) ).toVar();
					const covered = opaque.or( r.color.a.greaterThan( 0.5 ).and( r.depth.lessThan( 1 ) ) ).toVar();
					const color = r.color.rgb.div( max( r.color.a, 1e-4 ) ).toVar();
					const colorBlur = color.toVar();
					If( onImage, () => {

						const f = tUnderwater.sample( q ).grad( endDx, endDy ).toVar();
						const w = select( r.color.a.greaterThan( 0.5 ), smoothstep( 0.02, 0.15, f.a ), float( 1 ) );
						color.assign( mix( color, f.rgb.div( max( f.a, 1e-4 ) ), w ) );
						const fb = tUnderwater.sample( q ).grad( scatDx, scatDy ).toVar();
						const wb = select( r.color.a.greaterThan( 0.5 ), smoothstep( 0.02, 0.15, fb.a ), float( 1 ) );
						colorBlur.assign( mix( colorBlur, fb.rgb.div( max( fb.a, 1e-4 ) ), wb ) );

					} );
					return { color: sceneUnits( color ), colorBlur: sceneUnits( colorBlur ), z, covered };

				};
				// What swims in the water (Refraction.ts markSwimmer) is drawn in the opaque image alone,
				// where its material places it as the eye sees it through the waves (swimmerSway), so
				// the water shows it straight behind its pixel; the pyramid leaves it out, and the floor
				// behind it comes from the refraction image (the mask keeps it there). Followed down the
				// refracted ray instead, a fish a few centimetres wide fell between the march's steps
				// and came apart, and the work for it here slowed the whole sea by a few tenths of a
				// millisecond where nothing swam (a branch's registers count wherever the shader runs).
				// (only where the pyramid's level 3 holds something besides the floor around the pixel,
				// as it does around a swimmer: the open sea reads nothing more; gated by the distance to
				// what lies behind, the pixels at a fish's edge, which the farthest of their samples
				// shows behind it, were lost)
				If( tUnderwater.sample( screenUV ).level( float( 3 ) ).a.lessThan( 0.999 ), () => {

					const behindTexel = pixel( screenUV );
					const swimmer = textureLoad( texture( sceneColor ), behindTexel, int( 0 ) ).toVar();
					const zSwimmer = textureLoad( tDepth, behindTexel ).x.toVar();
					If( swimmer.a.lessThan( 0.999 ).and( behind( zSwimmer ) ), () => {

						sceneCol.assign( sceneUnits( swimmer.rgb ) );
						sceneBlur.assign( sceneCol );
						zF.assign( zSwimmer );
						found.assign( 1 );

					} );

				} );
				If( found.lessThan( 0.5 ), () => {

					const end = lookup( uvR, onScreen );
					If( end.covered.and( behind( end.z ) ), () => {

						sceneCol.assign( end.color );
						sceneBlur.assign( end.colorBlur );
						uvF.assign( uvR );
						zF.assign( end.z );
						found.assign( 1 );

					} ).ElseIf( end.covered, () => {

						const straight = lookup( screenUV, bool( true ) );
						If( straight.covered.and( behind( straight.z ) ), () => {

							sceneCol.assign( straight.color );
							sceneBlur.assign( straight.colorBlur );
							zF.assign( straight.z );
							found.assign( 1 );

						} );

					} );

				} );

			}
			If( found.lessThan( 0.5 ), () => {

				const zR = sceneViewZ( uvR ).toVar();
				const valid = onScreen.and( behind( zR ) ).toVar();
				uvF.assign( select( valid, uvR, screenUV ) );
				zF.assign( select( valid, zR, z0 ) );
				sceneCol.assign( sceneAt( uvF ) );
				sceneBlur.assign( sceneCol );

			} ).Else( () => {

				// A thin sheet of water over rock: the refraction offset is a few pixels at most and
				// nothing stands between the sheet and the rock, so the opaque pass's own image of
				// the rock serves (the refraction image leaves out everything above its clip height,
				// and switching between the two drew a line across the rock along that height).
				const film = float( 1 ).sub( smoothstep( 0.04, 0.3, thickness ) ).toVar();
				If( film.greaterThan( 0 ), () => {

					const uvO = select( onScreen.and( behind( sceneViewZ( uvR ) ) ), uvR, screenUV );
					const rock = sceneAt( uvO ).toVar();
					sceneCol.assign( mix( sceneCol, rock, film ) );
					sceneBlur.assign( mix( sceneBlur, rock, film ) );

				} );

			} );
			// what stands in front of the floor (stones, the cliff's foot) shortens the path
			const rayF = viewRay( uvF, cameraProjectionMatrixInverse ).toVar();
			// and off the shelf the water deepens (OPEN_DEEPENING) the path down the refracted ray
			const deepening = openDeepening( wp.xz.add( Tv.xz.mul( Lend ) ) ).div( tDown );
			const pathLen = clamp( min( Lter, length( rayF.mul( zF.div( rayF.z ) ).sub( posV ) ) ).add( deepening ), 0, 400 ).toVar();

			// ---- the water body: Lee et al.'s shallow-water model along the refracted view (WATER_BODY)
			// (the body's light: its share of the shadow, SHADOW_BODY)
			const bodyShare = mix( float( 1 ), float( SHADOW_BODY ), smoothstep( ...SHADOW_BODY_DEPTH, thickness ) );
			const bodyLight = keyLight.mul( mix( float( 1 ), vKeyShadow, bodyShare ) ).toVar();
			const kappa = shared.sigA.add( shared.bb ).toVar();
			const ub = shared.bb.div( kappa ).toVar();
			const rrsDeep = ub.mul( WATER_BODY.rrs[ 1 ] ).add( WATER_BODY.rrs[ 0 ] ).mul( ub ).toVar();
			const duColumn = sqrt( ub.mul( WATER_BODY.column[ 1 ] ).add( 1 ) ).mul( WATER_BODY.column[ 0 ] ).toVar();
			const duFloor = sqrt( ub.mul( WATER_BODY.floor[ 1 ] ).add( 1 ) ).mul( WATER_BODY.floor[ 0 ] ).toVar();
			const Ls = refract( L.negate(), vec3( 0, 1, 0 ), 1 / IOR ).negate().toVar(); // toward the sun from under the water
			const muS = max( Ls.y, 0.1 ).toVar(), muV = max( Tv.y.negate(), 0.15 ).toVar();
			const depthV = pathLen.mul( muV ).toVar(); // the water's depth under the surface along the view
			// the sun's light into the water: the key's share through a level surface (1 - F times the
			// refracted beam's cosine over its area); times the refracted sun's cosine, the irradiance just
			// under the surface, E_d( 0- )
			const sunIn = bodyLight.mul( float( 1 ).sub( fresnelDielectric( max( L.y, 0.02 ), float( IOR ) ) ) ).mul( refractedSunBeamScaleNode( L ) );
			const edSun = sunIn.mul( muS ).toVar();
			// the sky's, pi times its radiance's mean (`skyIrradianceSource` is E / pi), through the
			// surface at its diffuse transmittance (SKY_INTO_WATER): the sky as the surface sees it and
			// reflects it, under a deck too
			const edSky = shared.skyIrradianceSource.mul( PI * SKY_INTO_WATER ).toVar();
			// the floor through the column (WATER_BODY, the floor's image): Lee's floor term, its unscattered share
			// exp( - c L ) sharp and the rest from the forward-scattered image
			const floorLeft = exp( kappa.mul( duFloor ).mul( pathLen ).negate() ).toVar();
			const floorDirect = min( exp( shared.sigA.add( shared.scatter ).mul( pathLen ).negate() ), floorLeft ).toVar();
			const floorSeen = sceneCol.mul( floorDirect ).add( sceneBlur.mul( floorLeft.sub( floorDirect ) ) ).toVar();
			const bodySun = edSun.mul( rrsDeep ).mul( float( 1 ).sub( exp( kappa.mul( depthV.div( muS ).add( duColumn.mul( pathLen ) ) ).negate() ) ) ).toVar();
			const bodySky = edSky.mul( rrsDeep ).mul( float( 1 ).sub( exp( kappa.mul( depthV.mul( SKY_PATH ).add( duColumn.mul( pathLen ) ) ).negate() ) ) ).toVar();
			// (the radiance under the surface leaves it at 1 / n^2; the surface's 1 - F is the blend's below)
			const transmitted = floorSeen.add( bodySun ).add( bodySky ).mul( 1 / ( IOR * IOR ) ).toVar();

			// ---- foam: a bright diffuse scatterer (albedo 0.85) under the wrapped sun and the sky
			const foamLight = keyLight.mul( min( vKeyShadow.mul( FOAM_SHADOW_GAIN ), 1 ) );
			const foamLit = foamLight.mul( max( dot( N, L ), 0 ).mul( 0.75 ).add( 0.25 ) ).div( PI ).add( shared.skyIrradianceSource.mul( 0.95 ) ).mul( 0.85 ).toVar();
			// (the mean Fresnel over the visible facets, shadowed: REFLECTION_LOBE)
			const meanFresnel = Fr.mul( fresnelDielectric( cosVisible, float( IOR ) ).div( fresnelDielectric( cosMean, float( IOR ) ) ) ).mul( lobeShadow ).toVar();
			const water = mix( transmitted, refl, meanFresnel ).add( sunSpec );
			const col = mix( water, foamLit.mul( u.foamIntensity ).add( sunSpec.mul( 0.05 ) ), sat( foam ) ).toVar();
			// (temporal modes) the glints' reactive weight: their luminance against a white diffuse
			// surface under the same sun and sky (the note at the top)
			const reactive = TEMPORAL ? smoothstep( reactiveUniforms.glintFrom, reactiveUniforms.glintTo, lum( glintLight.mul( glint ) )
				.div( max( lum( shared.skyIrradianceSource.add( sunLight.mul( max( L.y, 0 ) ).div( PI ) ) ), 1e-6 ) ) ).mul( reactiveUniforms.glintMax ) : null;

			// Whitecaps in a storm (Tessendorf's choppy-wave criterion: the horizontal Jacobian of the
			// summed cascades nears a fold). StormSea integrates where the steepest crests break and
			// the foam that trails behind a breaker and fades over seconds; this pixel's own fold
			// sharpens the crest inside the breaking cells it reports. Two looks, as on a real sea:
			// at the crest a dense bubbly mat (tidewater's WaterSurface thresholds it by the fresh
			// breaking, so it grows and tears with ragged, soft edges), behind it a marbled lace of
			// veins around dark open cells, drawn out along the wind, whose veins thin as the foam
			// decays. Old foam never closes back into a mat, so between the crests the sea stays dark.
			If( shared.storm.greaterThan( 0.001 ), () => {

				const fold = jac;
				const wind = shared.wind.direction;
				const along = dot( vLag, wind ).toVar(), across = dot( vLag, vec2( wind.y.negate(), wind.x ) ).toVar();
				const field = storm.foamAt( vLag, foamFootprint ).toVar(); // persistent, breaking, weight
				const scale = storm.patternScale;
				const patternLevel = log2( max( foamFootprint.mul( scale ).mul( storm.patternSize ), 1e-4 ) ).toVar();
				const streakLevel = log2( max( foamFootprint.mul( 0.11 ).mul( storm.patternSize ), 1e-4 ) ).toVar();
				// Large soft patches (the pattern's mottling, some 250 m across) stand in for the
				// field's wave groups beyond its window, where only this pixel's fold can find a crest.
				const patches = texture( storm.pattern, vLag.mul( 0.004 ).add( 0.37 ) ).level( streakLevel.sub( 4.8 ).max( 0 ) ).z.toVar();
				const farCrest = clamp( float( 0.88 ).sub( fold ).mul( 6 ), 0, 1 ).mul( smoothstep( 0.5, 0.62, patches ) )
					.mul( float( 1 ).sub( field.z ) ).mul( 0.75 );
				const sharpen = smoothstep( 1.0, 0.78, fold );
				const aged = clamp( field.x.mul( field.z ).mul( storm.coverage ), 0, 1 ).toVar();
				// The mat covers the breaking crest and, for a second or so after it has passed, the
				// thick foam it left (the field's foam stays near 1 there) before that tears into lace.
				const crest = clamp( max( max( field.y.mul( field.z ).mul( sharpen.mul( 0.8 ).add( 0.6 ) ), smoothstep( 0.55, 1, aged ).mul( 0.8 ) ),
					farCrest ).mul( storm.coverage ), 0, 1 ).toVar();
				const soft = foamFootprint.mul( 0.1 ).add( 0.07 ).toVar();
				// The mat: two layers of the pattern at different scales and angles (explicit levels
				// from the footprint, since this is a branch). Thin at its torn edges, dense inside.
				const fuv = vLag.mul( scale ).toVar();
				const p1 = texture( storm.pattern, fuv ).level( patternLevel ).toVar();
				const merged = quality.stormFoam === 'merged';
				let matPattern: F = p1.x;
				if ( ! merged ) {

					const r2 = vec2( fuv.x.mul( 0.8 ).sub( fuv.y.mul( 0.6 ) ), fuv.x.mul( 0.6 ).add( fuv.y.mul( 0.8 ) ) );
					const p2 = texture( storm.pattern, r2.mul( 2.37 ).add( vec2( 0.31, 0.77 ) ) ).level( patternLevel.add( Math.log2( 2.37 ) ) ).toVar();
					matPattern = p1.x.mul( 0.62 ).add( p2.x.mul( 0.38 ) );

				}
				const threshold = float( 1.02 ).sub( crest.mul( 0.78 ) );
				const mat = smoothstep( threshold.sub( soft ), threshold.add( soft ), matPattern )
					.mul( smoothstep( threshold, threshold.add( 0.25 ), matPattern ).mul( 0.35 ).add( 0.65 ) ).mul( 0.95 );
				// The lace, stretched 2.4 times along the wind. A vein's width follows the foam left;
				// a thin film of bubbles lets the water show through, so lace is never fully opaque.
				// (Merged, the mat's own fetch carries the lace, unstretched.)
				const lscale = scale * 1.1;
				const lace = merged ? p1.y : texture( storm.pattern, vec2( along.mul( lscale / 2.4 ), across.mul( lscale ) ).add( vec2( 0.13, 0.58 ) ) )
					.level( patternLevel.add( Math.log2( 1.1 ) ) ).y;
				const veinWidth = aged.mul( 0.5 ).toVar();
				const veinOpacity = aged.mul( 0.45 ).add( 0.4 ).mul( smoothstep( 0.02, 0.12, aged ) ).toVar();
				const veins = smoothstep( float( 1 ).sub( veinWidth ).sub( soft ), float( 1 ).sub( veinWidth ).add( soft ), lace ).mul( veinOpacity );
				// At a distance the pattern averages out: the veins become their mean coverage, and the
				// mat the crest itself, sharpened so that a distant whitecap stays a small white fleck
				// on its crest rather than a grey film.
				const laceMean = veinWidth.mul( veinOpacity ).mul( 0.5 );
				const far = smoothstep( 0.15, 1.2, foamFootprint ).toVar();
				const near = max( mix( mat, smoothstep( 0.08, 0.6, crest ).mul( 0.85 ), far ), mix( veins, laceMean, far ) );
				// Fine streaks a few tens of metres long where foam has been, and far out in the rough
				// patches between, where they are what is left of the whitecaps.
				const streak = texture( storm.pattern, vec2( along.mul( 0.012 ), across.mul( 0.11 ) ) ).level( streakLevel ).w;
				const rough = float( 1 ).sub( smoothstep( 0.8, 1.02, fold ) );
				const streaks = smoothstep( 0.6, 0.78, streak )
					.mul( clamp( aged.mul( 1.2 ).add( rough.mul( smoothstep( 0.5, 0.62, patches ) ).mul( 0.3 ) ), 0, 1 ) ).mul( 0.25 );
				const foam = clamp( max( near, streaks ).mul( smoothstep( 0, 0.6, shared.storm ) ), 0, 0.95 );
				// A diffuse off-white lit by the scene's key light (shadowed by the island and the clouds)
				// and by the sky, like the island's surfaces: dark under a storm sky and at night. A
				// lightning flash multiplies the sky fill several times over; on foam alone that turns the
				// sea into white confetti, so the foam follows the flash only by its square root.
				const fill = max( shared.skyFill, 1 );
				const wrap = max( dot( N, L ), 0 ).mul( 0.75 ).add( 0.25 );
				const lit = shared.skyIrradianceSource.div( fill.sqrt() ).add( sunLight.mul( wrap ).div( PI ) ).mul( storm.albedo );
				col.assign( mix( col, lit, foam ) );

			} );

			// soften the line where the surface cuts the rock (no hard seam); behind rock: the rock
			const edge = select( skyBehind, float( 1 ), smoothstep( 0, 0.06, thick ) ).toVar();
			If( edge.lessThan( 1 ), () => {

				col.assign( mix( sceneAt( screenUV ), col, edge ) );

			} );
			return vec4( min( col, vec3( 16000 ) ), reactive ?? 1 );

		} )();
		// the scene target's other outputs (Motion.ts `outputStruct`): under the temporal modes the
		// velocity, the camera's motion and the waves' (their previous position, above), and the
		// glints' reactive weight (the shading's alpha under the temporal modes); the metering
		// illuminance of the surface (above)
		const shade = material.fragmentNode as V4;
		material.fragmentNode = outputStruct( vec4( shade.xyz, 1 ), motionNode( 'water', shade.w ), meter );
		material.userData.motion = 'animated';
		material.side = THREE.DoubleSide;
		return material;

	}

	// per frame, before the water draw
	prepare( sun: THREE.DirectionalLight ): void {

		// the temporal modes' step of the clock, once per rendered frame (after Motion.ts began it)
		if ( TEMPORAL && this.clock.frame !== motionState.frame ) {

			const time = this.inputs.shared.time.value, step = time - this.clock.time;
			const continuous = this.clock.frame === motionState.frame - 1 && ! motionState.cut && step >= 0 && step <= MAX_MOTION_STEP;
			this.step.value = continuous ? step : 0;
			this.shoreHistory.value = this.step.value > 0 ? 1 : 0;
			this.ownMotion.value = debugFlags.mv.sea === false ? 0 : 1;
			this.clock.frame = motionState.frame;
			this.clock.time = time;

		}
		this.reflectorMin.value.copy( this.reflectionBounds.min );
		this.reflectorMax.value.copy( this.reflectionBounds.max );
		// debugFlags.ssrCull / ssrClip = false bring back the march without the box, and refraction =
		// false the opaque copy as the only refraction source (with the refraction pass skipped:
		// Pipeline.ts), for A/B timing in one page (each variant is its own material and pipeline,
		// built on first use).
		const variant = { cull: debugFlags.ssrCull !== false, clip: debugFlags.ssrClip !== false, refraction: debugFlags.refraction !== false };
		const key = variantKey( variant );
		let material = this.materials.get( key );
		if ( ! material ) this.materials.set( key, material = this.buildMaterial( variant ) );
		if ( this.mesh.material !== material ) this.mesh.material = this.material = material;
		// Debug builds check once that the box holds what the scene lit by the key light draws
		// above the sea (the islanders walk, so their measure is only the first frame's).
		if ( DEBUG && ! this.boundsChecked && sun.parent ) {

			this.boundsChecked = true;
			this.checkReflectionBounds( sun.parent );

		}

	}

	/** The reflection's box for the land's box `b` (WorldShapes.landBounds): again when the land
	 * grows (Growth.ts), which grows it; whatever was held beyond it (a placed prop: the caller
	 * holds it again, `hold`) is dropped. Debug builds measure the scene against it once, at the load:
	 * not after a growth step, whose frame it would take tens of milliseconds (it reads every
	 * vertex); a page loaded on the grown land measures that land. */
	setLand( b: Bounds ): void {

		this.inputs.detail.setLand( b );
		this.reflectionBounds.set(
			new THREE.Vector3( b.x0 - REFLECTOR_REACH, this.reflectionFloor, b.z0 - REFLECTOR_REACH ),
			new THREE.Vector3( b.x1 + REFLECTOR_REACH, this.inputs.reflectorTop + REFLECTOR_HEIGHT, b.z1 + REFLECTOR_REACH ) );

	}

	/** Grows the reflection's box to hold `box` (a placed prop, the plants' crowns) above the box's
	 * floor: the part below it is left out, since hits there weigh nothing (REFLECTION_FLOOR). */
	hold( box: THREE.Box3 ): void {

		const floor = this.reflectionFloor;
		if ( box.isEmpty() || box.max.y <= floor ) return;
		const held = box.clone();
		held.min.y = Math.max( held.min.y, floor );
		this.reflectionBounds.union( held );

	}

	// the reflection box's floor: REFLECTION_FLOOR under the sea level, whatever is held
	private get reflectionFloor(): number {

		return this.inputs.shared.waterLevel.value - REFLECTION_FLOOR;

	}

	// The measured box of every opaque surface under root above the reflection's floor (the fixed
	// one, REFLECTION_FLOOR under the sea), against reflectionBounds; warns about any that pokes out
	// (its reflection would be lost). Debug only: it reads every vertex once.
	checkReflectionBounds( root: THREE.Object3D ): THREE.Box3 {

		const floor = this.reflectionFloor;
		const measured = new THREE.Box3(), part = new THREE.Box3(), v = new THREE.Vector3();
		const outside: string[] = [];
		const skip = new Set<THREE.Object3D>();
		this.inputs.sky.dome.traverse( ( o ) => skip.add( o ) );
		this.inputs.sky.lightning.group.traverse( ( o ) => skip.add( o ) );
		root.updateWorldMatrix( true, true );
		// Only what is drawn: a hidden group's children are skipped with it, and a mesh off the
		// view's layer (a caster only the sun's map draws).
		root.traverseVisible( ( object ) => {

			const mesh = object as THREE.Mesh;
			if ( ! mesh.isMesh || skip.has( mesh ) || ! mesh.layers.isEnabled( 0 ) ) return;
			const materials = Array.isArray( mesh.material ) ? mesh.material : [ mesh.material ];
			if ( materials.every( ( m ) => m.transparent || ! m.depthWrite ) ) return;
			part.makeEmpty();
			if ( ( mesh as THREE.InstancedMesh ).isInstancedMesh || ( mesh as THREE.SkinnedMesh ).isSkinnedMesh ) {

				const posed = mesh as THREE.InstancedMesh | THREE.SkinnedMesh;
				posed.computeBoundingBox();
				part.copy( posed.boundingBox! ).applyMatrix4( mesh.matrixWorld );
				if ( part.max.y <= floor ) return;
				part.min.y = Math.max( part.min.y, floor );

			} else {

				const position = mesh.geometry.getAttribute( 'position' );
				if ( ! position ) return;
				for ( let i = 0; i < position.count; i ++ ) {

					v.fromBufferAttribute( position, i ).applyMatrix4( mesh.matrixWorld );
					if ( v.y > floor ) part.expandByPoint( v );

				}

			}
			if ( part.isEmpty() ) return;
			measured.union( part );
			if ( ! this.reflectionBounds.containsBox( part ) ) outside.push( mesh.name || mesh.type );

		} );
		if ( outside.length ) console.warn( 'Water: opaque surfaces above the sea lie outside reflectionBounds, so the sea will not reflect all of them:', outside, measured, this.reflectionBounds );
		return measured;

	}

}
