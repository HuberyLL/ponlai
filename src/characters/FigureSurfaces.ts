import * as THREE from 'three/webgpu';
import { attribute, clamp, diffuseColor, dot, float, mix, normalView, positionViewDirection, pow, texture, uniform, vec4, vertexColor } from 'three/tsl';
import { ALPHA_TO_COVERAGE, TEMPORAL } from '../post/Antialiasing.ts';
import { GroundBounceLightingModel } from '../lighting/GroundBounce.ts';
import { meterKey, writeMeter } from '../lighting/MeterLight.ts';
import type { AmbientReceiver } from '../lighting/AmbientSample.ts';
import { useLeafCoverage } from '../world/vegetation/Coverage.ts';
import { addSkinnedMotion, KIND } from './CharacterMaterial.ts';

type V3 = THREE.Node<'vec3'>;
type Reflected = { directDiffuse: V3 };

// The surfaces of the feather-robed islanders (looks.ts HANMING), lit as the rest of the island
// is (three's physical model with the ground's bounce), not in the kit figures' painted cel steps:
// - the body's painted parts (head, body, legs, sandals, the shell under the feathers):
//   vertex colours as linear albedo, rough cloth, skin and leather a little smoother;
// - the feathers: cards cut from a photograph of a white feather (alpha to coverage under 4x, a
//   plain cut-out otherwise, the leaves' coverage band under the temporal modes), lit through as
//   thin vanes are: wrapped light on the shade side and a glow against the sun;
// - the hats' woven bamboo: a wicker texture tinted to the straw of a bamboo hat, its ribs, rings
//   and bound rim (geometry a little proud of the weave) darker through the vertex colours.
// Each figure part casts into the figures' shadow map but the feathers (their cards would cast
// whole rectangles; the shell under them casts the figure's shape), and every part receives that
// map, so a hat's brim shades the face and shoulders under it. Every part reads the ambient volume
// at degree 2 under the receiver name the kit figures' model uses too, `figures`
// (lighting/AmbientSample.ts), so `flags=ambientVolumeOff:figures` sends both looks back to the
// environment's light.

export const figureLook = {
	// the feathers' white (a multiplier on the photograph, linear): a white feather's albedo, kept
	// under the clipping of the sunlit side
	featherTint: uniform( new THREE.Vector3( 0.76, 0.75, 0.73 ) ),
	// light passed through the vanes, as a share of the sun's
	featherTransmission: uniform( 0.6 ),
	// the wicker texture's mean is a reddish brown; bamboo straw is paler and yellower
	weaveTint: uniform( new THREE.Vector3( 1.75, 1.85, 1.2 ) ),
};

// how every part reads the ambient volume (lighting/AmbientSample.ts)
const FIGURE_AMBIENT: AmbientReceiver = { bands: 2, kind: 'figures' };

/** The painted body (vertex colours, `shade` kind per vertex) in the island's light. */
export function makeLitFigureMaterial(): THREE.MeshStandardNodeMaterial {

	const mat = new THREE.MeshStandardNodeMaterial( { roughness: 0.88, metalness: 0 } );
	mat.name = 'figure';
	const kind = attribute<'vec4'>( 'shade', 'vec4' ).x;
	const skin = float( 1 ).sub( clamp( kind.sub( KIND.skin ).abs(), 0, 1 ) );
	const leather = float( 1 ).sub( clamp( kind.sub( KIND.leather ).abs(), 0, 1 ) );
	mat.colorNode = vertexColor().rgb;
	mat.roughnessNode = mix( mix( float( 0.88 ), float( 0.55 ), skin ), float( 0.62 ), leather );
	( mat as unknown as { setupLightingModel: () => THREE.LightingModel } ).setupLightingModel = () => new GroundBounceLightingModel( FIGURE_AMBIENT );
	writeMeter( mat );
	if ( TEMPORAL ) addSkinnedMotion( mat );
	return mat;

}

// thin vanes pass the light: wrapped round to the shade side, and a glow looking into the sun
class FeatherLighting extends GroundBounceLightingModel {

	direct( input: THREE.LightingModelDirectInput, builder?: THREE.NodeBuilder ): void {

		( super.direct as ( i: THREE.LightingModelDirectInput, b?: THREE.NodeBuilder ) => void )( input, builder );
		// along the key's shading direction, as the physical direct term (lighting/KeyLift.ts)
		const L = this.shadeDirection( input.lightDirection as V3 ), V = positionViewDirection, N = normalView;
		const wrap = clamp( dot( N, L ).mul( 0.5 ).add( 0.5 ), 0, 1 );
		const back = pow( clamp( dot( V.negate(), L ), 0, 1 ), 3 );
		const through = wrap.mul( wrap ).mul( 0.25 ).add( back.mul( 0.6 ) ).mul( figureLook.featherTransmission );
		( input.reflectedLight as unknown as Reflected ).directDiffuse.addAssign( ( input.lightColor as V3 ).mul( diffuseColor.rgb ).mul( through ).mul( 1 / Math.PI ) );
		// the light through in the metering illuminance (lighting/MeterLight.ts)
		meterKey.addAssign( ( input.lightColor as V3 ).mul( through ) );

	}

}

/** The feather cards: `map` is the atlas of feather photographs (alpha in its alpha channel). */
export function makeFeatherMaterial( map: THREE.Texture ): THREE.MeshStandardNodeMaterial {

	const alphaTest = 0.2;
	const mat = new THREE.MeshStandardNodeMaterial( { map, alphaTest, alphaToCoverage: ALPHA_TO_COVERAGE, side: THREE.DoubleSide, roughness: 0.62, metalness: 0 } );
	mat.name = 'feathers';
	// the cut-out reads the photograph's alpha (a colour node without it would draw whole cards);
	// each card's vertex colour darkens its root end, under the row above, and sets it a little
	// apart from its neighbours
	const photo = texture( map );
	mat.colorNode = vec4( photo.rgb.mul( figureLook.featherTint ).mul( vertexColor().rgb ), photo.a );
	( mat as unknown as { setupLightingModel: () => THREE.LightingModel } ).setupLightingModel = () => new FeatherLighting( FIGURE_AMBIENT );
	writeMeter( mat );
	useLeafCoverage( mat, alphaTest );
	if ( TEMPORAL ) addSkinnedMotion( mat );
	return mat;

}

/** The hats' woven bamboo from the part's glTF material (its colour, normal and roughness maps),
 * its colour tinted to straw. */
export function makeWeaveMaterial( source: THREE.MeshStandardMaterial ): THREE.MeshStandardNodeMaterial {

	const mat = new THREE.MeshStandardNodeMaterial( {
		map: source.map, normalMap: source.normalMap, normalScale: source.normalScale.clone(), roughnessMap: source.roughnessMap,
		roughness: 1, metalness: 0, side: THREE.DoubleSide,
	} );
	mat.name = 'weave';
	// the vertex colours darken the ribs, rings and bound rim against the weave
	if ( source.map ) mat.colorNode = texture( source.map ).rgb.mul( figureLook.weaveTint ).mul( vertexColor().rgb );
	( mat as unknown as { setupLightingModel: () => THREE.LightingModel } ).setupLightingModel = () => new GroundBounceLightingModel( FIGURE_AMBIENT );
	writeMeter( mat );
	if ( TEMPORAL ) addSkinnedMotion( mat );
	return mat;

}
