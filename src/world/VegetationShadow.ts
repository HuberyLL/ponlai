import type * as THREE from 'three/webgpu';
import { Fn, modelWorldMatrix, varyingProperty, vec4 } from 'three/tsl';

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
export function useRestPoseShadows( material: THREE.NodeMaterial, restPosition: V3, animatedPosition: V3, castMask?: F ): V3 {

	const restWorld = varyingProperty( 'vec3', 'vVegetationShadowRestWorld' );
	// This is a material-local vertex stack, not a shared layout function: it writes a varying
	// and uses this object's matrix. Rest positions already include the instance transform.
	material.positionNode = Fn( () => {

		const rest = restPosition.toVar();
		restWorld.assign( modelWorldMatrix.mul( vec4( rest, 1 ) ).xyz );
		return animatedPosition;

	} )();
	material.castShadowPositionNode = castMask ? restPosition.mul( castMask ) : restPosition;
	material.receivedShadowPositionNode = restWorld;
	// Renderer caches shadow overrides by the source material's version.
	material.needsUpdate = true;
	return restWorld;

}
