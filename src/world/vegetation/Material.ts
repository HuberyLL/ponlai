import * as THREE from 'three/webgpu';
import { Fn, materialColor, vec4, float, mix, dot, pow, clamp } from 'three/tsl';
import { setWindDisplacement, type WindDisplacement, type WindUniforms } from '../../weather/Wind.ts';
import { showSway } from '../../debug/WindView.ts';
import { followWindMotionFlag } from '../WindMotion.ts';
import { VegetationLighting, useLighting } from '../VegetationLighting.ts';
import { previousSway, useRestPoseShadows } from '../VegetationShadow.ts';
import { ALPHA_TO_COVERAGE, coverageDither, markVegetation, useLeafCoverage } from './Coverage.ts';
import { LEAF_ALPHA_TEST, leafAlphaTexture } from './LeafTexture.ts';
import type { Shared } from '../../shared.ts';

// The vegetation's material factory: every plant kind's surface is built here by one sequence of
// calls, the one each kind used to write by hand, in the same order, so the node graphs (and the
// shaders, the pipelines and the image) are the ones the kinds built before:
//   the surface (a leaf's map, alpha map and cut-out, or a plain double-sided surface)
//   -> the vegetation tag (`markVegetation`: leaves and blades, the depth prepass and the shadow
//      filter read it) -> the leaf's coverage band under the temporal modes (`useLeafCoverage`)
//   -> wetness (a tint and a roughness toward the wet surface's)
//   -> the wind (`useVegetationMotion`: the displacement, the rest pose's shadow, the previous
//      sway for motion vectors, a kind's own vertex work before its position, the
//      `flags.mv.wind` follower, the wind view)
//   -> the normal and ambient occlusion -> the light through thin leaves (VegetationLighting).
// Families: 'leaf' (alpha-tested folded leaves: the rim bushes, the rim's trails, the plateau's
// plants), 'blade' (the meadow's blades: tagged as vegetation, no leaf map, drawn whole or not at
// all: alpha to coverage at 4x, else `coverageDither`'s threshold), 'petal' (the flowers) and
// 'sod' (the turf skirt); neither of the last two is tagged, so they take the ordinary shadow
// filter and stay out of the depth prepass. A leaf's `alphaTest: 'alphaOnly'` keeps no numeric
// cut-out, as the rim's trails had when they cloned the bushes' material (three's NodeMaterial.copy
// skips Material's alphaTest setter): the shadow passes and 4x cut them by their alpha alone.
// The game's palm takes only the wind (`useVegetationMotion`) on its prop surface.
// The meadow (Grass.ts) instances itself from the cull's storage buffers and widens its blades on
// screen (`pixelWideBlade`) inside its own displacement; the factory only takes its hooks: its own
// previous position (`previous`), its normal and instance colour (`beforePosition`) and its gloss
// (`light.sheen`).

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;

/** Light through a thin surface, beside the usual diffuse term (view space; VegetationLighting). */
export type Transmission = ( L: V3, V: V3, N: V3 ) => F | V3;

/** The folded leaf's transmission: wrapped light (leaves scatter light round to the shadow side)
 * and a glow against the sun, strongest at the leaf's grazing rim. */
export const leafTransmission: Transmission = ( L, V, N ) => {

	const back = pow( clamp( dot( V.negate(), L ), 0, 1 ), 4 );
	const rim = float( 1 ).sub( clamp( dot( N, V ), 0, 1 ) );
	const wrap = clamp( dot( N, L ).mul( 0.5 ).add( 0.5 ), 0, 1 );
	return wrap.mul( wrap ).mul( 0.13 ).add( back.mul( rim.mul( rim ).mul( 0.9 ).add( 0.1 ) ) );

};

/** Light from behind a blade or petal: the view looking into the sun, to the power `power`. */
export function backlight( L: V3, V: V3, power: number ): F {

	return pow( clamp( dot( V.negate(), L ), 0, 1 ), power );

}

/** Light scattered forward through a blade, broad: the view's angle from the sun, half-wrapped to
 * the power `power`, so it brightens the whole half of the view that faces the sun (a lawn seen
 * from above toward a high sun) and peaks looking into it, unlike `backlight`'s narrow lobe. */
export function forwardLight( L: V3, V: V3, power: number ): F {

	return pow( clamp( dot( V.negate(), L ).mul( 0.5 ).add( 0.5 ), 0, 1 ), power );

}

/** A plant's wind: its swayed pose (`displacement`, Wind.ts), the shadow cast and received in the
 * rest pose (`rest`, with `castMask` keeping parts out of the sun's map), the previous frame's sway
 * for the temporal modes' motion vectors, the `flags.mv.wind` follower (WindMotion.ts) and the
 * wind view's colour (`sway`, read once the displacement has been built). Returns the rest pose in
 * world space (useRestPoseShadows). */
export function useVegetationMotion( material: THREE.NodeMaterial, wind: WindUniforms, motion: VegetationMotion ): V3 {

	const swayed = setWindDisplacement( material, motion.displacement, wind );
	const previous = motion.previous ? motion.previous( swayed ) : previousSway( material, wind );
	const rest = useRestPoseShadows( material, motion.rest, swayed, motion.castMask, previous );
	const before = motion.beforePosition;
	if ( before ) {

		const placed = material.positionNode!;
		material.positionNode = Fn( () => {

			before();
			return placed;

		} )();

	}
	followWindMotionFlag( material );
	const sway = motion.sway?.();
	if ( sway ) showSway( material, sway, wind );
	return rest;

}

export interface VegetationMotion {
	/** The rest pose, in the space of the material's position (world space here). */
	rest: V3;
	/** The swayed pose as a function of the wind's state. */
	displacement: WindDisplacement;
	/** Per vertex, 0 keeps the vertex out of the sun's map (VegetationShadow.ts). */
	castMask?: F;
	/** The plant's sway for the wind view (src/debug/WindView.ts), once the displacement is built. */
	sway?: () => V2 | undefined;
	/** The previous frame's position for the motion vectors, from the swayed pose; default the
	 * displacement under the previous frame's wind (`previousSway`). */
	previous?: ( swayed: V3 ) => V3 | undefined;
	/** Vertex work run before the position is returned (assignments to `normalLocal`,
	 * `instanceColor`): a kind that instances itself does three's instancing there. */
	beforePosition?: () => void;
}

export interface VegetationLight {
	/** Dims all direct light: a node shared by every build, or one built per build. */
	scale: F | ( () => F );
	/** Light through the surface; a leaf's defaults to `leafTransmission`. */
	extra?: Transmission;
	/** A gloss beside the specular (VegetationLighting's `sheen`). */
	sheen?: ( L: V3, V: V3, N: V3 ) => V3;
}

export interface VegetationOptions extends VegetationMotion {
	family: 'leaf' | 'blade' | 'petal' | 'sod';
	name?: string;
	/** The dry surface's roughness. */
	roughness: number;
	/** A plain surface's vertex colours (a leaf always takes them). */
	vertexColors?: boolean;
	/** A leaf's colour map, its alpha map (default: the folded leaf's, `leafAlphaTexture`) and its
	 * cut-out (default LEAF_ALPHA_TEST). */
	leaf?: { map: THREE.Texture; alphaMap?: THREE.Texture; alphaTest?: number | 'alphaOnly' };
	/** Wetness: the colour's tint at full wetness (or the tint as a function of the wetness) and the
	 * wet surface's roughness (or the roughness as a function of the wetness). */
	wet: { tint: number | ( ( wetness: F ) => F ); roughness: number | ( ( wetness: F ) => F ) };
	/** The colour from the wet tint; default the material's colour (map and vertex colours) tinted. */
	color?: ( tint: F ) => THREE.Node<'vec3'> | THREE.Node<'vec4'>;
	normal?: V3;
	ao?: F;
	/** The direct light's scale and transmission, or a function of the rest pose (world space) that
	 * gives them. */
	light: VegetationLight | ( ( rest: V3 ) => VegetationLight );
}

/** A plant kind's material, built by the factory's one sequence of calls (see the header). */
export function vegetationMaterial( shared: Shared, options: VegetationOptions ): THREE.MeshStandardNodeMaterial {

	const { leaf } = options;
	let mat: THREE.MeshStandardNodeMaterial;
	if ( leaf ) {

		const alphaTest = leaf.alphaTest === 'alphaOnly' ? 0 : leaf.alphaTest ?? LEAF_ALPHA_TEST;
		mat = new THREE.MeshStandardNodeMaterial( {
			map: leaf.map, alphaTest, alphaToCoverage: ALPHA_TO_COVERAGE, side: THREE.DoubleSide, roughness: options.roughness, metalness: 0, vertexColors: true,
		} );
		mat.alphaMap = leaf.alphaMap ?? leafAlphaTexture( ( leaf.map.image as { width: number } ).width );

	} else {

		const blade = options.family === 'blade';
		mat = new THREE.MeshStandardNodeMaterial( { vertexColors: options.vertexColors ?? false, side: THREE.DoubleSide, roughness: options.roughness, metalness: 0, alphaToCoverage: blade && ALPHA_TO_COVERAGE } );
		if ( blade && ! ALPHA_TO_COVERAGE ) mat.alphaTestNode = coverageDither();

	}
	if ( options.family === 'leaf' || options.family === 'blade' ) markVegetation( mat );
	if ( leaf ) useLeafCoverage( mat );
	const wetness = clamp( shared.wetness, 0, 1 );
	const { tint, roughness } = options.wet;
	const wetTint = typeof tint === 'number' ? mix( 1, tint, wetness ) : tint( wetness );
	// materialColor retains the leaf map and its alpha; three applies vertex and instance colours
	// afterward. Wetness must not darken the cutout silhouette itself.
	mat.colorNode = options.color ? options.color( wetTint ) : materialColor.mul( vec4( wetTint, wetTint, wetTint, 1 ) );
	mat.roughnessNode = typeof roughness === 'number' ? mix( options.roughness, roughness, wetness ) : roughness( wetness );
	const rest = useVegetationMotion( mat, shared.wind, options );
	if ( options.normal ) mat.normalNode = options.normal;
	if ( options.ao ) mat.aoNode = options.ao;
	const light = typeof options.light === 'function' ? options.light( rest ) : options.light;
	const extra = light.extra ?? leafTransmission;
	const scale = light.scale;
	useLighting( mat, () => new VegetationLighting( typeof scale === 'function' ? scale() : scale, extra, light.sheen ) );
	if ( options.name ) mat.name = options.name;
	return mat;

}
