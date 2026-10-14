import type * as THREE from 'three/webgpu';
import { Fn, modelWorldMatrix, positionPrevious, varyingProperty, vec4 } from 'three/tsl';
import { TEMPORAL } from '../post/Antialiasing.ts';
import { motionNode, velocityOutput } from '../post/Motion.ts';
import { windDisplacement, type WindUniforms } from '../weather/Wind.ts';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

// Thin leaves move across individual shadow texels. Cast their rest silhouette and receive
// its shadow in the same pose, while the visible surface keeps its original wind animation.
// Returns the rest pose in world space for any other light term that must stay as still.
// castMask (per vertex, 0 or 1) keeps parts out of the shadow map: stems and stalks are a few
// millimetres across, well under a texel, so the map could only show them as dashes that come
// and go with each redraw; the sun's own disk would blur such a thin shadow away within a few
// decimetres anyway. A masked vertex collapses to the origin, so its triangles have no area;
// keep the mask the same on all three corners (one flag per part), or the triangle stretches.
//
// Motion vectors (the temporal modes, src/post/Motion.ts): `previousPosition` is where the
// animated vertex was in the rendered frame before, in the same space (the wind's sway evaluated
// with `shared.wind.previous`, `previousSway`). The shaded draw assigns it to three's
// `positionPrevious` in its position stage, after the rest inputs are read and before three moves
// `positionLocal` to the swayed pose, and writes its velocity as class vegetation. Only the
// material itself does: the vegetation prepass's depth copies share this position node but write
// no motion (VegetationPrepass.ts), the shadow passes draw the rest pose, and a draw without a
// velocity target needs no previous data, so none of them evaluates the sway twice. Without the
// temporal modes nothing is built for it (MSAA's shaders are unchanged).
// `flags.mv.wind = false` (WindMotion.ts sets `userData.windMotion = false`) builds the material
// with the current pose as the previous one: no wind motion and no second sway, the A/B of its
// cost and the MV-UNIT check's "source off".
export function useRestPoseShadows( material: THREE.NodeMaterial, restPosition: V3, animatedPosition: V3, castMask?: F, previousPosition?: V3 ): V3 {

	const restWorld = varyingProperty( 'vec3', 'vVegetationShadowRestWorld' );
	const previous = TEMPORAL ? previousPosition : undefined;
	// This is a material-local vertex stack, not a shared layout function: it writes a varying
	// and uses this object's matrix. Rest positions already include the instance transform.
	material.positionNode = Fn( ( builder: THREE.NodeBuilder ) => {

		const rest = restPosition.toVar();
		restWorld.assign( modelWorldMatrix.mul( vec4( rest, 1 ) ).xyz );
		const b = builder as unknown as { material: THREE.Material | null; needsPreviousData(): boolean };
		if ( previous && b.material === material && b.needsPreviousData() ) {

			positionPrevious.assign( material.userData.windMotion === false ? animatedPosition : previous );

		}
		return animatedPosition;

	} )();
	material.castShadowPositionNode = castMask ? restPosition.mul( castMask ) : restPosition;
	material.receivedShadowPositionNode = restWorld;
	if ( previous ) {

		material.userData.motion = 'animated';
		material.userData.previousPosition = true;
		material.mrtNode = velocityOutput( motionNode( 'vegetation' ) );
		// three's cache key leaves out userData: the build without the wind's motion needs its own
		const key = material.customProgramCacheKey;
		material.customProgramCacheKey = function ( this: THREE.NodeMaterial ) {

			return key.call( this ) + ( this.userData.windMotion === false ? '|windStill' : '' );

		};

	} else delete material.userData.previousPosition; // (a clone of a material that had one)
	// Renderer caches shadow overrides by the source material's version.
	material.needsUpdate = true;
	return restWorld;

}

/** Under the temporal modes, the material's registered wind displacement (`setWindDisplacement`)
 * evaluated with the previous rendered frame's wind: the `previousPosition` of
 * `useRestPoseShadows`. Undefined otherwise, or for a material without one (the old sway). */
export function previousSway( material: THREE.Material, wind: WindUniforms ): V3 | undefined {

	const displacement = windDisplacement( material );
	return TEMPORAL && displacement ? displacement( wind.previous ) : undefined;

}
